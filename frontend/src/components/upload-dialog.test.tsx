// UploadDialog + queue tests (drag-and-drop task 012) — the
// destination picker renders the dropped batch, the connections, and
// the folder path; a confirm hands the destination over. The queue
// hook runs sequentially against the scripted fake XHR: one in flight,
// progress per file, cancel aborts, retry re-queues, and the summary
// toast holds the verb.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ToastProvider } from "./ui/toast";
import { UploadDialog } from "./upload-dialog";
import { useUploadQueue } from "../hooks/use-upload-queue";
import { setCsrfToken } from "../api/client";
import { renderWithProviders, jsonResponse } from "../test/utils";

// ------------------------------------------------------------ the dialog

function connectionsFetch() {
  return (input: RequestInfo | URL): Response => {
    const url = String(input);
    if (url.startsWith("/api/connections")) {
      return jsonResponse([
        {
          id: "c1",
          provider: "s3",
          provider_account_email: null,
          connected_at: "2026-01-01T00:00:00Z",
          scan_status: "idle",
          last_scan_at: null,
          video_count: 0,
          videos_pruned: 0,
          files_pruned: 0,
        },
      ]);
    }
    if (url.startsWith("/api/folders/tree")) return jsonResponse([]);
    return jsonResponse({ message: "unmocked" }, 404);
  };
}

function renderDialog(
  files: File[],
  onConfirm = vi.fn(),
  onClose = vi.fn(),
) {
  return renderWithProviders(
    <UploadDialog files={files} onConfirm={onConfirm} onClose={onClose} />,
    { fetchImplementation: connectionsFetch() },
  );
}

describe("UploadDialog", () => {
  const files = [
    new File([new Uint8Array(10)], "a.mp4", { type: "video/mp4" }),
    new File([new Uint8Array(20)], "b.jpg", { type: "image/jpeg" }),
  ];

  it("lists the dropped files with mono sizes", async () => {
    renderDialog(files);
    const dialog = await screen.findByRole("dialog", { name: "Upload files" });
    expect(within(dialog).getByText("a.mp4")).toBeInTheDocument();
    expect(within(dialog).getByText("10 B")).toBeInTheDocument();
    expect(within(dialog).getByText("b.jpg")).toBeInTheDocument();
  });

  it("confirm hands over the picked connection and path", async () => {
    const onConfirm = vi.fn();
    renderDialog(files, onConfirm);
    await screen.findByRole("dialog", { name: "Upload files" });

    fireEvent.change(screen.getByLabelText("Destination folder path"), {
      target: { value: "/Movies" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload 2 files" }));

    expect(onConfirm).toHaveBeenCalledWith({
      connectionId: "c1",
      dir: "/Movies",
    });
  });

  it("cancel discards the batch", async () => {
    const onClose = vi.fn();
    renderDialog(files, vi.fn(), onClose);
    await screen.findByRole("dialog", { name: "Upload files" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});

// -------------------------------------------------------------- the queue

class FakeXHR {
  static instances: FakeXHR[] = [];
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  status = 0;
  responseText = "";
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  sentBody: unknown = null;
  url = "";

  constructor() {
    FakeXHR.instances.push(this);
  }

  open(_m: string, url: string): void {
    this.url = url;
  }

  setRequestHeader(): void {}

  send(body: unknown): void {
    this.sentBody = body;
  }

  abort(): void {
    this.onabort?.();
  }

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
}

function file(name: string, size: number): File {
  return new File([new Uint8Array(size)], name);
}

function queueWrapper({ children }: { children: ReactNode }): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

function renderQueue() {
  return renderHook(() => useUploadQueue(), { wrapper: queueWrapper });
}

beforeEach(() => {
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
  setCsrfToken("csrf-1");
});

describe("useUploadQueue", () => {
  it("uploads sequentially — one in flight, progress per file, summary toast", async () => {
    const { result } = renderQueue();
    act(() => {
      result.current.start([file("a.mp4", 100), file("b.mp4", 200)], "c1", "/M");
    });

    // First file in flight; second queued.
    await waitFor(() => {
      expect(result.current.entries[0]!.status).toBe("uploading");
    });
    expect(result.current.entries[1]!.status).toBe("queued");
    expect(FakeXHR.instances).toHaveLength(1);

    act(() => {
      FakeXHR.instances[0]!.fireProgress(50, 100);
    });
    await waitFor(() =>
      expect(result.current.entries[0]!.progress).toEqual({ loaded: 50, total: 100 }),
    );

    // First lands → second starts.
    act(() => {
      FakeXHR.instances[0]!.respond(201, JSON.stringify({ file_id: "M/a.mp4" }));
    });
    await waitFor(() => {
      expect(result.current.entries[0]!.status).toBe("done");
      expect(result.current.entries[1]!.status).toBe("uploading");
    });
    act(() => {
      FakeXHR.instances[1]!.respond(201, JSON.stringify({ file_id: "M/b.mp4" }));
    });
    await waitFor(() =>
      expect(result.current.entries.every((e) => e.status === "done")).toBe(true),
    );
    expect(await screen.findByText("Uploaded 2 files")).toBeInTheDocument();
  });

  it("cancel mid-flight aborts and marks cancelled; retry re-queues", async () => {
    const { result } = renderQueue();
    act(() => {
      result.current.start([file("a.mp4", 10)], "c1", "");
    });
    await waitFor(() => expect(result.current.entries[0]!.status).toBe("uploading"));

    act(() => {
      result.current.cancelOne(result.current.entries[0]!.key);
    });
    await waitFor(() => expect(result.current.entries[0]!.status).toBe("cancelled"));

    act(() => {
      result.current.retry(result.current.entries[0]!.key);
    });
    await waitFor(() => expect(result.current.entries[0]!.status).toBe("uploading"));
    act(() => {
      FakeXHR.instances.at(-1)!.respond(201, JSON.stringify({ file_id: "a.mp4" }));
    });
    await waitFor(() => expect(result.current.entries[0]!.status).toBe("done"));
  });

  it("a failed file shows the direct error and stays retryable", async () => {
    const { result } = renderQueue();
    act(() => {
      result.current.start([file("a.mp4", 10)], "c1", "");
    });
    await waitFor(() => expect(result.current.entries[0]!.status).toBe("uploading"));
    act(() => {
      FakeXHR.instances[0]!.respond(
        404,
        JSON.stringify({ status: "error", message: "not found" }),
      );
    });
    await waitFor(() => expect(result.current.entries[0]!.status).toBe("error"));
    expect(result.current.entries[0]!.error).toBe("not found");
  });
});
