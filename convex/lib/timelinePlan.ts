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
 * Validate a timeline plan (timeline.json).
 * Fail fast on malformed plans instead of shipping a broken composition:
 * - valid JSON object
 * - non-empty segments[] with numeric times
 * - every segment file exists in the sandbox media directory (when the
 *   caller supplies the actual directory listing)
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
  return { ok: true, plan };
}
