// `useDebouncedValue` — returns a value that only updates after `delayMs` has
// elapsed without the source value changing. Used by T9 search to avoid firing
// a network request on every keystroke.

import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
