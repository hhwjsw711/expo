// Adversarial boundary tests for validateTimelinePlan (convex/lib/timelinePlan.ts).
// Run with: bun test tests/timelinePlan.test.ts
// (bun's built-in test runner — no new dependencies.)
import { describe, expect, test } from "bun:test";
import { validateTimelinePlan } from "../convex/lib/timelinePlan";

// ─── fixtures ─────────────────────────────────────────────────────────────

const MEDIA = ["video0.mp4", "video1.mp4", "audio.mp3", "music.mp3", "subtitles.srt"];

/** Minimal valid plan; every field overridable. */
function plan(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    fps: 30,
    durationInFrames: 300,
    durationInSeconds: 10,
    segments: [
      { file: "video0.mp4", startFrom: 0, duration: 5 },
      { file: "video1.mp4", startFrom: 1, duration: 5 },
    ],
    audio: { voiceFile: "audio.mp3", playbackRate: 1.0, includeVoice: true },
    ...overrides,
  });
}

/** One-segment plan with a single segment override applied.
 *  declared durationInSeconds auto-aligns to the segment's duration unless
 *  the caller overrides it, so tests don't have to specify it each time. */
function segmentPlan(seg: unknown, extra: Record<string, unknown> = {}): string {
  const segObj = (typeof seg === "object" && seg !== null) ? (seg as Record<string, unknown>) : {};
  const segDur = Number(segObj.duration);
  const defaults: Record<string, unknown> = {};
  if (Number.isFinite(segDur) && segDur > 0 && !("durationInSeconds" in extra)) {
    defaults.durationInSeconds = segDur;
  }
  return plan({ segments: [seg], ...defaults, ...extra });
}

// ─── 1. raw input parsing ──────────────────────────────────────────────────

describe("raw input parsing", () => {
  test("empty string is rejected", () => {
    expect(validateTimelinePlan("").ok).toBe(false);
  });
  test("whitespace-only string is rejected", () => {
    expect(validateTimelinePlan("   \n\t  ").ok).toBe(false);
  });
  test("malformed JSON (trailing comma) is rejected", () => {
    expect(validateTimelinePlan('{"segments":[],}').ok).toBe(false);
  });
  test("malformed JSON (truncated) is rejected", () => {
    expect(validateTimelinePlan('{"segments": [').ok).toBe(false);
  });
  test("JSON primitive number is rejected", () => {
    expect(validateTimelinePlan("42").ok).toBe(false);
  });
  test("JSON primitive string is rejected", () => {
    expect(validateTimelinePlan('"hello"').ok).toBe(false);
  });
  test("JSON null is rejected", () => {
    expect(validateTimelinePlan("null").ok).toBe(false);
  });
  test("JSON true is rejected", () => {
    expect(validateTimelinePlan("true").ok).toBe(false);
  });
});

// ─── 2. segments structure ────────────────────────────────────────────────

describe("segments structure", () => {
  test("missing segments[] is rejected", () => {
    const r = validateTimelinePlan('{"fps":30}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("segments");
  });
  test("empty segments[] is rejected", () => {
    expect(validateTimelinePlan('{"segments":[]}').ok).toBe(false);
  });
  test("segments as object (not array) is rejected", () => {
    expect(validateTimelinePlan('{"segments":{"length":3}}').ok).toBe(false);
  });
  test("null segment entries are rejected", () => {
    expect(validateTimelinePlan('{"segments":[null]}').ok).toBe(false);
  });
  test("segment without file is rejected", () => {
    const r = validateTimelinePlan(segmentPlan({ startFrom: 0, duration: 3 }));
    expect(r.ok).toBe(false);
  });
  test("non-string file is rejected", () => {
    const r = validateTimelinePlan(segmentPlan({ file: 123, startFrom: 0, duration: 3 }));
    expect(r.ok).toBe(false);
  });
});

// ─── 3. path injection in segment.file ────────────────────────────────────

describe("path injection in segment.file", () => {
  // These contain a literal forward slash and must be rejected outright.
  const slashAttacks = [
    "../etc/passwd",
    "/abs/path.mp4",
    "media/../src/Composition",
    "a/b.mp4",
  ];
  for (const file of slashAttacks) {
    test(`forward-slash path "${file}" is rejected`, () => {
      const r = validateTimelinePlan(segmentPlan({ file, startFrom: 0, duration: 3 }));
      expect(r.ok).toBe(false);
    });
  }

  // Encoded slash is NOT a path separator — it is a legal literal filename.
  // The media listing cross-check is what catches it in practice.
  test('encoded-slash name "..%2Fevil.mp4" is a legal filename but rejected by the listing', () => {
    const raw = segmentPlan({ file: "..%2Fevil.mp4", startFrom: 0, duration: 3 });
    expect(validateTimelinePlan(raw).ok).toBe(true); // no slash, legal name, no listing
    expect(validateTimelinePlan(raw, MEDIA).ok).toBe(false); // not in the media listing
  });

  // KNOWN GAP, documented: backslashes are not path separators on Linux, and
  // the media listing cross-check (see below) is the real guard. This test
  // PINS the current behavior so any future change is deliberate.
  test("backslash name passes without listing, but is caught by the listing cross-check", () => {
    const raw = segmentPlan({ file: "..\\..\\secret.mp4", startFrom: 0, duration: 3 });
    expect(validateTimelinePlan(raw).ok).toBe(true); // no listing → slips through
    const r = validateTimelinePlan(raw, MEDIA);
    expect(r.ok).toBe(false); // listing → rejected (file does not exist)
  });
});

// ─── 4. numeric coercion of startFrom / duration ──────────────────────────

describe("numeric coercion", () => {
  test("string numbers are coerced (lenient, pinned behavior)", () => {
    const r = validateTimelinePlan(
      segmentPlan({ file: "video0.mp4", startFrom: "2", duration: "3" })
    );
    expect(r.ok).toBe(true);
  });
  test("undefined startFrom is rejected", () => {
    const r = validateTimelinePlan(segmentPlan({ file: "video0.mp4", duration: 3 }));
    expect(r.ok).toBe(false);
  });
  test("undefined duration is rejected", () => {
    const r = validateTimelinePlan(segmentPlan({ file: "video0.mp4", startFrom: 0 }));
    expect(r.ok).toBe(false);
  });
  test("non-numeric strings are rejected", () => {
    const r = validateTimelinePlan(segmentPlan({ file: "video0.mp4", startFrom: "abc", duration: 3 }));
    expect(r.ok).toBe(false);
  });
  // JSON.stringify coerces Infinity/NaN to null, so these must be raw JSON
  // strings to actually reach the Number.isFinite guard.
  test('startFrom 1e999 (parses to Infinity) is rejected', () => {
    const raw = '{"segments":[{"file":"video0.mp4","startFrom":1e999,"duration":3}],"durationInSeconds":3}';
    expect(validateTimelinePlan(raw).ok).toBe(false);
  });
  test('duration 1e999 (parses to Infinity) is rejected', () => {
    const raw = '{"segments":[{"file":"video0.mp4","startFrom":0,"duration":1e999}],"durationInSeconds":3}';
    expect(validateTimelinePlan(raw).ok).toBe(false);
  });
});

// ─── 5. duration range (0, 10] ─────────────────────────────────────────────

describe("duration range", () => {
  const cases: Array<[unknown, boolean]> = [
    [0, false],
    [-1, false],
    [0.001, true],
    [10, true],
    [10.01, false],
    [1e-9, true],
  ];
  for (const [dur, shouldPass] of cases) {
    test(`duration ${String(dur)} ${shouldPass ? "passes" : "is rejected"}`, () => {
      // auto-align declared duration for positive values; for non-positive
      // ones pass durationInSeconds:0 so the alignment check is skipped and
      // the range guard is what actually fires.
      const extra = Number(dur) > 0 ? {} : { durationInSeconds: 0 };
      const r = validateTimelinePlan(
        segmentPlan({ file: "video0.mp4", startFrom: 0, duration: dur }, extra)
      );
      expect(r.ok).toBe(shouldPass);
    });
  }
});

// ─── 6. total vs declared duration alignment ───────────────────────────────

describe("duration alignment", () => {
  test("exact match passes", () => {
    expect(validateTimelinePlan(plan(), MEDIA).ok).toBe(true);
  });
  test("0.75s tolerance boundary passes (<= 0.75)", () => {
    const raw = plan({ durationInSeconds: 10.75 }); // 10 vs 10.75 = 0.75
    expect(validateTimelinePlan(raw, MEDIA).ok).toBe(true);
  });
  test("0.76s drift is rejected", () => {
    const raw = plan({ durationInSeconds: 10.76 });
    expect(validateTimelinePlan(raw, MEDIA).ok).toBe(false);
  });
  test("error message reports both numbers", () => {
    const raw = plan({ durationInSeconds: 20 });
    const r = validateTimelinePlan(raw, MEDIA);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("10.00");
      expect(r.error).toContain("20.00");
    }
  });

  // REGRESSION for the playbackRate math fix: screen time must be compared to
  // declared duration directly. The old code multiplied by 1/playbackRate and
  // would REJECT this valid plan.
  test("playbackRate 2.0 does not affect screen-time alignment", () => {
    const raw = plan({ audio: { playbackRate: 2.0, includeVoice: true } });
    expect(validateTimelinePlan(raw, MEDIA).ok).toBe(true);
  });
  test("playbackRate 0.5 does not affect screen-time alignment", () => {
    const raw = plan({ audio: { playbackRate: 0.5, includeVoice: true } });
    expect(validateTimelinePlan(raw, MEDIA).ok).toBe(true);
  });

  // LENIENT, pinned: a plan without a declared duration skips the alignment
  // check entirely (durationInFrames is not consulted either — known gap).
  test("missing declared duration skips alignment (lenient, pinned)", () => {
    const raw = JSON.parse(plan());
    delete raw.durationInSeconds;
    expect(validateTimelinePlan(JSON.stringify(raw), MEDIA).ok).toBe(true);
  });
  test("declared duration of 0 skips alignment (lenient, pinned)", () => {
    const raw = plan({ durationInSeconds: 0 });
    expect(validateTimelinePlan(raw, MEDIA).ok).toBe(true);
  });
  test("string declared duration is coerced", () => {
    const raw = plan({ durationInSeconds: "10" });
    expect(validateTimelinePlan(raw, MEDIA).ok).toBe(true);
  });
});

// ─── 7. media listing cross-check ─────────────────────────────────────────

describe("media listing cross-check", () => {
  test("file present in listing passes", () => {
    expect(validateTimelinePlan(plan(), MEDIA).ok).toBe(true);
  });
  test("hallucinated file is rejected and lists what exists", () => {
    const raw = segmentPlan({ file: "video9.mp4", startFrom: 0, duration: 3 }, { durationInSeconds: 3 });
    const r = validateTimelinePlan(raw, MEDIA);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("video9.mp4");
      expect(r.error).toContain("video0.mp4");
    }
  });
  test("listing is case-sensitive (Linux semantics)", () => {
    const raw = segmentPlan({ file: "Video0.mp4", startFrom: 0, duration: 3 }, { durationInSeconds: 3 });
    expect(validateTimelinePlan(raw, MEDIA).ok).toBe(false);
  });
  test("empty listing skips the cross-check (lenient, pinned)", () => {
    const raw = segmentPlan({ file: "ghost.mp4", startFrom: 0, duration: 3 }, { durationInSeconds: 3 });
    expect(validateTimelinePlan(raw, []).ok).toBe(true);
  });
  test("no listing skips the cross-check", () => {
    const raw = segmentPlan({ file: "ghost.mp4", startFrom: 0, duration: 3 }, { durationInSeconds: 3 });
    expect(validateTimelinePlan(raw).ok).toBe(true);
  });
  // generate-composition.ts appends ".mp4" to extensionless names, but the
  // validator requires the exact listing name — stricter than the generator.
  // Pinned so a future relaxation is a conscious decision.
  test("extensionless name fails the listing check even though the generator would resolve it", () => {
    const raw = segmentPlan({ file: "video0", startFrom: 0, duration: 3 }, { durationInSeconds: 3 });
    expect(validateTimelinePlan(raw, MEDIA).ok).toBe(false);
  });
});

// ─── 8. real-world regressions ────────────────────────────────────────────

describe("real-world regressions", () => {
  // The exact timeline the smoke-test Claude agent produced on 2026-09-17
  // (6 segments, 18.286s, only video0.mp4 available).
  const SMOKE_TIMELINE = JSON.stringify({
    fps: 30,
    durationInFrames: 549,
    durationInSeconds: 18.286,
    segments: [
      { file: "video0.mp4", startFrom: 2.0, duration: 3.0 },
      { file: "video0.mp4", startFrom: 0.0, duration: 3.0 },
      { file: "video0.mp4", startFrom: 1.0, duration: 3.0 },
      { file: "video0.mp4", startFrom: 3.0, duration: 3.0 },
      { file: "video0.mp4", startFrom: 0.5, duration: 3.0 },
      { file: "video0.mp4", startFrom: 1.5, duration: 3.286 },
    ],
    audio: {
      voiceFile: "audio.mp3",
      voiceVolume: 1.0,
      playbackRate: 1.0,
      musicFile: "music.mp3",
      musicVolume: 0.1,
      includeMusic: true,
      includeVoice: true,
    },
    subtitles: { file: "subtitles.srt", adjustForPlaybackRate: true, includeCaptions: true },
  });

  test("smoke-test timeline (6 segments, 18.286s) still validates", () => {
    const r = validateTimelinePlan(SMOKE_TIMELINE, [
      "video0.mp4", "audio.mp3", "music.mp3", "subtitles.srt",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const total = (r.plan.segments as Array<{ duration: number }>)
        .reduce((s, x) => s + x.duration, 0);
      expect(Math.abs(total - 18.286)).toBeLessThan(0.01);
    }
  });

  test("smoke timeline with a hallucinated clip is rejected", () => {
    const p = JSON.parse(SMOKE_TIMELINE);
    p.segments.push({ file: "b-roll.mp4", startFrom: 0, duration: 3 });
    const r = validateTimelinePlan(JSON.stringify(p), [
      "video0.mp4", "audio.mp3", "music.mp3", "subtitles.srt",
    ]);
    expect(r.ok).toBe(false);
  });
});
