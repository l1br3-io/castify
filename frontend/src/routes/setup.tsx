// First-run setup wizard: passkey primary, password fallback.
//
// UX flow (per `tasks/plan.md` §"/setup"):
//   1. Shared display-name field (1–80 chars, required).
//   2. Primary CTA — "Set up with passkey": begin → navigator.credentials.create
//      → finish → land at `/`.
//   3. Secondary — disclosure revealing the password form (8–256 chars):
//      submit → `POST /api/setup` → land at `/`.
//
// On any success: fetch a fresh CSRF token (the new session needs its own),
// invalidate the `['session']` query so the home loader sees the logged-in
// state, then navigate to `/`. The `/setup` route itself has a loader that
// redirects to `/login` if setup is already closed, so we don't need to
// re-check here.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { fetchCsrfToken } from "../api/csrf";
import { setupPassword } from "../api/setup";
import {
  serializeCreationCredential,
  setupWebauthnBegin,
  setupWebauthnFinish,
} from "../api/webauthn";
import { SESSION_QUERY_KEY } from "../hooks/use-session";

const DISPLAY_NAME_MAX = 80;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

const INPUT_CLASS =
  "w-full rounded-md border border-white/10 bg-[var(--color-castify-canvas)] px-3 py-2 text-sm placeholder:text-white/40 focus:border-[var(--color-castify-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-castify-accent)]";

export function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const trimmedName = displayName.trim();
  const nameValid =
    trimmedName.length >= 1 && trimmedName.length <= DISPLAY_NAME_MAX;
  const passwordValid =
    password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;

  async function landAtHome(): Promise<void> {
    await fetchCsrfToken();
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    navigate("/", { replace: true });
  }

  const passkeyMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      setPasskeyError(null);
      const { ownerId, creationOptions } = await setupWebauthnBegin({
        displayName: trimmedName,
      });
      const credential = await navigator.credentials.create(creationOptions);
      if (!credential) {
        throw new Error("Passkey creation was cancelled");
      }
      const serialized = serializeCreationCredential(
        credential as PublicKeyCredential,
      );
      await setupWebauthnFinish(ownerId, serialized);
    },
    onSuccess: () => {
      void landAtHome();
    },
    onError: (error: unknown) => {
      // User dismissed the authenticator prompt — silently reset, no error.
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setPasskeyError(
        "Passkey setup didn't work. Try again or use a password.",
      );
    },
  });

  const passwordMutation = useMutation({
    mutationFn: () =>
      setupPassword({ display_name: trimmedName, password }),
    onSuccess: () => {
      void landAtHome();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.status === 400) {
        setPasswordError(error.message);
      } else {
        setPasswordError("Something went wrong. Please try again.");
      }
    },
  });

  return (
    <section className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome to Castify
        </h1>
        <p className="mt-1 text-sm opacity-70">
          Create your owner account to get started.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="display-name" className="text-sm font-medium">
          Display name
        </label>
        <input
          id="display-name"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={DISPLAY_NAME_MAX}
          placeholder="e.g. Alex"
          autoComplete="name"
          className={INPUT_CLASS}
        />
      </div>

      <div className="space-y-2">
        <button
          type="button"
          disabled={!nameValid || passkeyMutation.isPending}
          onClick={() => passkeyMutation.mutate()}
          className="w-full rounded-md bg-[var(--color-castify-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {passkeyMutation.isPending
            ? "Creating passkey…"
            : "Set up with passkey"}
        </button>
        {passkeyError && <p className="text-sm text-red-400">{passkeyError}</p>}
      </div>

      <details className="space-y-4">
        <summary className="cursor-pointer text-sm opacity-70 hover:opacity-100">
          Prefer a password?
        </summary>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (nameValid && passwordValid) {
              passwordMutation.mutate();
            }
          }}
        >
          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              autoComplete="new-password"
              className={INPUT_CLASS}
            />
            <p className="text-xs opacity-50">
              {PASSWORD_MIN}–{PASSWORD_MAX} characters.
            </p>
          </div>
          <button
            type="submit"
            disabled={
              !nameValid || !passwordValid || passwordMutation.isPending
            }
            className="w-full rounded-md border border-white/15 px-4 py-2 text-sm font-medium transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {passwordMutation.isPending
              ? "Creating account…"
              : "Create with password"}
          </button>
          {passwordError && (
            <p className="text-sm text-red-400">{passwordError}</p>
          )}
        </form>
      </details>
    </section>
  );
}
