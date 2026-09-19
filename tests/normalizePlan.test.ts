// Tests for normalizeTimelinePlan (convex/lib/timelinePlan.ts) — the
// ingestion-normalization contract from the pipeline handoff review (P1-6).
//
// The stored timeline is the single source of truth for every consumer
// (sequence preview, completed preview, generate-composition). Normalization
// must: fill missing audio/subtitles fields with the CANONICAL defaults
// (which mirror generate-composition's own fallbacks exactly), never
// override explicit values, disable enabled tracks whose files were never
// downloaded, and backfill durationInSeconds from the segment sum.
// Run with: bun test tests/normalizePlan.test.ts
import { describe, expect, test } from "bun:test";
import { normalizeTimelinePlan, validateTimelinePlan } from "../convex/lib/timelinePlan";

// ─── fixtures ─────────────────────────────────────────────────────────────

const MEDIA = ["video0.mp4", "video1.mp4", "audio.mp3", "music.mp3", "subtitles.srt"];

/** Minimal plan; every field overridable. Parsed (normalize takes an object). */
function plan(overrides: Record<string, unknown> = {}): any {
  return {
    fps: 30,
    durationInFrames: 300,
    durationInSeconds: 10,
    segments: [
      { file: "video0.mp4", startFrom: 0, duration: 5 },
      { file: "video1.mp4", startFrom: 1, duration: 5 },
    ],
    audio: {
      voiceFile: "audio.mp3",
      voiceVolume: 1.0,
      playbackRate: 1.0,
      musicFile: "music.mp3",
      musicVolume: 0.1,
      originalSoundVolume: 0.0,
      includeMusic: true,
      includeVoice: true,
      includeOriginalSound: false,
    },
    subtitles: { file: "subtitles.srt", adjustForPlaybackRate: true, includeCaptions: true },
    ...overrides,
  };
}

// ─── completeness ──────────────────────────────────────────────────────────

describe("normalizeTimelinePlan: fills missing blocks with canonical defaults", () => {
  test("missing audio + subtitles blocks are created", () => {
    const raw = plan({ audio: undefined, subtitles: undefined });
    const out = normalizeTimelinePlan(raw);
    expect(out.audio).toEqual({
      voiceFile: "audio.mp3",
      voiceVolume: 1.0,
      playbackRate: 1.0,
      musicFile: "music.mp3",
      musicVolume: 0.1,
      originalSoundVolume: 0.0,
      includeMusic: true,
      includeVoice: true,
      includeOriginalSound: false,
    });
    expect(out.subtitles).toEqual({
      file: "subtitles.srt",
      adjustForPlaybackRate: true,
      includeCaptions: true,
    });
  });

  test("partial audio block keeps explicit values, fills the rest", () => {
    const raw = plan({ audio: { voiceFile: "audio.mp3", includeMusic: false } });
    const out = normalizeTimelinePlan(raw);
    expect(out.audio.includeMusic).toBe(false);          // explicit, preserved
    expect(out.audio.musicFile).toBe("music.mp3");         // filled
    expect(out.audio.voiceVolume).toBe(1.0);               // filled
    expect(out.audio.playbackRate).toBe(1.0);              // filled
  });

  test("complete blocks pass through byte-identical (editor path no-op)", () => {
    const raw = plan();
    const out = normalizeTimelinePlan(raw);
    expect(JSON.stringify(out)).toBe(JSON.stringify(raw));
  });
});

// ─── media cross-check ─────────────────────────────────────────────────────

describe("normalizeTimelinePlan: disables tracks whose files are missing", () => {
  test("voice disabled when audio.mp3 was never downloaded", () => {
    const raw = plan();
    const out = normalizeTimelinePlan(raw, ["video0.mp4", "video1.mp4", "music.mp3", "subtitles.srt"]);
    expect(out.audio.includeVoice).toBe(false);
    expect(out.audio.includeMusic).toBe(true);
    expect(out.subtitles.includeCaptions).toBe(true);
  });

  test("music + captions disabled when their files are missing", () => {
    const raw = plan();
    const out = normalizeTimelinePlan(raw, ["video0.mp4", "video1.mp4", "audio.mp3"]);
    expect(out.audio.includeVoice).toBe(true);
    expect(out.audio.includeMusic).toBe(false);
    expect(out.subtitles.includeCaptions).toBe(false);
  });

  test("all enabled tracks survive when every file is present", () => {
    const out = normalizeTimelinePlan(plan(), MEDIA);
    expect(out.audio.includeVoice).toBe(true);
    expect(out.audio.includeMusic).toBe(true);
    expect(out.subtitles.includeCaptions).toBe(true);
  });

  test("already-disabled tracks stay disabled even if files are missing", () => {
    const raw = plan({ audio: { voiceFile: "audio.mp3", includeVoice: false } });
    const out = normalizeTimelinePlan(raw, ["video0.mp4"]);
    expect(out.audio.includeVoice).toBe(false);
  });

  test("no availableFiles → no cross-check, flags untouched", () => {
    // saveEditorChanges has no sandbox listing; normalization must not
    // invent state it cannot verify.
    const out = normalizeTimelinePlan(plan());
    expect(out.audio.includeVoice).toBe(true);
    expect(out.subtitles.includeCaptions).toBe(true);
  });
});

// ─── durationInSeconds backfill ─────────────────────────────────────────────

describe("normalizeTimelinePlan: durationInSeconds backfill", () => {
  test("missing durationInSeconds is filled from the segment sum", () => {
    const raw = plan({ durationInSeconds: undefined });
    const out = normalizeTimelinePlan(raw);
    expect(out.durationInSeconds).toBe(10);
  });

  test("valid explicit durationInSeconds is preserved", () => {
    const out = normalizeTimelinePlan(plan({ durationInSeconds: 10 }));
    expect(out.durationInSeconds).toBe(10);
  });
});

// ─── post-conditions ────────────────────────────────────────────────────────

describe("normalizeTimelinePlan: normalized output still validates", () => {
  test("normalized plan (with disabled missing-file tracks) passes validateTimelinePlan", () => {
    // The disabled-track case is the interesting one: the RAW plan would be
    // REJECTED by the validator (voiceFile not in media), the normalized one
    // must pass because the track is now disabled.
    const raw = plan(); // includeVoice true, audio.mp3 missing below
    const out = normalizeTimelinePlan(raw, ["video0.mp4", "video1.mp4"]);
    const result = validateTimelinePlan(JSON.stringify(out), ["video0.mp4", "video1.mp4"]);
    expect(result.ok).toBe(true);
  });

  test("normalization never introduces a validator failure", () => {
    const raw = plan();
    const out = normalizeTimelinePlan(raw, MEDIA);
    const result = validateTimelinePlan(JSON.stringify(out), MEDIA);
    expect(result.ok).toBe(true);
  });
});
