// SharedChrome — public recipient chrome (FR-5.4, task 018): a minimal,
// clearly-branded "shared link" frame — a keycap chip + the mono wordmark —
// that deliberately does NOT clone the owner app shell (no sidebar, no
// primary nav). Recipients land here from a message, not from an app.
//
// `dark` opts into the colophon ground (`.dark-editorial`, index.css) for
// playback surfaces: share-watch matches the owner watch page's task-012
// treatment, so the player chrome reads identically in both worlds.

import type { ReactNode } from "react";

import { cn } from "./ui/cn";

export function SharedChrome({
  dark = false,
  children,
}: {
  dark?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-h-screen flex-col",
        dark
          ? "dark-editorial"
          : "bg-[var(--color-castify-canvas)] text-[var(--color-castify-text)]",
      )}
    >
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 pt-5">
        <span className="keycap">Shared link</span>
        {/* Copy freeze: DOM text stays `Castify`; lowercase mono wordmark. */}
        <span className="font-mono text-base font-medium lowercase tracking-tight">
          Castify
        </span>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-12 pt-6">
        {children}
      </main>
    </div>
  );
}
