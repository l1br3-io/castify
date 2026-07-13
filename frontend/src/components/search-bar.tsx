// SearchBar — controlled input with debounce-friendly interface (T9).
//
// The parent owns the raw query string and passes it as `value`. The parent
// decides when to debounce (via `useDebouncedValue`) before feeding the
// debounced value into `useVideos`. This keeps the input responsive (updates
// on every keystroke) while the network request only fires after the debounce
// window.
//
// `forwardRef` exposes the `<input>` so the parent can focus it via the `/`
// keyboard shortcut.
//
// Clear button (×): visible when `value` is non-empty; calls `onChange("")`.

import { forwardRef } from "react";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(
  function SearchBar({ value, onChange }, ref) {
    return (
      <div role="search" className="relative">
        {/* Search icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50"
        >
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
            clipRule="evenodd"
          />
        </svg>

        <input
          ref={ref}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Search videos"
          placeholder={"Search videos\u2026"}
          title="Press / to focus"
          className="w-full rounded-md border border-white/15 bg-[var(--color-castify-surface)] py-2 pl-10 pr-9 text-sm transition placeholder:opacity-40 focus:outline-none focus:ring-1 focus:ring-[var(--color-castify-accent)]"
        />

        {/* Clear button */}
        {value !== "" && (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 opacity-50 transition hover:opacity-100"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
              className="h-4 w-4"
            >
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        )}
      </div>
    );
  },
);
