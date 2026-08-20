// Login page: password sign-in.
//
// UX flow:
//   Password form → `POST /api/session` → land at `/`. On 401 → "Wrong password."
//
// On success: fetch CSRF token for the new session, invalidate the
// `['session']` query, navigate to `/`.

import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { fetchCsrfToken } from "../api/client";
import { loginPassword } from "../api/session";
import { SESSION_QUERY_KEY } from "../hooks/use-session";
import { useToast } from "../hooks/use-toast";

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

const INPUT_CLASS =
  "w-full rounded-md border border-white/10 bg-[var(--color-castify-canvas)] px-3 py-2 text-sm placeholder:text-white/40 focus:border-[var(--color-castify-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-castify-accent)]";

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const passwordChanged = searchParams.get("password_changed") === "1";

  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const passwordValid =
    password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;

  async function landAtHome(): Promise<void> {
    await fetchCsrfToken();
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    navigate("/", { replace: true });
  }

  const passwordMutation = useMutation({
    mutationFn: () => loginPassword({ display_name: null, password }),
    onSuccess: () => {
      toast.success("Welcome back.");
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

      {passwordChanged && (
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] border border-[var(--color-castify-accent)]/40 bg-[var(--color-castify-accent-subtle)] px-4 py-2.5 text-sm">
          <span>
            Password changed — please sign in with your new password.
          </span>
          <button
            type="button"
            onClick={() => {
              searchParams.delete("password_changed");
              setSearchParams(searchParams, { replace: true });
            }}
            className="shrink-0 opacity-60 transition hover:opacity-100"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <form
        className="space-y-4"
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
          className="w-full rounded-md bg-[var(--color-castify-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {passwordMutation.isPending ? "Signing in…" : "Sign in"}
        </button>
        {passwordError && (
          <p className="text-sm text-red-400">{passwordError}</p>
        )}
      </form>

      <p className="text-xs opacity-60">
        Locked out? Reset your password from the server shell:{" "}
        <code className="rounded bg-[var(--color-castify-muted)]/20 px-1.5 py-0.5 font-mono">
          castify reset-password
        </code>
      </p>
    </section>
  );
}
