// Schema-driven credentials form for credentials-flow providers
// (S3-compatible storage). Renders whatever `CredentialsSchema` the
// backend returned — no provider-specific branches: a schema with new
// fields (or a whole new credentials provider) needs zero changes here.
//
// Submit posts the field values to `POST /api/connections/{provider}`;
// secrets are masked with a per-field reveal toggle and never rendered
// back after submit (values are cleared on success, and the card flips to
// its connected state once the refreshed list arrives). A failed verify
// surfaces the backend's actionable message inline — no connection row is
// persisted on failure, so the form stays up for correction.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { connectWithCredentials } from "../api/connections";
import { AVAILABLE_PROVIDERS_QUERY_KEY } from "../hooks/use-available-providers";
import { CONNECTIONS_QUERY_KEY } from "../hooks/use-connections";
import { VIDEOS_QUERY_KEY } from "../hooks/use-videos";
import { FOLDER_TREE_QUERY_KEY } from "../hooks/use-folder-tree";
import { FOLDER_CONTENTS_QUERY_KEY } from "../hooks/use-folder-contents";
import { useToast } from "../hooks/use-toast";
import { describeError } from "../lib/format";
import {
  PROVIDER_LABELS,
  type CredentialsSchemaDto,
  type ProviderKey,
} from "../api/types";

const INPUT_CLASS =
  "w-full min-w-0 flex-1 rounded-md border border-white/10 bg-[var(--color-castify-canvas)] px-3 py-2 text-sm placeholder:text-white/40 focus:border-[var(--color-castify-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-castify-accent)]";

type Props = {
  provider: ProviderKey;
  schema: CredentialsSchemaDto;
  onCancel: () => void;
};

export function CredentialsForm({ provider, schema, onCancel }: Props) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(schema.fields.map((field) => [field.key, ""])),
  );
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const connect = useMutation({
    mutationFn: () => connectWithCredentials(provider, values),
    onSuccess: () => {
      // Secrets never render back after submit — clear every field the
      // moment the connection is accepted (the card then flips to its
      // connected state via the refreshed list).
      setValues(Object.fromEntries(schema.fields.map((field) => [field.key, ""])));
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: AVAILABLE_PROVIDERS_QUERY_KEY,
      });
      // The initial scan will populate videos and folder paths — the
      // browse caches must not serve the pre-connect (empty) state for
      // their staleTime window.
      void queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: FOLDER_TREE_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: FOLDER_CONTENTS_QUERY_KEY,
      });
      toast.info(`${PROVIDER_LABELS[provider]} connected. Scanning for media…`);
    },
  });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        connect.mutate();
      }}
    >
      {schema.fields.map((field) => {
        const inputId = `cred-${provider}-${field.key}`;
        const isRevealed = revealed[field.key] ?? false;
        return (
          <div key={field.key} className="space-y-1">
            <label htmlFor={inputId} className="text-sm font-medium">
              {field.label}
            </label>
            <div className="flex gap-2">
              <input
                id={inputId}
                type={field.secret && !isRevealed ? "password" : "text"}
                value={values[field.key] ?? ""}
                onChange={(e) =>
                  setValues((prev) => ({
                    ...prev,
                    [field.key]: e.target.value,
                  }))
                }
                placeholder={field.placeholder ?? undefined}
                autoComplete={field.secret ? "new-password" : "off"}
                className={INPUT_CLASS}
              />
              {field.secret && (
                <button
                  type="button"
                  onClick={() =>
                    setRevealed((prev) => ({
                      ...prev,
                      [field.key]: !isRevealed,
                    }))
                  }
                  aria-label={`${isRevealed ? "Hide" : "Show"} ${field.label}`}
                  className="shrink-0 rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-2 text-xs transition hover:bg-[var(--color-castify-accent-subtle)]"
                >
                  {isRevealed ? "Hide" : "Show"}
                </button>
              )}
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={connect.isPending}
          className="rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 disabled:opacity-50"
        >
          {connect.isPending ? "Verifying…" : "Connect"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={connect.isPending}
          className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-3 py-2 text-sm transition hover:bg-[var(--color-castify-accent-subtle)] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {connect.isError && (
        <p className="text-xs text-[var(--color-castify-accent-dim)]">
          {describeError(connect.error)}
        </p>
      )}
    </form>
  );
}
