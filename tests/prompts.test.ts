// Music prompt regression tests (convex/prompts.ts musicGeneration).
// Run with: bun test tests/prompts.test.ts
//
// M18 (P1-D): the prompt feeds MiniMax music-3.0 directly — these tests
// pin the contract the generation quality depends on: per-style distinct
// descriptions, the mix-targeting constraints (instrumental / no long
// intro / consistent groove / voiceover-friendly), and the neutral
// fallback for unknown styles.
import { describe, expect, test } from "bun:test";
import { prompts } from "../convex/prompts";

const P = prompts.musicGeneration.prompt;

describe("musicGeneration.prompt — style mapping", () => {
  test("the three preferredStyle values map to distinct descriptions", () => {
    const playful = P("playful");
    const professional = P("professional");
    const travel = P("travel");
    expect(playful).not.toBe(professional);
    expect(professional).not.toBe(travel);
    expect(travel).not.toBe(playful);
  });

  test("playful carries the bouncy-pop ingredients", () => {
    expect(P("playful")).toContain("bouncy mid-tempo groove");
  });

  test("professional carries the minimal-electronic ingredients", () => {
    expect(P("professional")).toContain("clean modern minimal electronic");
  });

  test("travel carries the cinematic-acoustic ingredients", () => {
    expect(P("travel")).toContain("acoustic guitar arpeggios");
  });

  test("unknown style falls back to the neutral description (not a crash)", () => {
    const fallback = P("does-not-exist");
    expect(fallback).toContain("light modern instrumental background music");
    expect(fallback).toContain("steady unobtrusive groove");
  });

  test("default call is equivalent to professional", () => {
    expect(P()).toBe(P("professional"));
  });
});

describe("musicGeneration.prompt — BGM mix contract", () => {
  const common = P("playful"); // any style carries the same constraints

  test("instrumental-only constraint present", () => {
    expect(common).toContain("Instrumental only, no vocals, no lyrics");
  });

  test("immediate-start constraint present (15s video cannot afford an intro)", () => {
    expect(common).toContain("no long intro");
  });

  test("consistent-groove constraint present (no builds/drops under voiceover)", () => {
    expect(common).toContain("one consistent groove");
  });

  test("voiceover-awareness present (track sits at ~10% volume in the mix)", () => {
    expect(common).toContain("beneath a spoken voiceover");
  });

  test("output is a single flat string (no newlines for the MiniMax API payload)", () => {
    expect(common).not.toMatch(/\n/);
  });
});
