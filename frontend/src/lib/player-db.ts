// IndexedDB wrapper for per-device player state.
//
// Per `docs/data-storage-principles.md`, high-frequency session data lives
// here rather than on the server. Two stores:
//   - playbackProgress: per-video resume position + denormalized metadata
//     so a future continue-watching shelf renders with zero server calls.
//   - playerPrefs: global player preferences (volume/mute/speed) and
//     per-video subtitle track selection.
//
// All functions are async (IndexedDB is async by nature). Callers in the
// React layer treat them as fire-and-forget where the UI doesn't need to
// wait for confirmation — the in-memory state is the source of truth for
// rendering; IndexedDB is the persistence layer.

const DB_NAME = "castify-player";
const DB_VERSION = 1;
const PROGRESS_STORE = "playbackProgress";
const PREFS_STORE = "playerPrefs";

export interface ProgressEntry {
  videoId: string;
  positionSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
  updatedAt: number;
  // Denormalized metadata for the continue-watching shelf. Keeping a copy
  // here means the shelf renders from IndexedDB alone — no `GET /videos`
  // round-trip per item. Stale if the catalog rescans and metadata shifts;
  // the shelf re-fetches the full list on browse-page load anyway.
  videoName: string;
  videoDurationMs: number | null;
  thumbnailStatus: string;
  height: number | null;
  provider: string;
}

export interface GlobalPrefs {
  volume: number;
  muted: boolean;
  playbackRate: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PROGRESS_STORE)) {
        db.createObjectStore(PROGRESS_STORE, { keyPath: "videoId" });
      }
      if (!db.objectStoreNames.contains(PREFS_STORE)) {
        db.createObjectStore(PREFS_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store);
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Playback progress ──────────────────────────────────────────────────

export async function getProgress(
  videoId: string,
): Promise<ProgressEntry | null> {
  try {
    const db = await openDB();
    const result = await promisify<ProgressEntry | undefined>(
      tx(db, PROGRESS_STORE, "readonly").get(videoId),
    );
    return result ?? null;
  } catch {
    return null;
  }
}

export async function saveProgressEntry(
  entry: ProgressEntry,
): Promise<void> {
  try {
    const db = await openDB();
    await promisify(
      tx(db, PROGRESS_STORE, "readwrite").put(entry),
    );
  } catch {
    // IndexedDB failures (quota, corruption, private-browsing quirks) are
    // non-fatal — playback continues without persistence. The next write
    // attempt may succeed.
  }
}

export async function getInProgressVideos(
  limit = 20,
): Promise<ProgressEntry[]> {
  try {
    const db = await openDB();
    const all = await promisify<ProgressEntry[]>(
      tx(db, PROGRESS_STORE, "readonly").getAll(),
    );
    return all
      .filter((e) => !e.completed && e.positionSeconds > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function clearProgress(videoId: string): Promise<void> {
  try {
    const db = await openDB();
    await promisify(
      tx(db, PROGRESS_STORE, "readwrite").delete(videoId),
    );
  } catch {
    // same fire-and-forget tolerance as saveProgressEntry
  }
}

// ── Player preferences ─────────────────────────────────────────────────

const GLOBAL_PREFS_KEY = "global";

export async function getGlobalPrefs(): Promise<GlobalPrefs | null> {
  try {
    const db = await openDB();
    const result = await promisify<GlobalPrefs | undefined>(
      tx(db, PREFS_STORE, "readonly").get(GLOBAL_PREFS_KEY),
    );
    return result ?? null;
  } catch {
    return null;
  }
}

export async function saveGlobalPrefs(prefs: GlobalPrefs): Promise<void> {
  try {
    const db = await openDB();
    await promisify(
      tx(db, PREFS_STORE, "readwrite").put({
        key: GLOBAL_PREFS_KEY,
        ...prefs,
      }),
    );
  } catch {
    // non-fatal — prefs just won't persist this time
  }
}

export async function getSubtitlePref(
  videoId: string,
): Promise<string | null> {
  try {
    const db = await openDB();
    const result = await promisify<{ subtitleTrackId: string | null } | undefined>(
      tx(db, PREFS_STORE, "readonly").get(`subtitle:${videoId}`),
    );
    return result?.subtitleTrackId ?? null;
  } catch {
    return null;
  }
}

export async function saveSubtitlePref(
  videoId: string,
  trackId: string | null,
): Promise<void> {
  try {
    const db = await openDB();
    await promisify(
      tx(db, PREFS_STORE, "readwrite").put({
        key: `subtitle:${videoId}`,
        subtitleTrackId: trackId,
      }),
    );
  } catch {
    // non-fatal
  }
}
