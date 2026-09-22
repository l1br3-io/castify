// ListView — the shared slate-row table (library-list-view spec §A, task
// 003). In list mode every owning surface maps its DTO into rows here:
// browse videos, organizer folders + entries, collections.
//
// The row is a film slate, per the spec's design direction: the leading
// cell reuses `Thumbnail`'s matted frame (its corner duration badge is the
// slate count) or a kind-icon frame for non-video kinds; a 4px kind-hue
// tab runs down the row's left edge (FileRow's language, promoted to the
// whole table); data columns speak the ledger voice — mono numerals
// (`.figure`), numbers right-aligned, muted caption-scale headers.
// Everything else stays quiet: hairline row rules, no zebra, hover shifts
// the row background only.
//
// A11y contract: the table is semantic (`<th scope="col">`, `aria-sort`
// on the active column when sorting). Rows are NOT links — the name cell
// holds the real `<a>` and is the keyboard path; the row-level onClick
// exists only for selection toggling (never navigation), mirroring the
// PosterCard/FileRow selection contract.
//
// Sorting: callers pass `sort` + per-column `sortKey`s (browse maps them
// to the existing URL sort keys). Without `sort`, headers render plain —
// the organizer's display-only case (server order stands).

import { type ReactNode } from "react";
import { Link } from "react-router-dom";

import { Thumbnail, type ThumbnailVideo } from "./thumbnail";

/** One trailing data column. `value` is pre-rendered content — the call
 *  site formats (`formatDuration`, dates); ListView only styles. */
export type ListViewColumn = {
  key: string;
  label: string;
  value: ReactNode;
  /** Mono ledger numerals (`.figure`). */
  mono?: boolean;
  /** Right-align (numbers); defaults to left. */
  numeric?: boolean;
  /** Present → the header renders as a sort button firing this key. */
  sortKey?: string;
  /** Extra classes for the header + body cells (responsive collapse —
   *  adapters pass static literals like "hidden lg:table-cell"). */
  className?: string;
};

/** One slate row. `columns` excludes the name — the name is structural
 *  (link + truncation) and rendered from `name`. */
export type ListViewRow = {
  id: string;
  name: string;
  /** Absent → plain-text name (folder rows, current-location rows). */
  href?: string;
  /** Router state for the name link — browse passes `{ queue }` so the
   *  watch page keeps its next/prev context from list mode too. */
  linkState?: Record<string, unknown>;
  /** Folder rows (curated navigation): renders a button in the name cell
   *  instead of a link — same styling, same keyboard path. */
  nameAction?: { onClick: () => void };
  /** Video rows: the matted frame + corner duration badge. */
  thumbnail?: { video: ThumbnailVideo; src?: string };
  /** The kind tab's bg class (e.g. `KIND_HUES[kind].tab`). */
  kindHue?: string;
  /** Non-thumbnail rows: the glyph inside the frame cell. */
  kindIcon?: ReactNode;
  columns: ListViewColumn[];
  /** Per-row kebab (trailing cell; hidden in select mode). */
  menuSlot?: ReactNode;
  /** Favorite toggle (trailing cell; hidden in select mode). */
  favoriteSlot?: ReactNode;
  /** Current-location folder rows render with aria-current="page". */
  current?: boolean;
};

export type ListViewSort = {
  /** The sortKey currently active (a column's, or the name's). */
  activeKey: string | null;
  direction: "asc" | "desc";
  onSort: (key: string) => void;
};

type ListViewProps = {
  rows: ListViewRow[];
  /** The table's accessible name (e.g. "All files"). */
  ariaLabel: string;
  /** Pass to make the Name header sortable (its sort key — browse: "name"). */
  nameSortKey?: string;
  sort?: ListViewSort;
  selection?: {
    isSelected: (row: ListViewRow) => boolean;
    onToggle: (row: ListViewRow) => void;
  };
};

function ariaSortValue(
  sort: ListViewSort,
  key: string | undefined,
): "ascending" | "descending" | undefined {
  if (key === undefined || key !== sort.activeKey) return undefined;
  return sort.direction === "asc" ? "ascending" : "descending";
}

/** A header cell: a sort button when it carries a sortKey (and `sort` is
 *  wired), otherwise a plain `<th>`. */
function HeaderCell({
  label,
  sortKey,
  sort,
  className = "",
  align = "text-left",
}: {
  label: string;
  sortKey?: string;
  sort?: ListViewSort;
  className?: string;
  align?: string;
}) {
  const sortable = sortKey !== undefined && sort !== undefined;
  return (
    <th
      scope="col"
      aria-sort={sort ? ariaSortValue(sort, sortKey) : undefined}
      className={`px-3 py-1.5 text-xs font-medium text-[var(--color-castify-muted)] ${align} ${className}`}
    >
      {sortable ? (
        <button
          type="button"
          onClick={() => sort!.onSort(sortKey!)}
          className="inline-flex items-center gap-1 rounded-[var(--radius-button)] transition hover:text-[var(--color-castify-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] motion-reduce:transition-none"
        >
          {label}
        </button>
      ) : (
        label
      )}
    </th>
  );
}

export function ListView({
  rows,
  ariaLabel,
  nameSortKey,
  sort,
  selection,
}: ListViewProps) {
  const hasActions = rows.some((row) => row.menuSlot || row.favoriteSlot);
  // Column headers come from the first row — every row of one listing
  // maps the same DTO, so the column set is uniform by construction.
  const columns = rows[0]?.columns ?? [];

  return (
    <table aria-label={ariaLabel} className="w-full border-collapse">
      <thead>
        <tr className="border-b border-[var(--color-castify-rule)]">
          {/* Leading cell: selection checkbox column, or the frame column
              when not selecting. Kept as a labeled empty header so the
              body cells stay aligned in either mode. */}
          {selection && <HeaderCell label="Select" className="w-10" />}
          <HeaderCell label="" className="w-24 sm:w-28" />
          <HeaderCell label="Name" sortKey={nameSortKey} sort={sort} />
          {columns.map((col) => (
            <HeaderCell
              key={col.key}
              label={col.label}
              sortKey={col.sortKey}
              sort={sort}
              className={col.className}
              align={col.numeric ? "text-right" : "text-left"}
            />
          ))}
          {hasActions && !selection && <HeaderCell label="" className="w-px" />}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <ListViewBodyRow key={row.id} row={row} selection={selection} hasActions={hasActions} />
        ))}
      </tbody>
    </table>
  );
}

function ListViewBodyRow({
  row,
  selection,
  hasActions,
}: {
  row: ListViewRow;
  selection?: ListViewProps["selection"];
  /** The listing renders an actions column (any row has slots). Every
   *  body row must render that cell — missing cells shift the row. */
  hasActions: boolean;
}) {
  const isSelected = selection?.isSelected(row) ?? false;

  return (
    <tr
      onClick={selection ? () => selection.onToggle(row) : undefined}
      className={`group border-b border-[var(--color-castify-rule)] transition-colors motion-reduce:transition-none hover:bg-[var(--color-castify-hover)] ${
        selection ? "cursor-pointer" : ""
      } ${
        isSelected
          ? "bg-[var(--color-castify-accent-subtle)] shadow-[inset_2px_0_0_var(--color-castify-accent)]"
          : ""
      }`}
    >
      {selection && (
        <td className="px-3 py-2 align-middle">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => selection.onToggle(row)}
            // Both the checkbox and the row toggle — stop the bubble so a
            // checkbox click doesn't fire twice (PosterCard lesson).
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${row.name}`}
            className="h-4 w-4 cursor-pointer accent-[var(--color-castify-accent)]"
          />
        </td>
      )}
      {/* The slate frame: Thumbnail for videos (matted, corner duration
          badge), the kind glyph on a quiet surface otherwise. The kind
          tab anchors here — inset-y of this cell spans the row. */}
      <td className="relative px-3 py-2 align-middle">
        {row.kindHue && (
          <span
            aria-hidden
            className={`absolute inset-y-0 left-0 w-1 ${row.kindHue}`}
          />
        )}
        <div className="w-20 sm:w-24">
          {row.thumbnail ? (
            <Thumbnail video={row.thumbnail.video} src={row.thumbnail.src} />
          ) : (
            <div className="flex aspect-video w-full items-center justify-center rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] text-[var(--color-castify-muted)]">
              {row.kindIcon}
            </div>
          )}
        </div>
      </td>
      <td className="max-w-0 px-3 py-2 align-middle">
        {row.href !== undefined && !selection ? (
          <Link
            to={row.href}
            state={row.linkState}
            aria-current={row.current ? "page" : undefined}
            title={row.name}
            className="flex items-center gap-1 truncate text-sm font-medium group-hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
          >
            {row.name}
          </Link>
        ) : row.nameAction !== undefined && !selection ? (
          <button
            type="button"
            onClick={row.nameAction.onClick}
            aria-current={row.current ? "page" : undefined}
            title={row.name}
            className="flex items-center gap-1 truncate text-left text-sm font-medium group-hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
          >
            {row.name}
          </button>
        ) : (
          <span
            aria-current={row.current ? "page" : undefined}
            title={row.name}
            className="block truncate text-sm font-medium"
          >
            {row.name}
          </span>
        )}
      </td>
      {/* Each row supplies its OWN columns — the rows[0] set only shapes
          the header; values are per-row by construction. */}
      {row.columns.map((col) => (
        <td
          key={col.key}
          title={typeof col.value === "string" ? col.value : undefined}
          className={`whitespace-nowrap px-3 py-2 align-middle text-sm ${
            col.numeric ? "text-right" : ""
          } ${col.mono ? "figure font-mono" : "text-[var(--color-castify-muted)]"} ${col.className ?? ""}`}
        >
          {col.value}
        </td>
      ))}
      {hasActions && (
        <td className="whitespace-nowrap px-3 py-2 text-right align-middle">
          <span className="inline-flex items-center justify-end gap-1">
            {!selection && row.favoriteSlot}
            {!selection && row.menuSlot}
          </span>
        </td>
      )}
    </tr>
  );
}
