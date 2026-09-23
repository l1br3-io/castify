// Upload client tests (drag-and-drop task 012) — a scripted fake XHR
// drives the client through its whole contract: progress events, the
// 201 resolve with the provider file id, the server's error body on
// failure, and abort semantics.

import { describe, expect, it, vi, beforeEach } from "vitest";

import { setCsrfToken } from "./client";
import { uploadFile } from "./uploads";

/** Scriptable stand-in for XMLHttpRequest — jsdom ships one, but it
 *  can't talk to anything; the tests trigger its callbacks by hand. */
class FakeXHR {
  static instances: FakeXHR[] = [];

  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  status = 0;
  responseText = "";
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  sentBody: unknown = null;
  requestHeaders: Record<string, string> = {};
  url = "";
  aborted = false;

  constructor() {
    FakeXHR.instances.push(this);
  }

  open(_method: string, url: string): void {
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name.toLowerCase()] = value;
  }

  send(body: unknown): void {
    this.sentBody = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  // ── test triggers ────────────────────────────────────────────────
  fireProgress(loaded: number, total: number): void {
    this.upload.onprogress?.(
      new ProgressEvent("progress", { loaded, total }) as ProgressEvent<XMLHttpRequestEventTarget>,
    );
  }

  respond(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }

  failNetwork(): void {
    this.onerror?.();
  }
}

function lastXhr(): FakeXHR {
  return FakeXHR.instances.at(-1)!;
}

function testFile(name = "clip.mp4", size = 10): File {
  return new File([new Uint8Array(size)], name, { type: "video/mp4" });
}

beforeEach(() => {
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
  setCsrfToken("csrf-1");
});

describe("uploadFile", () => {
  it("posts to the uploads route with CSRF and the file as body", async () => {
    const file = testFile();
    const task = uploadFile(file, "c1", "/Movies");
    lastXhr().respond(201, JSON.stringify({ file_id: "Movies/clip.mp4" }));
    await expect(task.promise).resolves.toBe("Movies/clip.mp4");

    const xhr = lastXhr();
    expect(xhr.url).toBe(
      "/api/uploads?connection_id=c1&dir=%2FMovies&filename=clip.mp4",
    );
    expect(xhr.requestHeaders["x-csrf-token"]).toBe("csrf-1");
    expect(xhr.sentBody).toBe(file);
  });

  it("streams progress events through", async () => {
    const onProgress = vi.fn();
    const task = uploadFile(testFile("a.mp4", 200), "c1", "");
    lastXhr().fireProgress(100, 200);
    lastXhr().respond(201, JSON.stringify({ file_id: "a.mp4" }));
    await task.promise;
    expect(onProgress).not.toHaveBeenCalled(); // not wired in this call

    const wired = uploadFile(testFile("b.mp4", 200), "c1", "", onProgress);
    lastXhr().fireProgress(50, 200);
    expect(onProgress).toHaveBeenCalledWith({ loaded: 50, total: 200 });
    lastXhr().respond(201, JSON.stringify({ file_id: "b.mp4" }));
    await wired.promise;
  });

  it("rejects with the server's error body", async () => {
    const task = uploadFile(testFile(), "c1", "");
    lastXhr().respond(
      404,
      JSON.stringify({ status: "error", message: "not found" }),
    );
    await expect(task.promise).rejects.toMatchObject({
      status: 404,
      message: "not found",
    });
  });

  it("rejects with the direct copy on network failure", async () => {
    const task = uploadFile(testFile(), "c1", "");
    lastXhr().failNetwork();
    await expect(task.promise).rejects.toThrow(
      "Upload stopped — connection lost.",
    );
  });

  it("abort cancels the request", async () => {
    const task = uploadFile(testFile(), "c1", "");
    task.abort();
    expect(lastXhr().aborted).toBe(true);
    await expect(task.promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
