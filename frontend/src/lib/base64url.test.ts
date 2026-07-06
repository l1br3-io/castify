import { describe, it, expect } from "vitest";
import { encodeBase64Url, decodeBase64Url } from "./base64url";

describe("encodeBase64Url", () => {
  it("round-trips an arbitrary byte sequence", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 127]);
    const encoded = encodeBase64Url(bytes);
    const decoded = decodeBase64Url(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it("round-trips an ArrayBuffer view", () => {
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([10, 20, 30, 40]);
    const encoded = encodeBase64Url(buffer);
    const decoded = decodeBase64Url(encoded);
    expect(Array.from(decoded)).toEqual([10, 20, 30, 40]);
  });

  it("produces URL-safe characters and no padding", () => {
    // Bytes that produce `+` and `/` in standard base64.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const encoded = encodeBase64Url(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    // base64url alphabet only.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("matches RFC7515 base64url example vectors", () => {
    // The OWASP/JWS base64url example: 0x66 0x6f 0x6f → "Zm9v" (no padding).
    expect(encodeBase64Url(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe("Zm9v");
  });
});

describe("decodeBase64Url", () => {
  it("decodes an unpadded value", () => {
    expect(Array.from(decodeBase64Url("Zm9v"))).toEqual([0x66, 0x6f, 0x6f]);
  });

  it("decodes a padded value", () => {
    expect(Array.from(decodeBase64Url("Zm9v"))).toEqual([0x66, 0x6f, 0x6f]);
  });

  it("accepts URL-safe alphabet", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const encoded = encodeBase64Url(bytes);
    expect(Array.from(decodeBase64Url(encoded))).toEqual(Array.from(bytes));
  });

  it("round-trips empty input", () => {
    expect(encodeBase64Url(new Uint8Array(0))).toBe("");
    expect(decodeBase64Url("").length).toBe(0);
  });
});
