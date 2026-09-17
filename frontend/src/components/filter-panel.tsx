// FilterPanel — browse filter UI (T10, design-pass §5).
//
// Anatomy:
//   * Top bar (always visible): provider preset chips + "More filters"
//     button with active-count badge.
//   * Active-filter chip strip (always visible): removable pills +
//     "Clear all" — kept from the previous design.
//   * Drawer (slide-over): Duration, Resolution, Minimum rating, Folder,
//     Favorites only. Drawer open/close state persists to localStorage so
//     navigation/refresh no longer collapses the panel (audit §5:
//     "Filter collapse state is ephemeral" — that reset on every URL change
//     was a real UX bug).
//
// All filter groups are single-select (mutually exclusive) — the backend
// predicate for each is single-valued. Provider is single-select because
// the backend `provider` param accepts one value (T3 deviation #10).

import { useEffect, useState } from "react";

import { useConnections } from "../hooks/use-connections";
import { useFolders } from "../hooks/use-folders";
import {
  DURATION_PRESETS,
  RESOLUTION_PRESETS,
  type UseBrowseFiltersResult,
} from "../lib/filter-state";
import { PROVIDER_LABELS, type ProviderKey } from "../api/types";
import { CloseIcon, SlidersIcon } from "./icons";

interface FilterPanelProps {
  filters: UseBrowseFiltersResult;
}

const DRAWER_STORAGE_KEY = "castify-filter-drawer-open";

export function FilterPanel({ filters }: FilterPanelProps) {
  const [isOpen, setIsOpen] = useState(() => {
    try {
      return localStorage.getItem(DRAWER_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  // Persist drawer state so navigation no longer collapses it (audit §5).
  useEffect(() => {
    try {
      localStorage.setItem(DRAWER_STORAGE_KEY, String(isOpen));
    } catch {
      /* localStorage unavailable — keep transient state. */
    }
  }, [isOpen]);

  // Escape closes the drawer.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen]);

  const { values, activeCount, chips, clearAll } = filters;

  const connections = useConnections();
  const connectedProviders: ProviderKey[] = Array.from(
    new Set((connections.data ?? []).map((c) => c.provider)),
  );

  // Count long-tail active filters (everything except provider, which is
  // surfaced inline) to badge the "More filters" button.
  const longTailActiveCount = activeCount - (values.provider ? 1 : 0);

  return (
    <div className="flex flex-col gap-2">
      {/* Top bar — always visible. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Provider preset chips — single-select. */}
        <div
          role="group"
          aria-label="Filter by provider"
          className="flex flex-wrap gap-1.5"
        >
          <PresetButton
            label="All"
            isActive={values.provider === undefined}
            onClick={() => filters.setProvider(undefined)}
          />
          {connectedProviders.map((p) => (
            <PresetButton
              key={p}
              label={PROVIDER_LABELS[p]}
              isActive={values.provider === p}
              onClick={() => filters.setProvider(p)}
            />
          ))}
        </div>

        {/* More filters button — opens the drawer. */}
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          aria-expanded={isOpen}
          aria-controls="filter-drawer"
          className="inline-flex items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-3 py-1.5 text-sm transition hover:bg-[var(--color-castify-accent-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)]"
        >
          <SlidersIcon className="h-4 w-4 opacity-70" />
          <span>More filters</span>
          {longTailActiveCount > 0 && (
            <span
              aria-label={`${longTailActiveCount} active filter${longTailActiveCount === 1 ? "" : "s"}`}
              className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-castify-accent)] px-1.5 text-xs font-semibold text-[var(--color-on-accent)]"
            >
              {longTailActiveCount}
            </span>
          )}
        </button>
      </div>

      {/* Active-filter chip strip — always visible when there are active filters. */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.clear}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--color-castify-rule)] px-2.5 py-1 text-xs font-medium transition hover:bg-[var(--color-castify-accent-subtle)]"
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

      {/* Drawer — slide-over from the right on desktop, bottom sheet on mobile. */}
      {isOpen && (
        <FilterDrawer
          filters={filters}
          values={values}
          onClose={() => setIsOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

function FilterDrawer({
  filters,
  values,
  onClose,
}: {
  filters: UseBrowseFiltersResult;
  values: UseBrowseFiltersResult["values"];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40">
      {/* Backdrop — click closes. */}
      <button
        type="button"
        aria-label="Close filters"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />

      {/* Panel — bottom sheet on mobile, right-side drawer on sm+. */}
      <div
        id="filter-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="More filters"
        className="absolute inset-x-0 bottom-0 max-h-[85vh] w-full overflow-hidden rounded-t-[var(--radius-drawer)] bg-[var(--color-castify-surface)] shadow-2xl sm:inset-x-auto sm:bottom-auto sm:inset-y-0 sm:right-0 sm:max-h-none sm:max-w-md sm:rounded-none sm:rounded-l-[var(--radius-drawer)] flex flex-col"
        style={{ animation: "drawer-in 220ms cubic-bezier(.2,.8,.2,1)" }}
      >
        {/* Drag handle — visual cue for the mobile bottom sheet; harmless
            on desktop where the drawer opens from the side. */}
        <div
          aria-hidden
          className="mx-auto mt-2 h-1 w-10 rounded-full bg-[var(--color-castify-rule)] sm:hidden"
        />
        <div className="flex items-center justify-between border-b border-[var(--color-castify-rule)] px-5 py-4">
          <h2 className="text-lg font-semibold tracking-tight">Filters</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close filters"
            className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] text-[var(--color-castify-muted)] transition hover:bg-[var(--color-castify-accent-subtle)] hover:text-[var(--color-castify-text)]"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
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
                className="h-4 w-4 rounded border-[var(--color-castify-rule)] bg-transparent accent-[var(--color-castify-accent)]"
              />
              <span>Favorites only</span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--color-castify-rule)] px-5 py-4">
          <button
            type="button"
            onClick={filters.clearAll}
            className="text-sm text-[var(--color-castify-accent)] transition hover:opacity-80"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-5 py-2 text-sm font-semibold text-[var(--color-on-accent)] transition hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
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
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-castify-muted)]">
        {label}
      </span>
      <div>{children}</div>
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
            className={isActive ? "preset-active" : "preset-inactive"}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function PresetButton({
  label,
  isActive,
  onClick,
  ariaLabel,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      aria-label={ariaLabel}
      className={isActive ? "preset-active" : "preset-inactive"}
    >
      {label}
    </button>
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
      className="w-full rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-3 py-1.5 text-sm transition hover:bg-[var(--color-castify-accent-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
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
