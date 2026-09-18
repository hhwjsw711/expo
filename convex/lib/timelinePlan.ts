// Shared pure validator for timeline.json plans.
// Used by BOTH render paths:
//   - Branch A: the plan produced by the Claude agent (plan-only mode)
//   - Branch B: the user-edited timeline saved by the video editor
// Kept dependency-free (no Convex imports) so it can be unit-tested
// directly with `bun test`.

export type TimelinePlanValidation =
  | { ok: true; plan: any }
  | { ok: false; error: string };

/**
 * True for a filename that is safe to interpolate into generated code:
 * no path separators, quotes, backslashes, or control characters.
 */
function isSafeFilename(name: any): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !/[/\\'"`\n\r\t]/.test(name)
  );
}

/**
 * Validate a media file reference that generate-composition.ts interpolates
 * (UNESCAPED) into double-quoted string literals in the generated TSX
 * (audio.voiceFile / audio.musicFile / subtitles.file). Anything but a plain
 * existing filename is a code-injection vector: escaping the string literal
 * injects arbitrary TSX that executes at render time — inside the sandbox,
 * where ANTHROPIC_API_KEY lives in the environment.
 */
function validateMediaRef(
  label: string,
  value: any,
  availableFiles?: string[]
): string | null {
  if (value === undefined || value === null) return null; // omitted -> generator default
  if (!isSafeFilename(value)) {
    return `${label} is not a plain filename: ${JSON.stringify(value).slice(0, 60)}`;
  }
  if (availableFiles && availableFiles.length > 0 && !availableFiles.includes(value)) {
    return `${label} "${value}" not found in public/media (available: ${availableFiles.join(", ")})`;
  }
  return null;
}

/**
 * Validate a timeline plan (timeline.json).
 * Fail fast on malformed plans instead of shipping a broken composition:
 * - valid JSON object
 * - non-empty segments[] with numeric times
 * - every segment file exists in the sandbox media directory (when the
 *   caller supplies the actual directory listing)
 * - audio/subtitle file references are plain existing filenames (they are
 *   interpolated unescaped into the generated TSX — injection guard)
 * - fps / durationInFrames are positive numbers (interpolated raw)
 * - summed segment durations match the declared durationInSeconds within
 *   a small tolerance (playbackRate only speeds up the voice track and
 *   does NOT change on-screen segment time, so no adjustment is applied)
 */
export function validateTimelinePlan(
  raw: string,
  availableFiles?: string[]
): TimelinePlanValidation {
  if (!raw || raw.trim().length === 0) return { ok: false, error: "empty plan" };
  let plan: any;
  try {
    plan = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  if (!plan || typeof plan !== "object") return { ok: false, error: "not an object" };
  if (!Array.isArray(plan.segments) || plan.segments.length === 0) {
    return { ok: false, error: "segments[] is empty" };
  }
  // Segments play back-to-back and fill the whole composition, so their sum
  // must match the declared duration. playbackRate only affects how fast the
  // voiceover audio plays (audio ends early if > 1), not the screen time.
  const totalDuration = plan.segments.reduce(
    (sum: number, seg: any) => sum + (Number(seg?.duration) || 0),
    0
  );
  const declared = Number(plan?.durationInSeconds) || 0;
  if (declared > 0 && Math.abs(totalDuration - declared) > 0.75) {
    return {
      ok: false,
      error: `segment durations (${totalDuration.toFixed(2)}s) != declared ${declared.toFixed(2)}s`,
    };
  }
  for (const seg of plan.segments) {
    if (!seg?.file || typeof seg.file !== "string" || seg.file.includes("/")) {
      return { ok: false, error: "segment is missing a plain 'file' name" };
    }
    // Cross-check against the real sandbox directory: referencing a file
    // that was never downloaded would render a black screen.
    if (availableFiles && availableFiles.length > 0 && !availableFiles.includes(seg.file)) {
      return {
        ok: false,
        error: `segment file "${seg.file}" not found in public/media (available: ${availableFiles.join(", ")})`,
      };
    }
    if (!Number.isFinite(Number(seg.startFrom)) || !Number.isFinite(Number(seg.duration))) {
      return { ok: false, error: `segment ${seg.file} has non-numeric startFrom/duration` };
    }
    if (Number(seg.duration) <= 0 || Number(seg.duration) > 10) {
      return { ok: false, error: `segment ${seg.file} duration ${seg.duration}s out of range (0, 10]` };
    }
  }

  // Audio/subtitle file references are interpolated UNESCAPED into the
  // generated TSX (generate-composition.ts) — validate them like segments
  // to prevent code injection that exfiltrates ANTHROPIC_API_KEY.
  // The availableFiles check applies only to *enabled* tracks: a disabled
  // voice/music/caption path isn't rendered, so a missing file there is
  // harmless (and may legitimately be absent when the user turned it off).
  const audio = plan.audio;
  if (audio && typeof audio === "object") {
    if (audio.includeVoice !== false) {
      const e = validateMediaRef("audio.voiceFile", audio.voiceFile, availableFiles);
      if (e) return { ok: false, error: e };
    }
    if (audio.includeMusic !== false) {
      const e = validateMediaRef("audio.musicFile", audio.musicFile, availableFiles);
      if (e) return { ok: false, error: e };
    }
  }
  const subs = plan.subtitles;
  if (subs && typeof subs === "object" && subs.includeCaptions !== false) {
    const e = validateMediaRef("subtitles.file", subs.file, availableFiles);
    if (e) return { ok: false, error: e };
  }

  // Numeric fields are interpolated raw into generated code; non-numbers
  // would crash the generator (num → toFixed on NaN throws).
  if (!Number.isFinite(Number(plan.fps)) || Number(plan.fps) <= 0) {
    return { ok: false, error: "fps must be a positive number" };
  }
  if (!Number.isFinite(Number(plan.durationInFrames)) || Number(plan.durationInFrames) <= 0) {
    return { ok: false, error: "durationInFrames must be a positive number" };
  }
  return { ok: true, plan };
}

/**
 * Optimistic-lock check for timeline saves.
 * `currentRevision` is the project's stored revision counter (missing = 0,
 * i.e. pre-migration projects); `baseRevision` is the revision the client
 * LOADED its timeline from. They must match, otherwise a concurrent writer
 * saved in between and the stale write must be rejected.
 */
export function resolveTimelineRevision(
  currentRevision: number | undefined,
  baseRevision: number
): { ok: true; nextRevision: number } | { ok: false; conflict: true; currentRevision: number } {
  const current = currentRevision ?? 0;
  if (!Number.isFinite(baseRevision) || baseRevision !== current) {
    return { ok: false, conflict: true, currentRevision: current };
  }
  return { ok: true, nextRevision: current + 1 };
}
