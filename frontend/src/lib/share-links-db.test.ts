// `share-links-db` — short-link cache (short-links, task 002).
//
// jsdom ships no IndexedDB, so these tests install a minimal in-memory
// shim (Map-backed, microtask-async requests) shaped exactly to what the
// module uses: `open` → `transaction` → `objectStore.{get,put,getAll,
// delete}`. The module memoizes its DB promise at import time, so each
// test re-imports it fresh (`vi.resetModules`) against a fresh shim.
//
// The contract under test:
//   * `saveShortLink`/`getShortLink` round-trip the alias
//   * the read-modify-write never clobbers the canonical `url`/`savedAt`
//   * unknown id → null alias, and saving with no canonical entry is a
//     no-op (nothing to alias onto)
//   * every failure degrades (null / {}) like the existing functions

import { describe, expect, it, vi } from "vitest";

type StoredEntry = Record<string, unknown>;

function makeIndexedDb(failOpen = false): IDBFactory {
  const backing = new Map<string, StoredEntry>();

  const request = (compute: () => unknown, fail = false): unknown => {
    const req: Record<string, unknown> = {};
    queueMicrotask(() => {
      if (fail) {
        req.error = new DOMException("indexeddb unavailable", "UnknownError");
        (req.onerror as (() => void) | null)?.();
      } else {
        req.result = compute();
        (req.onsuccess as (() => void) | null)?.();
      }
    });
    return req;
  };

  const objectStore = {
    put: (entry: StoredEntry) =>
      request(() => {
        backing.set(entry.shareId as string, entry);
        return entry.shareId;
      }),
    get: (key: string) => request(() => backing.get(key)),
    getAll: () => request(() => Array.from(backing.values())),
    delete: (key: string) =>
      request(() => {
        backing.delete(key);
        return undefined;
      }),
  };

  const db = {
    objectStoreNames: { contains: (name: string) => name === "shareLinks" },
    createObjectStore: () => objectStore,
    transaction: () => ({ objectStore: () => objectStore }),
  };

  return {
    open: () => request(() => db, failOpen),
  } as unknown as IDBFactory;
}

async function loadDb(options: { failOpen?: boolean } = {}) {
  vi.resetModules();
  const { failOpen = false } = options;
  Reflect.set(globalThis, "indexedDB", makeIndexedDb(failOpen));
  return import("./share-links-db");
}

describe("short-link cache", () => {
  it("round-trips saveShortLink → getShortLink", async () => {
    const db = await loadDb();
    await db.saveShareLink("s1", "/share/tok1");
    await db.saveShortLink("s1", "https://spoo.me/U1b05Y");

    await expect(db.getShortLink("s1")).resolves.toBe("https://spoo.me/U1b05Y");
  });

  it("getShortLink returns null for an id with no alias", async () => {
    const db = await loadDb();
    await db.saveShareLink("s1", "/share/tok1");

    await expect(db.getShortLink("s1")).resolves.toBeNull();
  });

  it("getShortLink returns null for a completely unknown id", async () => {
    const db = await loadDb();

    await expect(db.getShortLink("ghost")).resolves.toBeNull();
  });

  it("saveShortLink preserves the canonical url and savedAt (RMW)", async () => {
    const db = await loadDb();
    await db.saveShareLink("s1", "/share/tok1");
    const mapBefore = await db.getShareLinkMap();

    await db.saveShortLink("s1", "https://spoo.me/U1b05Y");

    const mapAfter = await db.getShareLinkMap();
    expect(mapAfter).toEqual(mapBefore);
    await expect(db.getShortLink("s1")).resolves.toBe("https://spoo.me/U1b05Y");
  });

  it("saveShortLink without a canonical entry is a no-op", async () => {
    const db = await loadDb();

    await db.saveShortLink("ghost", "https://spoo.me/U1b05Y");

    await expect(db.getShortLink("ghost")).resolves.toBeNull();
    await expect(db.getShareLinkMap()).resolves.toEqual({});
  });

  it("saveShortLink overwrites a previous alias", async () => {
    const db = await loadDb();
    await db.saveShareLink("s1", "/share/tok1");
    await db.saveShortLink("s1", "https://spoo.me/old");

    await db.saveShortLink("s1", "https://spoo.me/new");

    await expect(db.getShortLink("s1")).resolves.toBe("https://spoo.me/new");
  });

  it("getShortLink degrades to null when IndexedDB is unavailable", async () => {
    const db = await loadDb({ failOpen: true });

    await expect(db.getShortLink("s1")).resolves.toBeNull();
  });

  it("saveShortLink degrades silently when IndexedDB is unavailable", async () => {
    const db = await loadDb({ failOpen: true });

    await expect(db.saveShortLink("s1", "https://spoo.me/U1b05Y")).resolves.toBeUndefined();
  });

  it("getShareLinkMap still maps shareId → canonical url only", async () => {
    const db = await loadDb();
    await db.saveShareLink("s1", "/share/tok1");
    await db.saveShortLink("s1", "https://spoo.me/U1b05Y");

    await expect(db.getShareLinkMap()).resolves.toEqual({ s1: "/share/tok1" });
  });
});

describe("short-link cache — degradation without IndexedDB", () => {
  it("getShortLink returns null when indexedDB is absent (jsdom default)", async () => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, "indexedDB");
    const db = await import("./share-links-db");

    await expect(db.getShortLink("s1")).resolves.toBeNull();
    await expect(db.getShareLinkMap()).resolves.toEqual({});
  });
});
