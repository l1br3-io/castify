// CollectionCard — the /collections grid's signature element
// (collections-page task 001). A 16:9 tile carrying a stacked-poster
// collage: `preview[0]` is the lead poster (full Thumbnail with its
// loading/error state machine), `preview[1..3]` render as decorative
// layers peeking out behind it at small offsets with hairline edges.
// Degenerate previews degrade silently — a single member is a plain
// poster, an empty one gets the rail card's quiet tinted block.
//
// Layout:
//   ┌──────────────────────────────────┐
//   │   lead Thumbnail (plate)      ▗▀ │ ← layers peek bottom-right
//   │                              ▐█▌│   (max 3, 4/6/8px steps)
//   └──────────────────────────────────┘
//   name (2-line clamp)
//   Series · 3 videos            [slot]  ← menuSlot (T4/T5 kebab)
//
// Slot contract: `menuSlot` renders right of the meta row in a
// `relative z-10` wrapper — same discipline as PosterCard's menuSlot,
// so CRUD controls stay clickable above the stretched link without
// reshaping the layout.
//
// Hover discipline (motion budget): the lead tile's border shifts
// toward the accent; no translate/lift anywhere.

import { type ReactNode } from "react";
import { Link } from "react-router-dom";

import type { CollectionDto, CollectionKind } from "../../api/types";
import { Thumbnail } from "../thumbnail";

const KIND_LABELS: Record<CollectionKind, string> = {
  show: "Series",
  movie: "Movie",
  time: "Time group",
  manual: "Collection",
};

// Tailwind translate steps for the deck fan: nearest layer peeks 4px,
// deepest 8px — small enough to read as edges, not noise, and exactly
// the card's tile→text gap so nothing collides. Later layers paint on
// top of nearer ones, so every edge stays visible.
const LAYER_OFFSETS = [
  "translate-x-1 translate-y-1",
  "translate-x-1.5 translate-y-1.5",
  "translate-x-2 translate-y-2",
];

// Backend bounds `preview` at 4 members; slice again so a wider preview
// can never fan beyond the reserved tile slack.
const MAX_LAYERS = 3;

type CollectionCardProps = {
  collection: CollectionDto;
  /**
   * Action menu anchored to the meta row (rename/delete kebab, tasks
   * 004/005). Stays above the stretched link so its controls remain
   * clickable. Owner contexts only.
   */
  menuSlot?: ReactNode;
};

export function CollectionCard({ collection, menuSlot }: CollectionCardProps) {
  const [lead, ...rest] = collection.preview;
  const layers = rest.slice(0, MAX_LAYERS);

  const countLabel =
    collection.member_count === 1
      ? "1 video"
      : `${collection.member_count} videos`;

  return (
    <article className="group relative flex flex-col gap-2">
      <Link
        to={`/collections/${collection.id}`}
        // Stretched link — the keyboard entry to the card. The focus
        // ring visually wraps the whole card (PosterCard pattern).
        className="absolute inset-0 rounded-[var(--radius-card)] z-0
                   outline-none focus-visible:ring-2
                   focus-visible:ring-[var(--color-focus)]
                   focus-visible:ring-offset-2
                   focus-visible:ring-offset-[var(--color-castify-canvas)]"
        aria-label={`Open collection ${collection.name}`}
      />
      <Collage lead={lead} layers={layers} />
      <div className="flex flex-col gap-1">
        <h3
          className="line-clamp-2 text-[13px] font-semibold leading-snug group-hover:underline group-focus-within:underline"
          title={collection.name}
        >
          {collection.name}
        </h3>
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--color-castify-muted)]">
          <span className="figure">{`${KIND_LABELS[collection.kind]} · ${countLabel}`}</span>
          {menuSlot && <span className="relative z-10 ml-auto">{menuSlot}</span>}
        </div>
      </div>
    </article>
  );
}

function Collage({
  lead,
  layers,
}: {
  lead: CollectionDto["preview"][number] | undefined;
  layers: CollectionDto["preview"];
}) {
  if (!lead) {
    // Empty collections (or preview members that vanished) get the
    // rail card's quiet tinted block — the card stays meaningful via
    // its text.
    return (
      <div className="aspect-video w-full rounded-[var(--radius-button)] bg-[var(--color-castify-muted)]/20" />
    );
  }

  return (
    <div className="relative aspect-video w-full">
      {layers.map((video, i) => (
        <div
          key={video.id}
          aria-hidden
          className={`absolute inset-0 z-0 overflow-hidden rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] ${LAYER_OFFSETS[i] ?? LAYER_OFFSETS[LAYER_OFFSETS.length - 1]}`}
        >
          <img
            src={`/api/videos/${encodeURIComponent(video.id)}/thumbnail`}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        </div>
      ))}
      <div
        className="absolute inset-0 z-10 overflow-hidden rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] transition-colors group-hover:border-[var(--color-castify-accent)] group-focus-within:border-[var(--color-castify-accent)]"
      >
        <Thumbnail video={lead} />
      </div>
    </div>
  );
}
