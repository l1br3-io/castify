import { describe, expect, it } from "vitest";

import { ApiError } from "../api/client";
import {
  describeError,
  filenameInitial,
  formatDuration,
  formatResolution,
  formatSize,
  resolutionBucket,
} from "./format";

describe("formatSize", () => {
  it("uses bytes below 1024", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("uses KB just above 1024", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(5_242_880)).toBe("5.0 MB"); // 5 * 1024 * 1024
  });

  it("scales through MB / GB / TB", () => {
    expect(formatSize(1_073_741_824)).toBe("1.0 GB"); // 1024^3
    expect(formatSize(1_099_511_627_776)).toBe("1.0 TB"); // 1024^4
  });

  it("stops at TB (does not render PB)", () => {
    // 10 TB worth of bytes still renders as TB.
    expect(formatSize(10_995_116_277_760)).toBe("10.0 TB");
  });
});

describe("formatDuration", () => {
  it("renders sub-minute as M:SS", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(59_000)).toBe("0:59");
  });

  it("renders minutes as M:SS without zero-padding the minute", () => {
    expect(formatDuration(120_000)).toBe("2:00"); // 2m
    expect(formatDuration(65_000)).toBe("1:05"); // 1m 5s — minute not padded
    expect(formatDuration(125_000)).toBe("2:05"); // 2m 5s
  });

  it("renders hours as H:MM:SS", () => {
    expect(formatDuration(3_600_000)).toBe("1:00:00"); // 1h
    expect(formatDuration(3_600_000 + 60_000 + 1_000)).toBe("1:01:01"); // 1h 1m 1s
    expect(formatDuration(3_600_000 * 2 + 5 * 60_000)).toBe("2:05:00"); // 2h 5m
  });

  it("zero-pads seconds and minutes under 1 hour", () => {
    expect(formatDuration(5_000)).toBe("0:05");
    expect(formatDuration(65_000)).toBe("1:05");
  });
});

describe("formatResolution", () => {
  it("joins width and height with the multiplication sign", () => {
    expect(formatResolution(1920, 1080)).toBe("1920\u00d71080");
    expect(formatResolution(3840, 2160)).toBe("3840\u00d72160");
  });
});

describe("resolutionBucket", () => {
  it("returns null for null height", () => {
    expect(resolutionBucket(null)).toBeNull();
  });

  it("returns null below the SD floor (480)", () => {
    expect(resolutionBucket(0)).toBeNull();
    expect(resolutionBucket(240)).toBeNull();
    expect(resolutionBucket(359)).toBeNull();
  });

  it("returns '360p' at 360 and through 479", () => {
    expect(resolutionBucket(360)).toBe("360p");
    expect(resolutionBucket(479)).toBe("360p");
  });

  it("returns '480p' (SD) at 480 and through 719", () => {
    expect(resolutionBucket(480)).toBe("480p");
    expect(resolutionBucket(719)).toBe("480p");
  });

  it("returns '720p' (HD) at 720 and through 1079", () => {
    expect(resolutionBucket(720)).toBe("720p");
    expect(resolutionBucket(1080 - 1)).toBe("720p");
  });

  it("returns '1080p' (FHD) at 1080 and through 2159", () => {
    expect(resolutionBucket(1080)).toBe("1080p");
    expect(resolutionBucket(1440)).toBe("1080p");
    expect(resolutionBucket(2159)).toBe("1080p");
  });

  it("returns '4K' at 2160 and above", () => {
    expect(resolutionBucket(2160)).toBe("4K");
    expect(resolutionBucket(4320)).toBe("4K");
  });
});

describe("filenameInitial", () => {
  it("strips the extension and uppercases the first letter", () => {
    expect(filenameInitial("cat.mp4")).toBe("C");
    expect(filenameInitial("Vacation 2024.mov")).toBe("V");
  });

  it("handles names with multiple dots (strips last segment only)", () => {
    expect(filenameInitial("my.video.file.mp4")).toBe("M");
  });

  it("returns '?' for empty names or extension-only names", () => {
    expect(filenameInitial("")).toBe("?");
    expect(filenameInitial(".mp4")).toBe("?");
    expect(filenameInitial("   ")).toBe("?");
  });

  it("preserves non-ASCII first characters", () => {
    expect(filenameInitial("Élégance.mp4")).toBe("É");
  });
});

describe("describeError", () => {
  it("returns the ApiError's message", () => {
    const err = new ApiError(500, "database is locked", { message: "x" });
    expect(describeError(err)).toBe("database is locked");
  });

  it("returns a generic fallback for unknown error shapes", () => {
    expect(describeError(new Error("boom"))).toBe(
      "Something went wrong. Please try again.",
    );
    expect(describeError(null)).toBe("Something went wrong. Please try again.");
    expect(describeError("string error")).toBe(
      "Something went wrong. Please try again.",
    );
  });
});
