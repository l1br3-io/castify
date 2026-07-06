// base64url helpers for the WebAuthn dance.
//
// webauthn-rs serializes binary fields (challenge, user.id, credential ids,
// authenticator data, signatures, …) as base64url *strings* without padding.
// The browser's `navigator.credentials` API wants those same fields as
// BufferSource (Uint8Array), so we round-trip through these two helpers:
//
//   * encode — turns an AuthenticatorResponse's ArrayBuffers into the
//     base64url strings the server expects in `RegisterPublicKeyCredential` /
//     `PublicKeyCredential` request bodies.
//   * decode — turns the server's base64url strings back into Uint8Array
//     before handing the options to `navigator.credentials.create`/`get`.

/**
 * Encode an ArrayBuffer (or Uint8Array view) into an unpadded base64url string.
 */
export function encodeBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // Chunked fromCharCode avoids call-stack limits on large authenticator data.
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode an unpadded (or padded) base64url string into a fresh Uint8Array.
 * Accepts both URL-safe (`-`/`_`) and standard (`+`/`/`) alphabets.
 *
 * The result is always backed by a plain `ArrayBuffer` (not
 * `SharedArrayBuffer`) so it satisfies the DOM `BufferSource` requirements of
 * `navigator.credentials.create` / `.get`.
 */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const standardized = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = standardized.length % 4 === 0 ? "" : "=".repeat(4 - (standardized.length % 4));
  const binary = atob(standardized + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
