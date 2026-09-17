// Shares page (/shares, app-redesign task 005): the searchable share list
// promoted out of Settings to a top-level route (spec D4). The
// SharesSection component itself is untouched — it is already designed;
// this file is the thin route shell. `/settings/shares/:id` detail URLs
// stay stable (no redirect); only the list moved.

import { SharesSection } from "../components/shares-list";

export function SharesPage() {
  return (
    <section className="mx-auto max-w-2xl space-y-8">
      <SharesSection />
    </section>
  );
}
