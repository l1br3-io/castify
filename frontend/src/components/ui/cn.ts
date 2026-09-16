// Join conditional class names — the codebase avoids clsx/tailwind-merge
// as dependencies; variants + caller classes compose by simple concatenation
// (later classes win only via CSS specificity, not order here, so callers
// passing overrides should rely on distinct utilities).
export function cn(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}
