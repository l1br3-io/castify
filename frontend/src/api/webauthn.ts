// WebAuthn (passkey) HTTP calls and browser/server format adapters.
//
// webauthn-rs serializes binary fields (challenges, credential ids,
// authenticator data, signatures) as base64url *strings*. The browser's
// `navigator.credentials` API wants those same fields as `BufferSource`. This
// module owns the translation in both directions:
//
//   * `prepareCreationOptions` / `prepareRequestOptions` — decode the server's
//     base64url strings into Uint8Array fields before handing the options to
//     `navigator.credentials.create` / `.get`.
//   * `serializeCreationCredential` / `serializeAssertionCredential` — encode
//     the browser credential's ArrayBuffers back into the base64url strings
//     that `RegisterPublicKeyCredential` / `PublicKeyCredential` (server-side)
//     deserialize.
//
// The four HTTP functions (`setupWebauthnBegin/Finish`, `loginWebauthnBegin/
// Finish`) speak the JSON shapes documented in the Rust handlers in
// `crates/api/src/routes/{setup_webauthn,session_webauthn}.rs`.

import { apiFetch } from "./client";
import { decodeBase64Url, encodeBase64Url } from "../lib/base64url";
import type { OwnerEnvelope } from "./types";

// ---------------------------------------------------------------------------
// Server response shapes (binary fields are base64url strings here).
// ---------------------------------------------------------------------------

interface ServerPublicKeyCredentialCreationOptions {
  rp: { name: string; id?: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pub_key_cred_params: unknown[];
  timeout?: number;
  exclude_credentials?: { type: string; id: string; transports?: string[] }[];
  authenticator_selection?: unknown;
  attestation?: string;
  extensions?: unknown;
}

interface ServerPublicKeyCredentialRequestOptions {
  challenge: string;
  rp_id?: string;
  timeout?: number;
  allow_credentials?: { type: string; id: string; transports?: string[] }[];
  user_verification?: string;
  extensions?: unknown;
}

interface SetupWebauthnBeginResponse {
  owner_id: string;
  publicKey: ServerPublicKeyCredentialCreationOptions;
}

interface LoginWebauthnBeginResponse {
  auth_request_id: string;
  publicKey: ServerPublicKeyCredentialRequestOptions;
}

// ---------------------------------------------------------------------------
// Serialized credential request bodies (binary fields as base64url strings).
// These match the `RegisterPublicKeyCredential` / `PublicKeyCredential` types
// webauthn-rs deserializes.
// ---------------------------------------------------------------------------

export interface SerializedCreationCredential {
  id: string;
  rawId: string;
  type: string;
  response: {
    attestationObject: string;
    clientDataJSON: string;
  };
  clientExtensionResults: Record<string, unknown>;
}

export interface SerializedAssertionCredential {
  id: string;
  rawId: string;
  type: string;
  response: {
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    userHandle: string | null;
  };
  clientExtensionResults: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Server → browser adapters.
// ---------------------------------------------------------------------------

function decodeAllowCredentials(
  list: { type: string; id: string; transports?: string[] }[] | undefined,
): PublicKeyCredentialDescriptor[] | undefined {
  if (!list) {
    return undefined;
  }
  return list.map((entry) => ({
    type: entry.type as PublicKeyCredentialType,
    id: decodeBase64Url(entry.id),
    transports: entry.transports as AuthenticatorTransport[] | undefined,
  }));
}

/**
 * Adapt the server's `publicKey` (from setup begin) into the shape
 * `navigator.credentials.create({ publicKey })` expects.
 */
export function prepareCreationOptions(
  server: ServerPublicKeyCredentialCreationOptions,
): CredentialCreationOptions {
  return {
    publicKey: {
      rp: server.rp,
      user: {
        ...server.user,
        id: decodeBase64Url(server.user.id),
      },
      challenge: decodeBase64Url(server.challenge),
      pubKeyCredParams: server.pub_key_cred_params as PublicKeyCredentialParameters[],
      timeout: server.timeout,
      excludeCredentials: decodeAllowCredentials(server.exclude_credentials),
      authenticatorSelection: server.authenticator_selection as AuthenticatorSelectionCriteria | undefined,
      attestation: server.attestation as AttestationConveyancePreference | undefined,
      extensions: server.extensions as AuthenticationExtensionsClientInputs | undefined,
    },
  };
}

/**
 * Adapt the server's `publicKey` (from login begin) into the shape
 * `navigator.credentials.get({ publicKey })` expects.
 */
export function prepareRequestOptions(
  server: ServerPublicKeyCredentialRequestOptions,
): CredentialRequestOptions {
  return {
    publicKey: {
      challenge: decodeBase64Url(server.challenge),
      rpId: server.rp_id,
      timeout: server.timeout,
      allowCredentials: decodeAllowCredentials(server.allow_credentials),
      userVerification: server.user_verification as UserVerificationRequirement | undefined,
      extensions: server.extensions as AuthenticationExtensionsClientInputs | undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Browser → server serializers.
// ---------------------------------------------------------------------------

function extensionResults(cred: PublicKeyCredential): Record<string, unknown> {
  const results = cred.getClientExtensionResults();
  // `getClientExtensionResults` returns a Map; plain-object form is what the
  // server deserializes from JSON.
  if (results instanceof Map) {
    return Object.fromEntries(results);
  }
  return results as Record<string, unknown>;
}

/**
 * Serialize the credential returned by `navigator.credentials.create` into the
 * JSON body webauthn-rs's `RegisterPublicKeyCredential` expects.
 */
export function serializeCreationCredential(
  credential: PublicKeyCredential,
): SerializedCreationCredential {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    response: {
      attestationObject: encodeBase64Url(response.attestationObject),
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
    },
    clientExtensionResults: extensionResults(credential),
  };
}

/**
 * Serialize the credential returned by `navigator.credentials.get` into the
 * JSON body webauthn-rs's `PublicKeyCredential` expects.
 */
export function serializeAssertionCredential(
  credential: PublicKeyCredential,
): SerializedAssertionCredential {
  const response = credential.response as AuthenticatorAssertionResponse;
  const userHandle = response.userHandle
    ? encodeBase64Url(response.userHandle)
    : null;
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: encodeBase64Url(response.authenticatorData),
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      signature: encodeBase64Url(response.signature),
      userHandle,
    },
    clientExtensionResults: extensionResults(credential),
  };
}

// ---------------------------------------------------------------------------
// HTTP: setup (first-run) WebAuthn flow.
// ---------------------------------------------------------------------------

export interface SetupWebauthnBeginResult {
  ownerId: string;
  creationOptions: CredentialCreationOptions;
}

/**
 * Begin passkey enrollment during first-run setup.
 * Returns the opaque owner id (echoed back on finish) and the prepared
 * `navigator.credentials.create` options.
 */
export async function setupWebauthnBegin(input: {
  displayName?: string | null;
}): Promise<SetupWebauthnBeginResult> {
  const body = await apiFetch<SetupWebauthnBeginResponse>(
    "/api/setup/webauthn/register/begin",
    {
      method: "POST",
      body: { display_name: input.displayName ?? null },
    },
  );
  return {
    ownerId: body.owner_id,
    creationOptions: prepareCreationOptions(body.publicKey),
  };
}

/**
 * Finish passkey enrollment. Verifies the authenticator response, creates the
 * owner row, and issues a session cookie server-side.
 */
export async function setupWebauthnFinish(
  ownerId: string,
  credential: SerializedCreationCredential,
): Promise<void> {
  await apiFetch<OwnerEnvelope>("/api/setup/webauthn/register/finish", {
    method: "POST",
    body: { owner_id: ownerId, credential },
  });
}

// ---------------------------------------------------------------------------
// HTTP: login (returning-user) WebAuthn flow.
// ---------------------------------------------------------------------------

export interface LoginWebauthnBeginResult {
  authRequestId: string;
  requestOptions: CredentialRequestOptions;
}

/**
 * Begin passkey authentication. Returns the opaque `auth_request_id` (echoed
 * back on finish) and the prepared `navigator.credentials.get` options.
 */
export async function loginWebauthnBegin(): Promise<LoginWebauthnBeginResult> {
  const body = await apiFetch<LoginWebauthnBeginResponse>(
    "/api/session/webauthn/begin",
    { method: "POST" },
  );
  return {
    authRequestId: body.auth_request_id,
    requestOptions: prepareRequestOptions(body.publicKey),
  };
}

/**
 * Finish passkey authentication. On success the server issues a session
 * cookie.
 */
export async function loginWebauthnFinish(
  authRequestId: string,
  credential: SerializedAssertionCredential,
): Promise<void> {
  await apiFetch<OwnerEnvelope>("/api/session/webauthn/finish", {
    method: "POST",
    body: { auth_request_id: authRequestId, credential },
  });
}
