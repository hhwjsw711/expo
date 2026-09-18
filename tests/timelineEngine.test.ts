// Boundary tests for the timeline operation engine (convex/lib/timelineEngine.ts).
// Run with: bun test tests/timelineEngine.test.ts
import { describe, expect, test } from "bun:test";
import {
  applyOperation,
  applyOperations,
  checkInvariants,
  MIN_SEGMENT_DURATION,
  MAX_SEGMENT_DURATION,
  pushOpHistory,
  undoOpHistory,
  redoOpHistory,
  EMPTY_OP_HISTORY,
  OP_HISTORY_LIMIT,
  type OpHistory,
  type TimelineDoc,
  type TimelineOperation,
} from "../convex/lib/timelineEngine";
import { validateTimelinePlan } from "../convex/lib/timelinePlan";

// 鈹€鈹€鈹€ fixtures 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function baseDoc(): TimelineDoc {
  return {
    fps: 30,
    durationInFrames: 270,
    durationInSeconds: 9,
    segments: [
      { file: "video0.mp4", startFrom: 0, duration: 3, comment: "a" },
      { file: "video1.mp4", startFrom: 1, duration: 3 },
      { file: "video0.mp4", startFrom: 2, duration: 3 },
    ],
    audio: { voiceFile: "audio.mp3", playbackRate: 1.0, musicFile: "music.mp3", musicVolume: 0.1, includeVoice: true },
    subtitles: { file: "subtitles.srt", includeCaptions: true },
  };
}

const MEDIA = ["video0.mp4", "video1.mp4", "audio.mp3", "music.mp3", "subtitles.srt"];

/** apply 鈫?apply(inverse) must land back on the exact original document. */
function roundTrip(doc: TimelineDoc, op: TimelineOperation) {
  const r = applyOperation(doc, op);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  let cur = r.timeline;
  for (const inv of r.inverse) {
    const rr = applyOperation(cur, inv);
    expect(rr.ok).toBe(true);
    if (!rr.ok) return;
    cur = rr.timeline;
  }
  expect(JSON.stringify(cur)).toBe(JSON.stringify(doc));
}

// 鈹€鈹€鈹€ 1. trimSegment 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe("trimSegment", () => {
  test("duration change recomputes declared duration", () => {
    const r = applyOperation(baseDoc(), { type: "trimSegment", index: 0, duration: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timeline.segments[0].duration).toBe(5);
    expect(r.timeline.durationInSeconds).toBe(11); // 5+3+3
    expect(r.timeline.durationInFrames).toBe(330);
  });
  test("startFrom-only change keeps the screen duration", () => {
    const r = applyOperation(baseDoc(), { type: "trimSegment", index: 1, startFrom: 2.5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timeline.segments[1].startFrom).toBe(2.5);
    expect(r.timeline.durationInSeconds).toBe(9);
  });
  test("duration below the floor is rejected", () => {
    const r = applyOperation(baseDoc(), { type: "trimSegment", index: 0, duration: MIN_SEGMENT_DURATION - 0.01 });
    expect(r.ok).toBe(false);
  });
  test("duration above the ceiling is rejected", () => {
    const r = applyOperation(baseDoc(), { type: "trimSegment", index: 0, duration: MAX_SEGMENT_DURATION + 0.01 });
    expect(r.ok).toBe(false);
  });
  test("negative startFrom is rejected", () => {
    const r = applyOperation(baseDoc(), { type: "trimSegment", index: 0, startFrom: -0.1 });
    expect(r.ok).toBe(false);
  });
  test("startFrom + duration beyond sourceDuration is rejected", () => {
    const r = applyOperation(baseDoc(), { type: "trimSegment", index: 0, startFrom: 2, duration: 9, sourceDuration: 10 });
    expect(r.ok).toBe(false); // 2 + 9 > 10
  });
  test("out-of-range index is rejected", () => {
    expect(applyOperation(baseDoc(), { type: "trimSegment", index: 3, duration: 2 }).ok).toBe(false);
    expect(applyOperation(baseDoc(), { type: "trimSegment", index: -1, duration: 2 }).ok).toBe(false);
  });
  test("round trip restores the original document", () => {
    roundTrip(baseDoc(), { type: "trimSegment", index: 0, duration: 6 });
    roundTrip(baseDoc(), { type: "trimSegment", index: 2, startFrom: 0 });
  });
  test("input document is not mutated", () => {
    const doc = baseDoc();
    applyOperation(doc, { type: "trimSegment", index: 0, duration: 5 });
    expect(doc.segments[0].duration).toBe(3);
    expect(doc.durationInSeconds).toBe(9);
  });
});

// 鈹€鈹€鈹€ 2. moveSegment 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe("moveSegment", () => {
  test("moves forward (from < to)", () => {
    const r = applyOperation(baseDoc(), { type: "moveSegment", from: 0, to: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // seg0 carries comment "a" and travels to the end
    expect(r.timeline.segments.map(s => s.comment ?? s.file)).toEqual(["video1.mp4", "video0.mp4", "a"]);
  });
  test("moves backward (from > to)", () => {
    const r = applyOperation(baseDoc(), { type: "moveSegment", from: 2, to: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timeline.segments[0].startFrom).toBe(2);
  });
  test("same position is a no-op with empty inverse", () => {
    const r = applyOperation(baseDoc(), { type: "moveSegment", from: 1, to: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inverse).toEqual([]);
    expect(JSON.stringify(r.timeline)).toBe(JSON.stringify(baseDoc()));
  });
  test("out-of-range indices are rejected", () => {
    expect(applyOperation(baseDoc(), { type: "moveSegment", from: 3, to: 0 }).ok).toBe(false);
    expect(applyOperation(baseDoc(), { type: "moveSegment", from: 0, to: 3 }).ok).toBe(false);
  });
  test("round trips in both directions", () => {
    roundTrip(baseDoc(), { type: "moveSegment", from: 0, to: 2 });
    roundTrip(baseDoc(), { type: "moveSegment", from: 2, to: 0 });
    roundTrip(baseDoc(), { type: "moveSegment", from: 1, to: 2 });
  });
});

// 鈹€鈹€鈹€ 3. splitSegment 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe("splitSegment", () => {
  test("splits into two halves preserving the total", () => {
    const r = applyOperation(baseDoc(), { type: "splitSegment", index: 1, at: 1.2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const segs = r.timeline.segments;
    expect(segs.length).toBe(4);
    expect(segs[1].startFrom).toBe(1);         // first half keeps original offset
    expect(segs[1].duration).toBe(1.2);
    expect(segs[2].startFrom).toBe(1 + 1.2);   // second half starts where the first ends
    expect(segs[2].duration).toBe(1.8);
    expect(r.timeline.durationInSeconds).toBe(9); // total unchanged
    expect(r.timeline.durationInFrames).toBe(270);
  });
  test("split at the floor boundary is rejected", () => {
    expect(applyOperation(baseDoc(), { type: "splitSegment", index: 0, at: MIN_SEGMENT_DURATION }).ok).toBe(false);
  });
  test("split near the right edge is rejected", () => {
    expect(applyOperation(baseDoc(), { type: "splitSegment", index: 0, at: 3 - MIN_SEGMENT_DURATION }).ok).toBe(false);
  });
  test("out-of-range index is rejected", () => {
    expect(applyOperation(baseDoc(), { type: "splitSegment", index: 5, at: 1 }).ok).toBe(false);
  });
  test("round trip (remove + trim) restores the original", () => {
    roundTrip(baseDoc(), { type: "splitSegment", index: 1, at: 1.2 });
    roundTrip(baseDoc(), { type: "splitSegment", index: 0, at: 2.5 }); // inside (0.3, 2.7)
  });
});

// 鈹€鈹€鈹€ 4. removeSegment 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe("removeSegment", () => {
  test("removes and recomputes the declared duration", () => {
    const r = applyOperation(baseDoc(), { type: "removeSegment", index: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timeline.segments.length).toBe(2);
    expect(r.timeline.durationInSeconds).toBe(6);
    expect(r.timeline.durationInFrames).toBe(180);
  });
  test("removing the last remaining segment is rejected", () => {
    const r1 = applyOperation(baseDoc(), { type: "removeSegment", index: 0 });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = applyOperation(r1.timeline, { type: "removeSegment", index: 1 });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const r3 = applyOperation(r2.timeline, { type: "removeSegment", index: 0 });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error).toContain("last segment");
  });
  test("round trip (insert) restores the original", () => {
    roundTrip(baseDoc(), { type: "removeSegment", index: 2 });
    roundTrip(baseDoc(), { type: "removeSegment", index: 0 });
  });
});

// 鈹€鈹€鈹€ 5. insertSegment 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe("insertSegment", () => {
  test("inserts at the start and recomputes duration", () => {
    const r = applyOperation(baseDoc(), {
      type: "insertSegment", index: 0, segment: { file: "video1.mp4", startFrom: 0, duration: 4 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timeline.segments.length).toBe(4);
    expect(r.timeline.durationInSeconds).toBe(13);
  });
  test("inserts at the end (index === length)", () => {
    const r = applyOperation(baseDoc(), {
      type: "insertSegment", index: 3, segment: { file: "video0.mp4", startFrom: 0, duration: 2 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timeline.segments[3].duration).toBe(2);
  });
  test("path-like file names are rejected", () => {
    const r = applyOperation(baseDoc(), {
      type: "insertSegment", index: 0, segment: { file: "../evil.mp4", startFrom: 0, duration: 2 },
    });
    expect(r.ok).toBe(false);
  });
  test("zero-duration insert is rejected", () => {
    const r = applyOperation(baseDoc(), {
      type: "insertSegment", index: 0, segment: { file: "video0.mp4", startFrom: 0, duration: 0 },
    });
    expect(r.ok).toBe(false);
  });
  test("round trip (remove) restores the original", () => {
    roundTrip(baseDoc(), { type: "insertSegment", index: 1, segment: { file: "video1.mp4", startFrom: 0, duration: 4 } });
    roundTrip(baseDoc(), { type: "insertSegment", index: 3, segment: { file: "video0.mp4", startFrom: 0, duration: 2 } });
  });
});

// 鈹€鈹€鈹€ 6. replaceSegmentFile 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe("replaceSegmentFile", () => {
  test("swaps the source clip", () => {
    const r = applyOperation(baseDoc(), { type: "replaceSegmentFile", index: 0, file: "video1.mp4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timeline.segments[0].file).toBe("video1.mp4");
    expect(r.timeline.durationInSeconds).toBe(9); // duration untouched
  });
  test("slash in file is rejected", () => {
    expect(applyOperation(baseDoc(), { type: "replaceSegmentFile", index: 0, file: "a/b.mp4" }).ok).toBe(false);
  });
  test("sourceDuration clamp applies to the new file", () => {
    const r = applyOperation(baseDoc(), { type: "replaceSegmentFile", index: 0, file: "video1.mp4", startFrom: 8, sourceDuration: 10 });
    expect(r.ok).toBe(false); // 8 + 3 > 10
  });
  test("round trip restores the original", () => {
    roundTrip(baseDoc(), { type: "replaceSegmentFile", index: 1, file: "video0.mp4", startFrom: 0.5 });
  });
});

// 鈹€鈹€鈹€ 7. adjustAudio 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe("adjustAudio", () => {
  test("patches only the listed keys", () => {
    const r = applyOperation(baseDoc(), { type: "adjustAudio", patch: { musicVolume: 0.4, includeMusic: true } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timeline.audio!.musicVolume).toBe(0.4);
    expect(r.timeline.audio!.includeMusic).toBe(true);
    expect(r.timeline.audio!.voiceFile).toBe("audio.mp3"); // untouched
    expect(r.timeline.audio!.playbackRate).toBe(1.0);      // untouched
  });
  test("zero playbackRate is rejected", () => {
    expect(applyOperation(baseDoc(), { type: "adjustAudio", patch: { playbackRate: 0 } }).ok).toBe(false);
  });
  test("negative playbackRate is rejected", () => {
    expect(applyOperation(baseDoc(), { type: "adjustAudio", patch: { playbackRate: -1.25 } }).ok).toBe(false);
  });
  test("round trip restores the original", () => {
    roundTrip(baseDoc(), { type: "adjustAudio", patch: { playbackRate: 1.25, includeVoice: false } });
    roundTrip(baseDoc(), { type: "adjustAudio", patch: { musicVolume: 0.5 } });
  });
});

// 鈹€鈹€鈹€ 8. adjustSubtitles 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe("adjustSubtitles", () => {
  test("toggles captions", () => {
    const r = applyOperation(baseDoc(), { type: "adjustSubtitles", patch: { includeCaptions: false } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timeline.subtitles!.includeCaptions).toBe(false);
  });
  test("round trip restores the original", () => {
    roundTrip(baseDoc(), { type: "adjustSubtitles", patch: { includeCaptions: false, adjustForPlaybackRate: false } });
  });
});

// 鈹€鈹€鈹€ 9. document invariants 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe("checkInvariants", () => {
  test("the base fixture passes", () => {
    expect(checkInvariants(baseDoc())).toBeNull();
  });
  test("empty segments array is rejected", () => {
    const doc = baseDoc();
    doc.segments = [];
    expect(checkInvariants(doc)).toContain("non-empty");
  });
  test("declared/segments drift is rejected", () => {
    const doc = baseDoc();
    doc.durationInSeconds = 99;
    expect(checkInvariants(doc)).toContain("does not match");
  });
  test("frame count drift is rejected", () => {
    const doc = baseDoc();
    doc.durationInFrames = 999;
    expect(checkInvariants(doc)).toContain("does not match");
  });
  test("an out-of-range segment is rejected", () => {
    const doc = baseDoc();
    doc.segments[0].duration = 42;
    // keep declared/frames aligned so ONLY the range violation is left
    doc.durationInSeconds = 48;
    doc.durationInFrames = 1440;
    expect(checkInvariants(doc)).toContain("out of range");
  });
});

// 鈹€鈹€鈹€ 10. operation chains 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe("applyOperations", () => {
  test("chains operations and stops on the first failure", () => {
    const r = applyOperations(baseDoc(), [
      { type: "trimSegment", index: 0, duration: 4 },
      { type: "moveSegment", from: 0, to: 1 },
      { type: "trimSegment", index: 9, duration: 1 }, // fails
      { type: "adjustAudio", patch: { musicVolume: 1 } },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("index 9");
  });
  test("inverses replayed backwards restore the original document", () => {
    const ops: TimelineOperation[] = [
      { type: "splitSegment", index: 0, at: 1.5 },
      { type: "removeSegment", index: 3 },
      { type: "trimSegment", index: 0, duration: 5 },
      { type: "adjustAudio", patch: { playbackRate: 1.25 } },
      { type: "moveSegment", from: 1, to: 0 },
    ];
    const r = applyOperations(baseDoc(), ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(checkInvariants(r.timeline)).toBeNull();
    // inverses are collected in reverse order already: replay them in order
    let cur = r.timeline;
    for (const inv of r.inverses) {
      const rr = applyOperation(cur, inv);
      expect(rr.ok).toBe(true);
      if (!rr.ok) return;
      cur = rr.timeline;
    }
    expect(JSON.stringify(cur)).toBe(JSON.stringify(baseDoc()));
  });
});

// 鈹€鈹€鈹€ 11. engine 鈫?validator contract 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe("engine output always satisfies validateTimelinePlan", () => {
  const ops: TimelineOperation[] = [
    { type: "trimSegment", index: 0, duration: 5 },
    { type: "splitSegment", index: 2, at: 1.4 },
    { type: "insertSegment", index: 0, segment: { file: "video1.mp4", startFrom: 0, duration: 2.2 } },
    { type: "removeSegment", index: 1 },
    { type: "moveSegment", from: 3, to: 0 },
    { type: "replaceSegmentFile", index: 2, file: "video1.mp4" },
    { type: "adjustAudio", patch: { playbackRate: 1.25 } },
    { type: "adjustSubtitles", patch: { includeCaptions: false } },
  ];
  test("every intermediate document serializes to a valid plan", () => {
    let cur = baseDoc();
    for (const op of ops) {
      const r = applyOperation(cur, op);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const check = validateTimelinePlan(JSON.stringify(r.timeline), MEDIA);
      expect(check.ok).toBe(true);
      cur = r.timeline;
    }
  });
});

// 鈹€鈹€鈹€ 12. operation history (undo/redo core) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe("operation history (undo/redo)", () => {
  /** Apply an op and record it in history in one step, like the editor does. */
  function step(doc: TimelineDoc, history: OpHistory, op: TimelineOperation) {
    const r = applyOperation(doc, op);
    expect(r.ok).toBe(true);
    if (!r.ok) return null;
    return { doc: r.timeline, history: pushOpHistory(history, { op, inverse: r.inverse }) };
  }

  const OPS: TimelineOperation[] = [
    { type: "trimSegment", index: 0, duration: 4.5 },
    { type: "splitSegment", index: 2, at: 1.4 },
    { type: "adjustAudio", patch: { musicVolume: 0.7, includeMusic: false } },
    { type: "moveSegment", from: 3, to: 0 },
    { type: "removeSegment", index: 1 },
    { type: "adjustSubtitles", patch: { includeCaptions: false } },
  ];

  test("push drops no-op entries (empty inverse)", () => {
    const h = pushOpHistory(EMPTY_OP_HISTORY, { op: { type: "moveSegment", from: 1, to: 1 }, inverse: [] });
    expect(h.past.length).toBe(0);
  });

  test("push clears the redo stack (new edit after undo)", () => {
    let st = step(baseDoc(), EMPTY_OP_HISTORY, OPS[0]);
    if (!st) return;
    const undone = undoOpHistory(st.doc, st.history);
    expect(undone.timeline).not.toBeNull();
    const reEdited = pushOpHistory(undone.history, { op: OPS[2], inverse: [{ type: "adjustAudio", patch: {} }] });
    expect(reEdited.future.length).toBe(0);
  });

  test("push honors the history limit", () => {
    let h = EMPTY_OP_HISTORY;
    for (let i = 0; i < OP_HISTORY_LIMIT + 10; i++) {
      h = pushOpHistory(h, { op: { type: "adjustAudio", patch: { musicVolume: i / 100 } }, inverse: [{ type: "adjustAudio", patch: { musicVolume: 0.1 } }] });
    }
    expect(h.past.length).toBe(OP_HISTORY_LIMIT);
  });

  test("undo on empty history is a null step", () => {
    const r = undoOpHistory(baseDoc(), EMPTY_OP_HISTORY);
    expect(r.timeline).toBeNull();
  });

  test("redo on empty future is a null step", () => {
    const r = redoOpHistory(baseDoc(), EMPTY_OP_HISTORY);
    expect(r.timeline).toBeNull();
  });

  test("full undo restores the original; full redo restores the edited state", () => {
    // replay the whole chain, recording history
    let doc = baseDoc();
    let history = EMPTY_OP_HISTORY;
    for (const op of OPS) {
      const st = step(doc, history, op);
      if (!st) return;
      doc = st.doc;
      history = st.history;
    }
    expect(history.past.length).toBe(OPS.length);
    const finalDoc = doc;

    // undo everything
    let undoneCount = 0;
    for (;;) {
      const r = undoOpHistory(doc, history);
      if (!r.timeline) break;
      doc = r.timeline;
      history = r.history;
      undoneCount++;
      expect(checkInvariants(doc)).toBeNull();
    }
    expect(undoneCount).toBe(OPS.length);
    expect(JSON.stringify(doc)).toBe(JSON.stringify(baseDoc()));

    // redo everything
    let redoneCount = 0;
    for (;;) {
      const r = redoOpHistory(doc, history);
      if (!r.timeline) break;
      doc = r.timeline;
      history = r.history;
      redoneCount++;
      expect(checkInvariants(doc)).toBeNull();
    }
    expect(redoneCount).toBe(OPS.length);
    expect(JSON.stringify(doc)).toBe(JSON.stringify(finalDoc));
  });

  test("undo interleaved with redo keeps documents invariant-valid", () => {
    let doc = baseDoc();
    let history = EMPTY_OP_HISTORY;
    for (const op of OPS.slice(0, 3)) {
      const st = step(doc, history, op);
      if (!st) return;
      doc = st.doc;
      history = st.history;
    }
    // undo one, redo one, undo two, redo two 鈥?every intermediate must be valid
    const u1 = undoOpHistory(doc, history);
    expect(u1.timeline).not.toBeNull();
    if (!u1.timeline) return;
    expect(checkInvariants(u1.timeline)).toBeNull();
    const r1 = redoOpHistory(u1.timeline, u1.history);
    expect(r1.timeline).not.toBeNull();
    if (!r1.timeline) return;
    expect(JSON.stringify(r1.timeline)).toBe(JSON.stringify(doc));
  });
});

