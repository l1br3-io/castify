// Inline SVG icon primitives. No icon library is used (zero new deps).
//
// Both icons render with `currentColor` so callers control hue via the
// `text-*` Tailwind utilities on the parent. The `filled` prop switches
// between solid (`fill="currentColor"`) and outline (`fill="none"` with a
// stroked path) — sized via the parent's `h-*` / `w-*` (the svg itself is
// `h-full w-full`).
//
// ESLint `react-refresh/only-export-components` requires this file to
// export *only* components — no helpers alongside (deviation #43 lesson).

type IconProps = {
  filled: boolean;
  className?: string;
};

/** Heart icon — favorite indicator. */
export function HeartIcon({ filled, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

/** Star icon — rating unit. */
export function StarIcon({ filled, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}
