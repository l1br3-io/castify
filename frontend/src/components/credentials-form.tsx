// Schema-driven credentials form for credentials-flow providers
// (S3-compatible storage). Renders whatever `CredentialsSchema` the
// backend returned — no provider-specific branches: a schema with new
// fields (or a whole new credentials provider) needs zero changes here.
//
// Submit posts the field values to `POST /api/connections/{provider}`;
// secrets are masked with a per-field reveal toggle and never rendered
// back after submit (values are cleared on success, and the card flips to
// its connected state once the refreshed list arrives). A failed verify
// surfaces the backend's actionable message framed by what failed —
// verification (fix the values) vs. the network (check the connection) —
// per spec FR-2.2; no connection row is persisted on failure, so the form
// stays up for correction.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { connectWithCredentials } from "../api/connections";
import { AVAILABLE_PROVIDERS_QUERY_KEY } from "../hooks/use-available-providers";
import { CONNECTIONS_QUERY_KEY } from "../hooks/use-connections";
import { VIDEOS_QUERY_KEY } from "../hooks/use-videos";
import { FOLDER_TREE_QUERY_KEY } from "../hooks/use-folder-tree";
import { FOLDER_CONTENTS_QUERY_KEY } from "../hooks/use-folder-contents";
import { useToast } from "../hooks/use-toast";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/field";
import {
  PROVIDER_LABELS,
  type CredentialsSchemaDto,
  type ProviderKey,
} from "../api/types";

/** FR-2.2: say what failed and the recovery path, per failure class. */
function describeConnectFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return `Verification failed: ${error.message}`;
  }
  // Fetch-level failure (offline, DNS, refused connection).
  return "Can't reach the server. Check your connection and try again.";
}

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
        const isRevealed = revealed[field.key] ?? false;
        return (
          <Field key={field.key} label={field.label}>
            <div className="flex gap-2">
              <Input
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
                  className="shrink-0 rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-2 text-xs transition hover:bg-[var(--color-castify-accent-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)]"
                >
                  {isRevealed ? "Hide" : "Show"}
                </button>
              )}
            </div>
          </Field>
        );
      })}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" pending={connect.isPending}>
          {connect.isPending ? "Verifying…" : "Connect"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onCancel}
          disabled={connect.isPending}
        >
          Cancel
        </Button>
      </div>
      {connect.isError && (
        <p
          role="alert"
          className="text-xs text-[var(--color-danger)]"
        >
          {describeConnectFailure(connect.error)}
        </p>
      )}
    </form>
  );
}
