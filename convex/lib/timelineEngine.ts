// Timeline operation engine — pure functions, zero dependencies.
//
// The single source of truth for how a timeline document mutates. Every
// editor action in batch 2b goes through applyOperation(); the returned
// inverse ops power the undo/rollback history (batch 3a) and the operation
// itself is the audit record (batch 3b edit manifest).
//
// Invariants maintained by every operation:
//   1. segments[] is never empty
//   2. every segment duration ∈ [MIN_SEGMENT_DURATION, MAX_SEGMENT_DURATION]
//      and every file is a plain name (no path separators)
//   3. durationInSeconds / durationInFrames are ALWAYS recomputed from the
//      segments sum — the composition is a pure projection of the timeline,
//      so the two can never drift apart (the alignment check in
//      timelinePlan.ts therefore always passes on engine output)
//   4. inputs are never mutated

// ─── Document types (mirror timeline.json) ────────────────────────────────

export interface EngineSegment {
  file: string;
  startFrom: number;
  duration: number;
  comment?: string;
}

export interface EngineAudio {
  voiceFile?: string;
  voiceVolume?: number;
  playbackRate?: number;
  musicFile?: string;
  musicVolume?: number;
  originalSoundVolume?: number;
  includeMusic?: boolean;
  includeVoice?: boolean;
  includeOriginalSound?: boolean;
}

export interface EngineSubtitles {
  file?: string;
  adjustForPlaybackRate?: boolean;
  includeCaptions?: boolean;
}

export interface TimelineDoc {
  fps: number;
  durationInFrames: number;
  durationInSeconds: number;
  segments: EngineSegment[];
  audio?: EngineAudio;
  subtitles?: EngineSubtitles;
}

// ─── Bounds (kept in sync with the editor UI and timelinePlan.ts) ─────────

/** Same value as video-editor's MIN_CLIP_DURATION. */
export const MIN_SEGMENT_DURATION = 0.3;
/** Same ceiling as validateTimelinePlan; sources are 5–10s Kling clips. */
export const MAX_SEGMENT_DURATION = 10;

// ─── Operations ───────────────────────────────────────────────────────────

export type TimelineOperation =
  /** Set a segment's source offset and/or screen duration. Pass
   *  sourceDuration to clamp startFrom + duration to the source clip. */
  | { type: "trimSegment"; index: number; startFrom?: number; duration?: number; sourceDuration?: number }
  /** Reorder: take the segment at `from`, insert it at `to`. */
  | { type: "moveSegment"; from: number; to: number }
  /** Split one segment at an interior offset `at` seconds into two. */
  | { type: "splitSegment"; index: number; at: number; sourceDuration?: number }
  /** Delete a segment (refuses if it is the last one). */
  | { type: "removeSegment"; index: number }
  /** Insert a new segment at `index` (0..length, end allowed). */
  | { type: "insertSegment"; index: number; segment: EngineSegment; sourceDuration?: number }
  /** Swap the source clip of a segment (optionally re-seek it). */
  | { type: "replaceSegmentFile"; index: number; file: string; startFrom?: number; sourceDuration?: number }
  /** Patch audio settings (volume/toggles/playbackRate). Only listed keys change. */
  | { type: "adjustAudio"; patch: Partial<EngineAudio> }
  /** Patch subtitle settings. */
  | { type: "adjustSubtitles"; patch: Partial<EngineSubtitles> };

export type ApplyResult =
  | { ok: true; timeline: TimelineDoc; inverse: TimelineOperation[] }
  | { ok: false; error: string };

// ─── Helpers ─────────────────────────────────────────────────────────────

function cloneDoc(doc: TimelineDoc): TimelineDoc {
  return {
    ...doc,
    segments: doc.segments.map(s => ({ ...s })),
    audio: doc.audio ? { ...doc.audio } : undefined,
    subtitles: doc.subtitles ? { ...doc.subtitles } : undefined,
  };
}

/** Recompute the declared duration fields from the segments sum. */
function recalcDuration(doc: TimelineDoc): void {
  const total = doc.segments.reduce((sum, s) => sum + s.duration, 0);
  doc.durationInSeconds = parseFloat(total.toFixed(4));
  doc.durationInFrames = Math.round(total * (doc.fps || 30));
}

function segDurationOk(d: number): boolean {
  return Number.isFinite(d) && d >= MIN_SEGMENT_DURATION && d <= MAX_SEGMENT_DURATION;
}

function plainFileName(file: unknown): boolean {
  return typeof file === "string" && file.length > 0 && !file.includes("/");
}

/** Validate a segment value set against engine bounds. */
function checkSegmentBounds(
  file: unknown,
  startFrom: unknown,
  duration: number,
  sourceDuration: number | undefined
): string | null {
  if (!plainFileName(file)) return "segment file must be a plain name";
  if (!Number.isFinite(Number(startFrom)) || Number(startFrom) < 0) {
    return "startFrom must be a finite number >= 0";
  }
  if (!segDurationOk(duration)) {
    return `duration ${duration}s out of range [${MIN_SEGMENT_DURATION}, ${MAX_SEGMENT_DURATION}]`;
  }
  if (sourceDuration !== undefined
    && Number.isFinite(sourceDuration)
    && Number(startFrom) + duration > sourceDuration + 0.001) {
    return `startFrom + duration (${Number(startFrom) + duration}s) exceeds source duration (${sourceDuration}s)`;
  }
  return null;
}

// ─── Engine ───────────────────────────────────────────────────────────────

/**
 * Apply one operation to a timeline document.
 * Returns the new timeline plus the inverse operations that would restore
 * the previous document (see invert semantics per op below). On any
 * invariant violation the original document is left untouched and an
 * error is returned — operations are all-or-nothing.
 */
export function applyOperation(doc: TimelineDoc, op: TimelineOperation): ApplyResult {
  if (!doc || !Array.isArray(doc.segments) || doc.segments.length === 0) {
    return { ok: false, error: "timeline has no segments" };
  }
  const next = cloneDoc(doc);
  const segs = next.segments;
  const len = segs.length;

  switch (op.type) {
    case "trimSegment": {
      if (!Number.isInteger(op.index) || op.index < 0 || op.index >= len) {
        return { ok: false, error: `trimSegment index ${op.index} out of range` };
      }
      const seg = segs[op.index];
      const newStart = op.startFrom !== undefined ? Number(op.startFrom) : seg.startFrom;
      const newDuration = op.duration !== undefined ? Number(op.duration) : seg.duration;
      const boundsErr = checkSegmentBounds(seg.file, newStart, newDuration, op.sourceDuration);
      if (boundsErr) return { ok: false, error: `segment ${op.index}: ${boundsErr}` };
      segs[op.index] = { ...seg, startFrom: newStart, duration: newDuration };
      recalcDuration(next);
      return {
        ok: true,
        timeline: next,
        inverse: [{
          type: "trimSegment",
          index: op.index,
          startFrom: seg.startFrom,
          duration: seg.duration,
          ...(op.sourceDuration !== undefined ? { sourceDuration: op.sourceDuration } : {}),
        }],
      };
    }

    case "moveSegment": {
      const { from, to } = op;
      if (!Number.isInteger(from) || from < 0 || from >= len) {
        return { ok: false, error: `moveSegment from ${from} out of range` };
      }
      if (!Number.isInteger(to) || to < 0 || to >= len) {
        return { ok: false, error: `moveSegment to ${to} out of range` };
      }
      if (from === to) {
        return { ok: true, timeline: next, inverse: [] };
      }
      const [moved] = segs.splice(from, 1);
      segs.splice(to, 0, moved);
      return { ok: true, timeline: next, inverse: [{ type: "moveSegment", from: to, to: from }] };
    }

    case "splitSegment": {
      if (!Number.isInteger(op.index) || op.index < 0 || op.index >= len) {
        return { ok: false, error: `splitSegment index ${op.index} out of range` };
      }
      const seg = segs[op.index];
      const at = Number(op.at);
      // Both halves must satisfy the duration floor; splitting at an edge
      // would create a zero-length fragment.
      if (!Number.isFinite(at) || at <= MIN_SEGMENT_DURATION || at >= seg.duration - MIN_SEGMENT_DURATION) {
        return {
          ok: false,
          error: `split at ${at}s must lie strictly inside (${MIN_SEGMENT_DURATION}, ${seg.duration - MIN_SEGMENT_DURATION})`,
        };
      }
      const boundsErr = checkSegmentBounds(seg.file, seg.startFrom + at, seg.duration - at, op.sourceDuration);
      if (boundsErr) return { ok: false, error: `segment ${op.index} second half: ${boundsErr}` };
      segs.splice(op.index, 1,
        { ...seg, duration: at },
        { ...seg, startFrom: seg.startFrom + at, duration: seg.duration - at, comment: seg.comment ? `${seg.comment} (part 2)` : undefined }
      );
      // Split preserves the total: durationInSeconds/durationInFrames are
      // unchanged, but recompute anyway to keep the invariant mechanical.
      recalcDuration(next);
      return {
        ok: true,
        timeline: next,
        inverse: [
          { type: "removeSegment", index: op.index + 1 },
          { type: "trimSegment", index: op.index, duration: seg.duration },
        ],
      };
    }

    case "removeSegment": {
      if (!Number.isInteger(op.index) || op.index < 0 || op.index >= len) {
        return { ok: false, error: `removeSegment index ${op.index} out of range` };
      }
      if (len === 1) {
        return { ok: false, error: "cannot remove the last segment" };
      }
      const [removed] = segs.splice(op.index, 1);
      recalcDuration(next);
      return {
        ok: true,
        timeline: next,
        inverse: [{ type: "insertSegment", index: op.index, segment: removed }],
      };
    }

    case "insertSegment": {
      if (!Number.isInteger(op.index) || op.index < 0 || op.index > len) {
        return { ok: false, error: `insertSegment index ${op.index} out of range (0..${len})` };
      }
      const s = op.segment;
      const startFrom = s.startFrom !== undefined ? Number(s.startFrom) : 0;
      const duration = Number(s.duration);
      const boundsErr = checkSegmentBounds(s.file, startFrom, duration, op.sourceDuration);
      if (boundsErr) return { ok: false, error: `insertSegment: ${boundsErr}` };
      segs.splice(op.index, 0, {
        file: s.file,
        startFrom,
        duration,
        ...(s.comment !== undefined ? { comment: s.comment } : {}),
      });
      recalcDuration(next);
      return {
        ok: true,
        timeline: next,
        inverse: [{ type: "removeSegment", index: op.index }],
      };
    }

    case "replaceSegmentFile": {
      if (!Number.isInteger(op.index) || op.index < 0 || op.index >= len) {
        return { ok: false, error: `replaceSegmentFile index ${op.index} out of range` };
      }
      const seg = segs[op.index];
      const newStart = op.startFrom !== undefined ? Number(op.startFrom) : seg.startFrom;
      const boundsErr = checkSegmentBounds(op.file, newStart, seg.duration, op.sourceDuration);
      if (boundsErr) return { ok: false, error: `segment ${op.index}: ${boundsErr}` };
      segs[op.index] = { ...seg, file: op.file, startFrom: newStart };
      return {
        ok: true,
        timeline: next,
        inverse: [{
          type: "replaceSegmentFile",
          index: op.index,
          file: seg.file,
          startFrom: seg.startFrom,
        }],
      };
    }

    case "adjustAudio": {
      if (!op.patch || typeof op.patch !== "object") {
        return { ok: false, error: "adjustAudio requires a patch object" };
      }
      const old: Partial<EngineAudio> = {};
      const base: EngineAudio = next.audio ?? {};
      for (const key of Object.keys(op.patch) as Array<keyof EngineAudio>) {
        if (!(key in op.patch)) continue;
        (old as Record<string, unknown>)[key] = base[key];
      }
      // playbackRate must stay positive (0 would freeze the voice track).
      const pr = op.patch.playbackRate;
      if (pr !== undefined && (!Number.isFinite(Number(pr)) || Number(pr) <= 0)) {
        return { ok: false, error: "playbackRate must be a positive number" };
      }
      next.audio = { ...base, ...op.patch };
      return { ok: true, timeline: next, inverse: [{ type: "adjustAudio", patch: old }] };
    }

    case "adjustSubtitles": {
      if (!op.patch || typeof op.patch !== "object") {
        return { ok: false, error: "adjustSubtitles requires a patch object" };
      }
      const old: Partial<EngineSubtitles> = {};
      const base: EngineSubtitles = next.subtitles ?? {};
      for (const key of Object.keys(op.patch) as Array<keyof EngineSubtitles>) {
        if (!(key in op.patch)) continue;
        (old as Record<string, unknown>)[key] = base[key];
      }
      next.subtitles = { ...base, ...op.patch };
      return { ok: true, timeline: next, inverse: [{ type: "adjustSubtitles", patch: old }] };
    }

    default: {
      // Exhaustiveness guard: adding an operation type without a case fails
      // the build here.
      const never: never = op;
      return { ok: false, error: `unknown operation: ${(never as any)?.type}` };
    }
  }
}

/** Apply a sequence of operations; stops at the first failure and reports it. */
export function applyOperations(
  doc: TimelineDoc,
  ops: TimelineOperation[]
): { ok: true; timeline: TimelineDoc; inverses: TimelineOperation[] } | { ok: false; error: string } {
  let current = doc;
  const inverses: TimelineOperation[] = [];
  for (const op of ops) {
    const r = applyOperation(current, op);
    if (!r.ok) return r;
    current = r.timeline;
    inverses.unshift(...r.inverse);
  }
  return { ok: true, timeline: current, inverses };
}

/**
 * Validate a whole document against engine invariants (post-load or
 * pre-save sanity check on the client side). Uses the same rules as
 * applyOperation so a document produced by the engine always passes.
 */
export function checkInvariants(doc: TimelineDoc): string | null {
  if (!doc || !Array.isArray(doc.segments) || doc.segments.length === 0) {
    return "segments[] must be a non-empty array";
  }
  const fps = Number(doc.fps) || 30;
  const total = doc.segments.reduce((sum, s) => sum + Number(s.duration), 0);
  if (!Number.isFinite(total) || total <= 0) return "segments must have a positive total duration";
  const declared = Number(doc.durationInSeconds);
  if (!Number.isFinite(declared) || Math.abs(declared - total) > 0.01) {
    return `durationInSeconds ${declared} does not match segments sum ${total.toFixed(4)}`;
  }
  const frames = Number(doc.durationInFrames);
  if (!Number.isInteger(frames) || Math.abs(frames - Math.round(total * fps)) > 1) {
    return `durationInFrames ${frames} does not match segments sum (${Math.round(total * fps)})`;
  }
  for (let i = 0; i < doc.segments.length; i++) {
    const s = doc.segments[i];
    const err = checkSegmentBounds(s.file, s.startFrom, Number(s.duration), undefined);
    if (err) return `segment ${i}: ${err}`;
  }
  if (doc.audio) {
    const pr = Number(doc.audio.playbackRate);
    if (doc.audio.playbackRate !== undefined && (!Number.isFinite(pr) || pr <= 0)) {
      return "audio.playbackRate must be positive";
    }
  }
  return null;
}

// ─── Operation history (undo/redo core, batch 3a) ─────────────────────────
// Three-segment history modeled on Timeline Studio's editorHistoryCore:
// `past` holds applied entries (oldest → newest), `future` holds undone
// entries (oldest-undone → newest-undone). Pushing a new edit clears the
// future. Entries carry the operation AND its inverse, so undo replays the
// inverse against the current document and redo replays the original op —
// the op stream itself doubles as the audit manifest for batch 3b.

export interface OpHistoryEntry {
  op: TimelineOperation;
  /** Inverse ops, in application order (already reversed by the engine). */
  inverse: TimelineOperation[];
}

export interface OpHistory {
  past: OpHistoryEntry[];
  future: OpHistoryEntry[];
}

export const EMPTY_OP_HISTORY: OpHistory = { past: [], future: [] };

export const OP_HISTORY_LIMIT = 50;

/** Record an applied operation. No-op entries (empty inverse, e.g. a move
 *  to the same position) are dropped — they carry no undoable effect. */
export function pushOpHistory(
  history: OpHistory,
  entry: OpHistoryEntry,
  limit: number = OP_HISTORY_LIMIT
): OpHistory {
  if (entry.inverse.length === 0) return history;
  const safeLimit = Math.max(1, Math.floor(limit));
  return {
    past: [...history.past, entry].slice(-safeLimit),
    future: [],
  };
}

export interface HistoryStep {
  history: OpHistory;
  /** The document after the undo/redo, or null when there was nothing
   *  to undo/redo or the replay failed (engine should never fail here —
   *  inverses are validated symmetric to their ops). */
  timeline: TimelineDoc | null;
}

/** Undo the newest entry: replay its inverse against the current document. */
export function undoOpHistory(doc: TimelineDoc, history: OpHistory): HistoryStep {
  const entry = history.past[history.past.length - 1];
  if (!entry) return { history, timeline: null };
  const result = applyOperations(doc, entry.inverse);
  if (!result.ok) return { history, timeline: null };
  return {
    history: {
      past: history.past.slice(0, -1),
      future: [entry, ...history.future],
    },
    timeline: result.timeline,
  };
}

/** Redo the oldest undone entry: replay its original op. */
export function redoOpHistory(doc: TimelineDoc, history: OpHistory): HistoryStep {
  const entry = history.future[0];
  if (!entry) return { history, timeline: null };
  const result = applyOperations(doc, [entry.op]);
  if (!result.ok) return { history, timeline: null };
  return {
    history: {
      past: [...history.past, entry],
      future: history.future.slice(1),
    },
    timeline: result.timeline,
  };
}
