// Login page: password sign-in (task 006 restyle).
//
// UX flow:
//   Password form → `POST /api/session` → land at `/`. On 401 → "Wrong
//   password." with the reset path in the same breath.
//
// Error surface (spec FR-1.5): every message names the problem and the
// next step — wrong password (401), unreachable server (network), or a
// server-side failure (other ApiErrors). No generic "Something went
// wrong."
//
// On success: fetch CSRF token for the new session, invalidate the
// `['session']` query, navigate to `/`.
//
// A11y contract: Field wires label + hint (the 8-character rule that
// gates the submit button) + error through aria-describedby; the error
// is assertively announced (role=alert) and flags the input
// aria-invalid. The submit button exposes its pending state via
// aria-busy (Button primitive).

import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { fetchCsrfToken } from "../api/client";
import { loginPassword } from "../api/session";
import { SESSION_QUERY_KEY } from "../hooks/use-session";
import { useToast } from "../hooks/use-toast";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/field";

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

/** FR-1.5: name the problem and the next step, per failure class. */
function describeLoginError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Wrong password. Try again, or reset it below.";
    }
    return "The server couldn't complete the sign-in. Try again in a moment.";
  }
  // Fetch-level failure (offline, DNS, refused connection).
  return "Can't reach the server. Check your connection and try again.";
}

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
      setPasswordError(describeLoginError(error));
    },
  });

  return (
    <section className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-[var(--color-castify-muted)]">
          Welcome back.
        </p>
      </div>

      {passwordChanged && (
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] border border-[var(--color-castify-accent)]/40 bg-[var(--color-castify-accent-subtle)] px-4 py-2.5 text-sm">
          <span role="status">
            Password changed — please sign in with your new password.
          </span>
          <button
            type="button"
            onClick={() => {
              searchParams.delete("password_changed");
              setSearchParams(searchParams, { replace: true });
            }}
            className="shrink-0 opacity-60 transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)] rounded-[var(--radius-button)]"
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
          setPasswordError(null);
          if (passwordValid) {
            passwordMutation.mutate();
          }
        }}
      >
        <Field
          label="Password"
          hint="At least 8 characters."
          error={passwordError ?? undefined}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            autoComplete="current-password"
          />
        </Field>
        <Button
          type="submit"
          className="w-full"
          disabled={!passwordValid}
          pending={passwordMutation.isPending}
        >
          {passwordMutation.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="text-xs text-[var(--color-castify-muted)]">
        Locked out? Reset your password from the server shell:{" "}
        <code className="rounded bg-[var(--color-castify-muted)]/20 px-1.5 py-0.5 font-mono text-[var(--color-castify-text)]">
          castify reset-password
        </code>
      </p>
    </section>
  );
}
