// Skeleton — theme-aware loading placeholder.
//
// Replaces the ad-hoc `animate-pulse bg-white/5` / `bg-white/10` patterns
// across the app. Uses the accent-subtle token so the shimmer reads as
// on-brand rather than a gray block.

import { type CSSProperties } from "react";

type SkeletonProps = {
  className?: string;
  style?: CSSProperties;
};

export function Skeleton({ className = "", style }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-[var(--radius-button)] bg-[var(--color-castify-rule)] ${className}`}
      style={style}
    />
  );
}
