// Kind → hue utilities for the file-kind taxonomy (library-list-view task
// 005; extracted from file-card.tsx so the react-refresh boundary stays
// components-only there). Static literal strings (one per kind) so the
// Tailwind scanner emits every arbitrary value; per-theme resolution
// comes free from the `--color-kind-*` token cascade (dark/light, Task
// 001). Kind color appears only as icon tint + 4px bar — never a fill.

import type { FileKindKey } from "../api/types";

export const KIND_HUES: Record<FileKindKey, { icon: string; tab: string }> = {
  audio: { icon: "text-[var(--color-kind-audio)]", tab: "bg-[var(--color-kind-audio)]" },
  image: { icon: "text-[var(--color-kind-image)]", tab: "bg-[var(--color-kind-image)]" },
  subtitle: { icon: "text-[var(--color-kind-subtitle)]", tab: "bg-[var(--color-kind-subtitle)]" },
  document: { icon: "text-[var(--color-kind-document)]", tab: "bg-[var(--color-kind-document)]" },
  archive: { icon: "text-[var(--color-kind-archive)]", tab: "bg-[var(--color-kind-archive)]" },
  other: { icon: "text-[var(--color-kind-other)]", tab: "bg-[var(--color-kind-other)]" },
};
