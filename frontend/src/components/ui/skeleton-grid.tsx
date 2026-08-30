// SkeletonGrid — the shared loading skeleton for poster-card grids
// (extracted from the identical copies in the recipient share landing and
// the owner manage page).

import { Skeleton } from "./skeleton";

export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-2"
        >
          <Skeleton className="aspect-video w-full" />
          <div className="space-y-1.5 px-1 pb-1">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
