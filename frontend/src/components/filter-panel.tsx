// FilterPanel — collapsible browse filter controls (T10).
//
// Lives in the grid-section header next to the Sort dropdown. Receives the
// full `useBrowseFilters()` result as props so the panel is purely
// presentational over URL state. Connected-provider + folder option lists
// come from `useConnections` / `useFolders` (TanStack Query dedupes the cache,
// so calling them here + in BrowsePage's shelves is one network request each).
//
// Layout:
//   [⚙ Filters] (3)                        ← toggle (always visible)
//   ┌──────── expanded body ────────┐
//   │ Provider:   [All] [GD] [DB] … │
//   │ Duration:   [All] [<5m] [5–30m]│
//   │ Resolution: [All] [SD+] [HD+] │
//   │ Min rating: [Any] [1★+] …     │
//   │ Folder:     [ dropdown ▾ ]     │
//   │ [♡ Favorites only]             │
//   └────────────────────────────────┘
//   [chip ×] [chip ×] …   [Clear all]     ← chips (always visible)
//
// All filter groups are single-select (mutually exclusive) — the backend
// predicate for each is single-valued. Provider is single-select because the
// backend `provider` param accepts one value (T3 deviation #10); the plan's
// "checkbox list" would require backend changes for multi-select OR.

import { useState } from "react";

import { useConnections } from "../hooks/use-connections";
import { useFolders } from "../hooks/use-folders";
import {
  DURATION_PRESETS,
  RESOLUTION_PRESETS,
  type UseBrowseFiltersResult,
} from "../lib/filter-state";
import { PROVIDER_LABELS, type ProviderKey } from "../api/types";

interface FilterPanelProps {
  filters: UseBrowseFiltersResult;
}

export function FilterPanel({ filters }: FilterPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { values, activeCount, chips, clearAll } = filters;

  // Connected providers drive the Provider option list. TanStack Query dedupes
  // with BrowsePage's useConnections call — one network request.
  const connections = useConnections();
  const connectedProviders: ProviderKey[] = Array.from(
    new Set((connections.data ?? []).map((c) => c.provider)),
  );

  return (
    <div className="space-y-2">
      {/* Toggle row — always visible */}
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
        aria-controls="filter-panel-body"
        className="inline-flex items-center gap-2 rounded-md border border-white/15 bg-[var(--color-castify-surface)] px-3 py-1.5 text-sm transition hover:bg-white/5 focus:outline-none focus:ring-1 focus:ring-[var(--color-castify-accent)]"
      >
        <FilterIcon />
        <span>Filters</span>
        {activeCount > 0 && (
          <span
            aria-label={`${activeCount} active filter${activeCount === 1 ? "" : "s"}`}
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-castify-accent)] px-1.5 text-xs font-semibold text-[var(--color-castify-canvas)]"
          >
            {activeCount}
          </span>
        )}
      </button>

      {/* Expanded body */}
      {isOpen && (
        <div
          id="filter-panel-body"
          className="space-y-4 rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-4"
        >
          <FilterRow label="Provider">
            <PresetButtons
              ariaLabel="Filter by provider"
              options={[
                { value: undefined, label: "All" },
                ...connectedProviders.map((p) => ({
                  value: p,
                  label: PROVIDER_LABELS[p],
                })),
              ]}
              activeValue={values.provider}
              onSelect={(v) => filters.setProvider(v)}
            />
          </FilterRow>

          <FilterRow label="Duration">
            <PresetButtons
              ariaLabel="Filter by duration"
              options={[
                { value: undefined, label: "All" },
                ...DURATION_PRESETS.map((p) => ({
                  value: p.key,
                  label: p.label,
                })),
              ]}
              activeValue={values.durationKey}
              onSelect={(v) => filters.setDurationKey(v)}
            />
          </FilterRow>

          <FilterRow label="Resolution">
            <PresetButtons
              ariaLabel="Filter by resolution"
              options={[
                { value: undefined, label: "All" },
                ...RESOLUTION_PRESETS.map((p) => ({
                  value: p.key,
                  label: p.label,
                })),
              ]}
              activeValue={values.resolutionKey}
              onSelect={(v) => filters.setResolutionKey(v)}
            />
          </FilterRow>

          <FilterRow label="Minimum rating">
            <PresetButtons
              ariaLabel="Filter by minimum rating"
              options={[
                { value: undefined, label: "Any" },
                { value: "1", label: "1\u2605+" },
                { value: "2", label: "2\u2605+" },
                { value: "3", label: "3\u2605+" },
                { value: "4", label: "4\u2605+" },
                { value: "5", label: "5\u2605+" },
              ]}
              activeValue={
                values.minRating !== undefined
                  ? String(values.minRating)
                  : undefined
              }
              onSelect={(v) =>
                filters.setMinRating(v !== undefined ? Number(v) : undefined)
              }
            />
          </FilterRow>

          <FilterRow label="Folder">
            <FolderSelect
              activeFolder={values.folder}
              onSelect={(v) => filters.setFolder(v)}
            />
          </FilterRow>

          <div>
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.favoritesOnly}
                onChange={(e) => filters.setFavoritesOnly(e.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-transparent accent-[var(--color-castify-accent)]"
              />
              <span>Favorites only</span>
            </label>
          </div>
        </div>
      )}

      {/* Chip strip — always visible when there are active filters */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.clear}
              className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium transition hover:bg-white/20"
            >
              <span>{chip.label}</span>
              <span aria-hidden className="opacity-60">
                {"\u00d7"}
              </span>
              <span className="sr-only">Remove {chip.label} filter</span>
            </button>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="text-xs text-[var(--color-castify-accent)] transition hover:opacity-80"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <span className="w-28 shrink-0 text-xs font-medium uppercase tracking-wide opacity-50">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

interface PresetOption {
  value: string | undefined;
  label: string;
}

function PresetButtons({
  options,
  activeValue,
  onSelect,
  ariaLabel,
}: {
  options: PresetOption[];
  activeValue: string | undefined;
  onSelect: (value: string | undefined) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const isActive =
          (opt.value ?? undefined) === (activeValue ?? undefined);
        return (
          <button
            key={opt.label}
            type="button"
            onClick={() => onSelect(opt.value)}
            aria-pressed={isActive}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
              isActive
                ? "border-[var(--color-castify-accent)] bg-[var(--color-castify-accent)]/20 text-[var(--color-castify-accent)]"
                : "border-white/15 text-white/70 hover:bg-white/5 hover:text-white"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function FolderSelect({
  activeFolder,
  onSelect,
}: {
  activeFolder: string | undefined;
  onSelect: (value: string | undefined) => void;
}) {
  const folders = useFolders();
  const folderList = folders.data ?? [];

  return (
    <select
      aria-label="Filter by folder"
      value={activeFolder ?? ""}
      onChange={(e) =>
        onSelect(e.target.value === "" ? undefined : e.target.value)
      }
      className="rounded-md border border-white/15 bg-[var(--color-castify-surface)] px-3 py-1.5 text-sm transition hover:bg-white/5 focus:outline-none focus:ring-1 focus:ring-[var(--color-castify-accent)]"
    >
      <option value="">All folders</option>
      {folderList.map((f) => (
        <option key={f.folder} value={f.folder}>
          {f.folder} ({f.video_count})
        </option>
      ))}
    </select>
  );
}

function FilterIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className="h-4 w-4 opacity-70"
    >
      <path
        fillRule="evenodd"
        d="M2.628 1.604C3.205 1.06 3.978 1 4.5 1h11c.522 0 1.295.06 1.872.604.583.55.62 1.28.585 1.82a17.54 17.54 0 01-.032.386L16.18 6.1c-.07.84-.386 1.617-.898 2.208L11.78 12.21a1.6 1.6 0 00-.386 1.05v3.74a1.6 1.6 0 01-.748 1.353l-2 1.25A1.6 1.6 0 016 18.565v-4.304a1.6 1.6 0 00-.386-1.05L2.848 9.848l-.001-.001A3.575 3.575 0 011.872 7.5L1.604 4.39l-.024-.27-.005-.078a2.41 2.41 0 01.397-1.498 2.27 2.27 0 01.656-.656l-.014-.01z"
        clipRule="evenodd"
      />
    </svg>
  );
}
