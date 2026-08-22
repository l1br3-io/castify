// Settings page: change password.
//
// UX flow:
//   Three-field form (current, new, confirm) → `PUT /api/session/password`.
//   On 204 the server has revoked every session, so the app mirrors the
//   sign-out pattern: the `['session']` cache is set to `null` and the user
//   lands on `/login?password_changed=1` with a notice.
//
// Error surface (per spec): field-level for client-side validation (confirm
// mismatch, the mirrored 8..=256 rule), form-level generic message for a
// wrong current password (401) and server validation failures (400) — the
// server remains the authority.
//
// Draft state is ephemeral React state; nothing persists client-side.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { changePassword } from "../api/session";
import { SESSION_QUERY_KEY } from "../hooks/use-session";

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

const INPUT_CLASS =
  "w-full rounded-md border border-white/10 bg-[var(--color-castify-canvas)] px-3 py-2 text-sm placeholder:text-white/40 focus:border-[var(--color-castify-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-castify-accent)]";

const FIELD_ERROR_CLASS = "text-sm text-red-400";

export function SettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showFieldErrors, setShowFieldErrors] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const newPasswordValid =
    newPassword.length >= PASSWORD_MIN && newPassword.length <= PASSWORD_MAX;
  const confirmMatches =
    confirmPassword.length > 0 && newPassword === confirmPassword;
  const canSubmit =
    currentPassword.length > 0 && newPasswordValid && confirmMatches;

  const changeMutation = useMutation({
    mutationFn: () =>
      changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    onSuccess: () => {
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      navigate("/login?password_changed=1", { replace: true });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        setFormError("Wrong password.");
      } else if (error instanceof ApiError && error.status === 400) {
        setFormError(error.message);
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    },
  });

  return (
    <section className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm opacity-70">
          Change your password. All active sessions — including this one —
          are signed out afterwards.
        </p>
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setFormError(null);
          if (canSubmit) {
            changeMutation.mutate();
          } else {
            setShowFieldErrors(true);
          }
        }}
      >
        <div className="space-y-2">
          <label htmlFor="current-password" className="text-sm font-medium">
            Current password
          </label>
          <input
            id="current-password"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            autoComplete="current-password"
            className={INPUT_CLASS}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="new-password" className="text-sm font-medium">
            New password
          </label>
          <input
            id="new-password"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            autoComplete="new-password"
            className={INPUT_CLASS}
          />
          {showFieldErrors && !newPasswordValid && (
            <p className={FIELD_ERROR_CLASS}>
              Password must be {PASSWORD_MIN}–{PASSWORD_MAX} characters.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <label htmlFor="confirm-password" className="text-sm font-medium">
            Confirm new password
          </label>
          <input
            id="confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            className={INPUT_CLASS}
          />
          {showFieldErrors && !confirmMatches && (
            <p className={FIELD_ERROR_CLASS}>Passwords do not match.</p>
          )}
        </div>
        <button
          type="submit"
          disabled={changeMutation.isPending}
          className="w-full rounded-md bg-[var(--color-castify-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {changeMutation.isPending ? "Changing…" : "Change password"}
        </button>
        {formError && <p className={FIELD_ERROR_CLASS}>{formError}</p>}
      </form>
    </section>
  );
}
