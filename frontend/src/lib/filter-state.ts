// Browse filter state — URL ↔ typed-value encoding/decoding (T10).
//
// The browse page's filter + sort + search state lives entirely in URL search
// params so every view is deep-linkable and survives refresh. This module
// owns:
//
//   * The preset tables for duration + resolution (mutually-exclusive
//     single-select groups). Preset *keys* ("short", "hd", …) are stored in
//     the URL rather than raw min/max values — more readable + shareable.
//   * `useBrowseFilters()` — a hook wrapping `useSearchParams` that exposes
//     typed getters, setters, an expanded `params` object shaped for
//     `useVideos`, an active-chip list, and a `clearAll` helper.
//
// URL param schema:
//   q              search query (synced from BrowsePage's debounced input)
//   sort           VideoSortKey
//   provider       ProviderKey (single — backend predicate is single-valued)
//   folder         top-level folder name
//   favorites_only "true" when active (absent = off)
//   duration       "short" | "medium" | "long" (absent = All)
//   resolution     "sd" | "hd" | "fhd" | "4k" (absent = All)
//   min_rating     "1".."5" (absent = off)
//
// `page` is intentionally NOT in the URL — deep-linking to page N is fragile
// (library churn shifts content across pages). It resets to 1 on any filter
// change (handled in BrowsePage via a filter-key effect).

import { useSearchParams } from "react-router-dom";

import {
  PROVIDER_LABELS,
  type VideoSortKey,
} from "../api/types";

// ---------------------------------------------------------------------------
// Duration presets (single-select, mutually exclusive)
// ---------------------------------------------------------------------------

export type DurationPresetKey = "short" | "medium" | "long";

export interface DurationPreset {
  key: DurationPresetKey;
  label: string;
  min?: number;
  max?: number;
}

export const DURATION_PRESETS: DurationPreset[] = [
  { key: "short", label: "< 5 min", max: 300_000 },
  { key: "medium", label: "5–30 min", min: 300_000, max: 1_800_000 },
  { key: "long", label: "> 30 min", min: 1_800_000 },
];

export function findDurationPreset(
  key: string | null | undefined,
): DurationPreset | undefined {
  if (!key) return undefined;
  return DURATION_PRESETS.find((p) => p.key === key);
}

// ---------------------------------------------------------------------------
// Resolution presets (single-select, mutually exclusive)
// ---------------------------------------------------------------------------

export type ResolutionPresetKey = "sd" | "hd" | "fhd" | "4k";

export interface ResolutionPreset {
  key: ResolutionPresetKey;
  label: string;
  minHeight: number;
}

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { key: "sd", label: "SD+", minHeight: 480 },
  { key: "hd", label: "HD+", minHeight: 720 },
  { key: "fhd", label: "FHD+", minHeight: 1080 },
  { key: "4k", label: "4K+", minHeight: 2160 },
];

export function findResolutionPreset(
  key: string | null | undefined,
): ResolutionPreset | undefined {
  if (!key) return undefined;
  return RESOLUTION_PRESETS.find((p) => p.key === key);
}

// ---------------------------------------------------------------------------
// Typed filter values (decoded from URL)
// ---------------------------------------------------------------------------

export interface BrowseFilterValues {
  q: string;
  sort: VideoSortKey;
  provider: string | undefined;
  folder: string | undefined;
  favoritesOnly: boolean;
  durationKey: string | undefined;
  resolutionKey: string | undefined;
  minRating: number | undefined;
}

// ---------------------------------------------------------------------------
// Expanded params — the shape `useVideos` / `fetchVideos` expects.
// ---------------------------------------------------------------------------

export interface BrowseVideoParams {
  q: string | undefined;
  sort: VideoSortKey;
  provider: string | undefined;
  folder: string | undefined;
  favorites_only: boolean | undefined;
  duration_min: number | undefined;
  duration_max: number | undefined;
  min_height: number | undefined;
  min_rating: number | undefined;
}

// ---------------------------------------------------------------------------
// Active-filter chip — one per active filter, rendered below the panel.
// ---------------------------------------------------------------------------

export interface FilterChip {
  key: string;
  label: string;
  clear: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const DEFAULT_SORT: VideoSortKey = "date-desc";

// Param keys that `clearAll` resets. Sort + q are preserved (sort is a
// separate concern; q has its own clear button in SearchBar).
const RESETTABLE_PARAMS = [
  "provider",
  "folder",
  "favorites_only",
  "duration",
  "resolution",
  "min_rating",
] as const;

export interface UseBrowseFiltersResult {
  values: BrowseFilterValues;
  params: BrowseVideoParams;
  setQ: (value: string) => void;
  setSort: (value: VideoSortKey) => void;
  setProvider: (value: string | undefined) => void;
  setFolder: (value: string | undefined) => void;
  setFavoritesOnly: (value: boolean) => void;
  setDurationKey: (value: string | undefined) => void;
  setResolutionKey: (value: string | undefined) => void;
  setMinRating: (value: number | undefined) => void;
  clearAll: () => void;
  chips: FilterChip[];
  activeCount: number;
}

export function useBrowseFilters(): UseBrowseFiltersResult {
  const [searchParams, setSearchParams] = useSearchParams();

  // --- Decode ---
  const q = searchParams.get("q") ?? "";
  const sort = (searchParams.get("sort") as VideoSortKey) || DEFAULT_SORT;
  const provider = searchParams.get("provider") ?? undefined;
  const folder = searchParams.get("folder") ?? undefined;
  const favoritesOnly = searchParams.get("favorites_only") === "true";
  const durationKey = searchParams.get("duration") ?? undefined;
  const resolutionKey = searchParams.get("resolution") ?? undefined;
  const minRatingRaw = searchParams.get("min_rating");
  const minRating = minRatingRaw ? Number(minRatingRaw) : undefined;

  // --- Helper: update one param, preserving the rest ---
  function updateParam(key: string, value: string | undefined): void {
    const next = new URLSearchParams(searchParams);
    if (value === undefined || value === "") {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  }

  // --- Setters ---
  const setQ = (value: string) => updateParam("q", value || undefined);
  const setSort = (value: VideoSortKey) => updateParam("sort", value);
  const setProvider = (value: string | undefined) =>
    updateParam("provider", value);
  const setFolder = (value: string | undefined) => updateParam("folder", value);
  const setFavoritesOnly = (value: boolean) =>
    updateParam("favorites_only", value ? "true" : undefined);
  const setDurationKey = (value: string | undefined) =>
    updateParam("duration", value);
  const setResolutionKey = (value: string | undefined) =>
    updateParam("resolution", value);
  const setMinRating = (value: number | undefined) =>
    updateParam("min_rating", value !== undefined ? String(value) : undefined);

  function clearAll(): void {
    const next = new URLSearchParams(searchParams);
    for (const key of RESETTABLE_PARAMS) next.delete(key);
    setSearchParams(next, { replace: true });
  }

  // --- Preset expansion for useVideos ---
  const durationPreset = findDurationPreset(durationKey);
  const resolutionPreset = findResolutionPreset(resolutionKey);

  const params: BrowseVideoParams = {
    q: q || undefined,
    sort,
    provider,
    folder,
    favorites_only: favoritesOnly || undefined,
    duration_min: durationPreset?.min,
    duration_max: durationPreset?.max,
    min_height: resolutionPreset?.minHeight,
    min_rating: minRating,
  };

  // --- Chips ---
  const chips: FilterChip[] = [];
  if (provider) {
    chips.push({
      key: "provider",
      label: PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider,
      clear: () => setProvider(undefined),
    });
  }
  if (folder) {
    chips.push({
      key: "folder",
      label: folder,
      clear: () => setFolder(undefined),
    });
  }
  if (favoritesOnly) {
    chips.push({
      key: "favorites",
      label: "Favorites",
      clear: () => setFavoritesOnly(false),
    });
  }
  if (durationPreset) {
    chips.push({
      key: "duration",
      label: durationPreset.label,
      clear: () => setDurationKey(undefined),
    });
  }
  if (resolutionPreset) {
    chips.push({
      key: "resolution",
      label: resolutionPreset.label,
      clear: () => setResolutionKey(undefined),
    });
  }
  if (minRating !== undefined && !Number.isNaN(minRating)) {
    chips.push({
      key: "min_rating",
      label: `${minRating}\u2605+`,
      clear: () => setMinRating(undefined),
    });
  }

  return {
    values: {
      q,
      sort,
      provider,
      folder,
      favoritesOnly,
      durationKey,
      resolutionKey,
      minRating,
    },
    params,
    setQ,
    setSort,
    setProvider,
    setFolder,
    setFavoritesOnly,
    setDurationKey,
    setResolutionKey,
    setMinRating,
    clearAll,
    chips,
    activeCount: chips.length,
  };
}
