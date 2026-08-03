import { describe, expect, it } from "vitest";

import { isAssFormat } from "./subtitles";

describe("isAssFormat", () => {
  it("returns true for ass and ssa", () => {
    expect(isAssFormat("ass")).toBe(true);
    expect(isAssFormat("ssa")).toBe(true);
  });

  it("returns false for other text formats", () => {
    expect(isAssFormat("srt")).toBe(false);
    expect(isAssFormat("vtt")).toBe(false);
  });

  it("is case-sensitive (backend stores lowercase)", () => {
    // The backend normalizes format to lowercase at probe time
    // (crates/catalog/src/probe.rs). Uppercase should not match — if it
    // appears, it's a bug we want to surface, not silently accept.
    expect(isAssFormat("ASS")).toBe(false);
    expect(isAssFormat("Ssa")).toBe(false);
  });

  it("returns false for unknown / image formats", () => {
    expect(isAssFormat("pgs")).toBe(false);
    expect(isAssFormat("vobsub")).toBe(false);
    expect(isAssFormat("unknown")).toBe(false);
  });
});
