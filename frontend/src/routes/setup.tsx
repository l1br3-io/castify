// First-run setup wizard: password enrollment (task 007 restyle).
//
// UX flow:
//   1. Display-name field (1–80 chars, required).
//   2. Password form (8–256 chars): submit → `POST /api/setup` → land at `/`.
//
// The intro states purpose and action in one sentence (spec FR-1.4 —
// this is the identity-establishing screen of the first-run family).
//
// Error surface (spec FR-1.5): the server's validation message on 400;
// otherwise the failure class is named — unreachable server (network) or
// server-side failure. No generic "Something went wrong."
//
// On success: fetch a fresh CSRF token (the new session needs its own),
// invalidate the `['session']` query so the home loader sees the logged-in
// state, then navigate to `/`. The `/setup` route itself has a loader that
// redirects to `/login` if setup is already closed, so we don't need to
// re-check here.
//
// A11y contract: Field wires label + hint + error through
// aria-describedby; the error is assertively announced (role=alert) and
// flags the input aria-invalid. The single primary action ("Create
// account") exposes pending via aria-busy (Button primitive).

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { fetchCsrfToken } from "../api/client";
import { setupPassword } from "../api/setup";
import { SESSION_QUERY_KEY } from "../hooks/use-session";
import { useToast } from "../hooks/use-toast";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/field";

const DISPLAY_NAME_MAX = 80;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

/** FR-1.5: name the problem and the next step, per failure class. */
function describeSetupError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return error.message;
    return "The server couldn't create the account. Try again in a moment.";
  }
  // Fetch-level failure (offline, DNS, refused connection).
  return "Can't reach the server. Check your connection and try again.";
}

export function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
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

  const passwordMutation = useMutation({
    mutationFn: () => setupPassword({ display_name: trimmedName, password }),
    onSuccess: () => {
      toast.success(`Welcome to Castify, ${trimmedName}.`);
      void landAtHome();
    },
    onError: (error: unknown) => {
      setPasswordError(describeSetupError(error));
    },
  });

  return (
    <section className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome to Castify
        </h1>
        <p className="mt-1 text-sm text-[var(--color-castify-muted)]">
          Create your owner account to get started.
        </p>
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setPasswordError(null);
          if (nameValid && passwordValid) {
            passwordMutation.mutate();
          }
        }}
      >
        <Field label="Display name" hint="Up to 80 characters.">
          <Input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={DISPLAY_NAME_MAX}
            placeholder="e.g. Alex"
            autoComplete="name"
          />
        </Field>

        <Field
          label="Password"
          hint={`${PASSWORD_MIN}–${PASSWORD_MAX} characters.`}
          error={passwordError ?? undefined}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            autoComplete="new-password"
          />
        </Field>

        <Button
          type="submit"
          className="w-full"
          disabled={!nameValid || !passwordValid}
          pending={passwordMutation.isPending}
        >
          {passwordMutation.isPending ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </section>
  );
}
