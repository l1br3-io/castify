// IndexedDB store for the last-created share link per share id.
//
// Storage justification (docs/data-storage-principles.md, decision rule #2 —
// per-device data): the raw share token exists only in the response of
// `POST /api/shares` on the browser that created the share; the server
// stores a SHA-256 hash and cannot reconstruct the link. Persisting it
// server-side would (a) defeat the hash-only design and (b) sync a secret
// that is only ever useful back on the device that created it. So the link
// lives here, per-device, and shares created on another browser simply have
// no local copy — the management list shows status only for those rows.
//
// The optional `shortUrl` field caches the minted spoo.me alias next to the
// canonical link (short-links): same decision-rule #2 rationale
// — the alias is per-device sugar for a link this device already holds —
// plus it keeps repeat clicks from re-hitting the shortener's ~5/30s rate
// limit. Records are schemaless, so the added field needs no DB_VERSION
// bump; entries without one re-mint on next click.
//
// Modeled on `player-db.ts`: all functions are async, failures (quota,
// corruption, missing IndexedDB in jsdom/private mode) degrade to
// null/empty rather than surfacing in the UI.

const DB_NAME = "castify-share-links";
const DB_VERSION = 1;
const LINKS_STORE = "shareLinks";

export interface ShareLinkEntry {
  shareId: string;
  /** Relative share path (`/share/{token}`); absolutize at copy time. */
  url: string;
  savedAt: number;
  /** Cached short alias (https spoo.me URL), minted on explicit click.
   * Absent = not yet minted on this device (or minting failed). */
  shortUrl?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LINKS_STORE)) {
        db.createObjectStore(LINKS_STORE, { keyPath: "shareId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * All known links as a `shareId → url` map. One call on mount is enough —
 * the map only changes when this browser creates (task 012) or revokes a
 * share.
 */
export async function getShareLinkMap(): Promise<Record<string, string>> {
  try {
    const db = await openDB();
    const entries = await promisify<ShareLinkEntry[]>(
      db.transaction(LINKS_STORE, "readonly").objectStore(LINKS_STORE).getAll(),
    );
    const map: Record<string, string> = {};
    for (const entry of entries) {
      map[entry.shareId] = entry.url;
    }
    return map;
  } catch {
    return {};
  }
}

/** Called once at creation time (task 012) with the one-time raw link. */
export async function saveShareLink(
  shareId: string,
  url: string,
): Promise<void> {
  try {
    const db = await openDB();
    await promisify(
      db
        .transaction(LINKS_STORE, "readwrite")
        .objectStore(LINKS_STORE)
        .put({ shareId, url, savedAt: Date.now() } satisfies ShareLinkEntry),
    );
  } catch {
    // non-fatal — this device just won't offer copy-link for the share
  }
}

/** Drop a link (e.g. after revoking it — the link is dead anyway). */
export async function deleteShareLink(shareId: string): Promise<void> {
  try {
    const db = await openDB();
    await promisify(
      db
        .transaction(LINKS_STORE, "readwrite")
        .objectStore(LINKS_STORE)
        .delete(shareId),
    );
  } catch {
    // non-fatal — a stale entry renders as a dead link at worst
  }
}

/**
 * Cached short alias for `shareId`, or `null` when not yet minted on this
 * device (or IndexedDB is unavailable). Never throws.
 */
export async function getShortLink(shareId: string): Promise<string | null> {
  try {
    const db = await openDB();
    const entry = await promisify<ShareLinkEntry | undefined>(
      db.transaction(LINKS_STORE, "readonly").objectStore(LINKS_STORE).get(shareId),
    );
    return entry?.shortUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * Remember the minted alias for a share. Read-modify-write so the
 * canonical `url`/`savedAt` survive; a share with no canonical entry on
 * this device (nothing to alias onto) is a no-op. Never throws — a lost
 * write just means the next click mints again.
 */
export async function saveShortLink(
  shareId: string,
  shortUrl: string,
): Promise<void> {
  try {
    const db = await openDB();
    const store = db.transaction(LINKS_STORE, "readwrite").objectStore(LINKS_STORE);
    const entry = await promisify<ShareLinkEntry | undefined>(store.get(shareId));
    if (!entry) return;
    await promisify(
      db
        .transaction(LINKS_STORE, "readwrite")
        .objectStore(LINKS_STORE)
        .put({ ...entry, shortUrl } satisfies ShareLinkEntry),
    );
  } catch {
    // non-fatal — see above
  }
}
