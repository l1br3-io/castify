// StatusBadge — share status pill (active / expired / revoked). Lifted
// from shares-list.tsx when the manage page became a second consumer.

import type { ShareDto } from "../api/shares";

export function StatusBadge({ status }: { status: ShareDto["status"] }) {
  if (status === "active") {
    return (
      <span className="rounded-full bg-[var(--color-castify-accent)]/20 px-2 py-0.5 text-xs font-medium text-[var(--color-castify-accent)]">
        Active
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="rounded-full bg-[var(--color-castify-rule)] px-2 py-0.5 text-xs font-medium opacity-70">
        Expired
      </span>
    );
  }
  return (
    <span className="rounded-full bg-[var(--color-castify-accent-dim)]/20 px-2 py-0.5 text-xs font-medium text-[var(--color-castify-accent-dim)]">
      Revoked
    </span>
  );
}
