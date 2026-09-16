// EmptyState — shared "no data" surface.
//
// Replaces the bespoke empty boxes scattered across the app (library-empty,
// filter-empty, search-empty, no-connections). Props drive title, body, an
// optional CTA, and an optional illustration slot (kept unused for now —
// the design pass uses type + spacing + CTA rather than custom illustration).
//
// Voice (design-pass §8): sentence case, verb-led CTA, second-person,
// no exclamation marks. Caller supplies the strings.

import { type ReactNode } from "react";

import { Button } from "./button";

type EmptyStateProps = {
  title: string;
  body?: string;
  onAction?: () => void;
  actionLabel?: string;
  illustration?: ReactNode;
  /** Compact variant for inline use (shelves, small panels). Defaults to false. */
  compact?: boolean;
};

export function EmptyState({
  title,
  body,
  onAction,
  actionLabel,
  illustration,
  compact = false,
}: EmptyStateProps) {
  const padding = compact ? "p-6" : "p-8 sm:p-12";
  const titleSize = compact ? "text-base" : "text-lg";
  const bodySize = compact ? "text-xs" : "text-sm";

  return (
    <div
      className={`rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] ${padding} text-center`}
    >
      {illustration && (
        <div className="mb-4 flex justify-center" aria-hidden>
          {illustration}
        </div>
      )}
      <p className={`font-medium ${titleSize}`}>{title}</p>
      {body && (
        <p className={`mx-auto mt-2 max-w-sm opacity-70 ${bodySize}`}>{body}</p>
      )}
      {onAction && actionLabel && (
        <div className="mt-5 flex justify-center">
          <Button onClick={onAction}>{actionLabel}</Button>
        </div>
      )}
    </div>
  );
}
