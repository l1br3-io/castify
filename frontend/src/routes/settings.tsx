// Settings page: change password + transcoding toggle.
//
// Password UX flow:
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
// Draft state is ephemeral React state; nothing persists client-side. The
// shares list moved to its own `/shares` route (task 005, spec D4) — this
// page keeps a pointer link.

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { changePassword } from "../api/session";
import {
  TRANSCODE_SETTINGS_QUERY_KEY,
  fetchTranscodeSettings,
  updateTranscodeSettings,
} from "../api/settings";
import { SESSION_QUERY_KEY } from "../hooks/use-session";

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

const INPUT_CLASS =
  "w-full rounded-md border border-white/10 bg-[var(--color-castify-canvas)] px-3 py-2 text-sm placeholder:text-white/40 focus:border-[var(--color-castify-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-castify-accent)]";

const FIELD_ERROR_CLASS = "text-sm text-red-400";

export function SettingsPage() {
  return (
    <section className="mx-auto max-w-2xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm opacity-70">
          Change your password and playback preferences. Links you've shared
          live on the{" "}
          <Link
            to="/shares"
            className="font-medium text-[var(--color-castify-text)] underline decoration-[var(--color-castify-rule)] underline-offset-4 transition-colors hover:text-[var(--color-castify-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)]"
          >
            Shares
          </Link>{" "}
          page.
        </p>
      </div>

      <section aria-labelledby="password-heading" className="max-w-sm space-y-4">
        <h2 id="password-heading" className="text-lg font-semibold">
          Password
        </h2>
        <p className="text-sm opacity-70">
          All active sessions — including this one — are signed out after a
          change.
        </p>
        <PasswordForm />
      </section>

      <TranscodingSection />
    </section>
  );
}

function TranscodingSection() {
  const queryClient = useQueryClient();
  const [saveError, setSaveError] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: TRANSCODE_SETTINGS_QUERY_KEY,
    queryFn: fetchTranscodeSettings,
  });

  const toggleMutation = useMutation({
    mutationFn: updateTranscodeSettings,
    onMutate: async (enabled) => {
      setSaveError(null);
      await queryClient.cancelQueries({
        queryKey: TRANSCODE_SETTINGS_QUERY_KEY,
      });
      const previous = queryClient.getQueryData(TRANSCODE_SETTINGS_QUERY_KEY);
      queryClient.setQueryData(TRANSCODE_SETTINGS_QUERY_KEY, { enabled });
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      // Revert the optimistic flip — the server remains the authority.
      if (context?.previous !== undefined) {
        queryClient.setQueryData(
          TRANSCODE_SETTINGS_QUERY_KEY,
          context.previous,
        );
      }
      setSaveError("Couldn't save. Try again.");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: TRANSCODE_SETTINGS_QUERY_KEY,
      });
    },
  });

  const enabled = settingsQuery.data?.enabled ?? false;
  const toggleLabel = settingsQuery.isError
    ? "Couldn't load the server setting."
    : "On-the-fly conversion to browser-friendly formats (e.g. MKV). Uses server CPU; cached per video.";

  return (
    <section aria-labelledby="transcoding-heading" className="max-w-sm space-y-4">
      <h2 id="transcoding-heading" className="text-lg font-semibold">
        Transcoding
      </h2>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm opacity-70">{toggleLabel}</p>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="transcoding-heading"
          disabled={!settingsQuery.isSuccess || toggleMutation.isPending}
          onClick={() => toggleMutation.mutate(!enabled)}
          className="relative h-6 w-11 shrink-0 rounded-full border border-white/10 transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--color-castify-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            backgroundColor: enabled
              ? "var(--color-castify-accent)"
              : "var(--color-castify-canvas)",
          }}
        >
          <span
            className="absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-all"
            style={{ left: enabled ? "1.5rem" : "0.125rem" }}
          />
        </button>
      </div>
      {saveError && <p className={FIELD_ERROR_CLASS}>{saveError}</p>}
    </section>
  );
}

function PasswordForm() {
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
        className="w-full rounded-md bg-[var(--color-castify-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--color-on-accent)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {changeMutation.isPending ? "Changing…" : "Change password"}
      </button>
      {formError && <p className={FIELD_ERROR_CLASS}>{formError}</p>}
    </form>
  );
}
