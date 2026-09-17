// StatusBadge — share status pill (active / expired / revoked). Lifted
// from shares-list.tsx when the manage page became a second consumer.
// Task 017 (Classical AA): tints come from the token pairs — active gets
// the accent-subtle/accent-strong pair (the raw accent fails 4.5:1 on
// paper); expired/revoked are neutral, differentiated by their text.

import type { ShareDto } from "../api/shares";

export function StatusBadge({ status }: { status: ShareDto["status"] }) {
  if (status === "active") {
    return (
      <span className="rounded-[var(--radius-pill)] bg-[var(--color-castify-accent-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--color-castify-accent-strong)]">
        Active
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="rounded-[var(--radius-pill)] border border-[var(--color-castify-rule)] px-2 py-0.5 text-xs font-medium text-[var(--color-castify-muted)]">
        Expired
      </span>
    );
  }
  return (
    <span className="rounded-[var(--radius-pill)] border border-[var(--color-castify-rule)] px-2 py-0.5 text-xs font-medium text-[var(--color-castify-muted)]">
      Revoked
    </span>
  );
}
