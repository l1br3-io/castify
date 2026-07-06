// Login page: passkey primary, password fallback.
//
// UX flow (per `tasks/plan.md` §"/login"):
//   1. Primary CTA — "Sign in with passkey": begin → navigator.credentials.get
//      → finish → land at `/`. If begin returns 404 (no passkey registered),
//      disable the button and show helper text directing to password.
//   2. Secondary — disclosure revealing the password form. On 401 → "Wrong
//      password."
//
// On any success: fetch CSRF token for the new session, invalidate the
// `['session']` query, navigate to `/`.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { fetchCsrfToken } from "../api/csrf";
import { loginPassword } from "../api/session";
import {
  loginWebauthnBegin,
  loginWebauthnFinish,
  serializeAssertionCredential,
} from "../api/webauthn";
import { SESSION_QUERY_KEY } from "../hooks/use-session";

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

const INPUT_CLASS =
  "w-full rounded-md border border-white/10 bg-[var(--color-castify-canvas)] px-3 py-2 text-sm placeholder:text-white/40 focus:border-[var(--color-castify-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-castify-accent)]";

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [password, setPassword] = useState("");
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyUnavailable, setPasskeyUnavailable] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

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
      const { authRequestId, requestOptions } = await loginWebauthnBegin();
      const credential = await navigator.credentials.get(requestOptions);
      if (!credential) {
        throw new Error("Passkey authentication was cancelled");
      }
      const serialized = serializeAssertionCredential(
        credential as PublicKeyCredential,
      );
      await loginWebauthnFinish(authRequestId, serialized);
    },
    onSuccess: () => {
      void landAtHome();
    },
    onError: (error: unknown) => {
      // No passkey registered — permanently disable the button for this view.
      if (error instanceof ApiError && error.status === 404) {
        setPasskeyUnavailable(true);
        return;
      }
      // User dismissed the authenticator prompt — silently reset.
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setPasskeyError(
        "Passkey sign-in didn't work. Try again or use your password.",
      );
    },
  });

  const passwordMutation = useMutation({
    mutationFn: () => loginPassword({ display_name: null, password }),
    onSuccess: () => {
      void landAtHome();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        setPasswordError("Wrong password.");
      } else {
        setPasswordError("Something went wrong. Please try again.");
      }
    },
  });

  return (
    <section className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm opacity-70">Welcome back.</p>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          disabled={passkeyUnavailable || passkeyMutation.isPending}
          onClick={() => passkeyMutation.mutate()}
          className="w-full rounded-md bg-[var(--color-castify-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {passkeyMutation.isPending
            ? "Asking for passkey…"
            : "Sign in with passkey"}
        </button>
        {passkeyUnavailable && (
          <p className="text-sm opacity-60">
            No passkey registered — use your password.
          </p>
        )}
        {passkeyError && (
          <p className="text-sm text-red-400">{passkeyError}</p>
        )}
      </div>

      <details className="space-y-4">
        <summary className="cursor-pointer text-sm opacity-70 hover:opacity-100">
          Prefer a password?
        </summary>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (passwordValid) {
              passwordMutation.mutate();
            }
          }}
        >
          <div className="space-y-2">
            <label htmlFor="login-password" className="text-sm font-medium">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              autoComplete="current-password"
              className={INPUT_CLASS}
            />
          </div>
          <button
            type="submit"
            disabled={!passwordValid || passwordMutation.isPending}
            className="w-full rounded-md border border-white/15 px-4 py-2 text-sm font-medium transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {passwordMutation.isPending
              ? "Signing in…"
              : "Sign in with password"}
          </button>
          {passwordError && (
            <p className="text-sm text-red-400">{passwordError}</p>
          )}
        </form>
      </details>
    </section>
  );
}
