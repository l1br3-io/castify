// Upload client (drag-and-drop task 012) — XHR, deliberately NOT fetch.
//
// GOTCHA: `fetch` cannot report upload progress cross-browser — the
// standard's request-body streaming has no progress event, and the
// patch (`fetch upload streaming`) is Chromium-only and applies to the
// REQUEST side only with duplex semantics we don't need. `XHR`'s
// `upload.onprogress` + `abort()` is the complete, portable answer for
// a file-by-file progress queue — so this one client lives beside
// `apiFetch` under the same `src/api/` rule, wearing XHR instead.
//
// Mirrors `apiFetch`'s CSRF contract (header injection from the cached
// token) and its error shape (`ApiError` with the server's parsed
// body), so queue UI branches on statuses exactly like the rest of the
// app.

import { ApiError, getCsrfToken } from "./client";

export interface UploadProgress {
  loaded: number;
  total: number;
}

/** A started upload: the settled outcome plus the cancel switch. */
export interface UploadTask {
  /** Resolves with the provider file id on 201. */
  promise: Promise<string>;
  /** Cancel: aborts the request (the provider stream aborts with it). */
  abort: () => void;
}

/**
 * `POST /api/uploads?connection_id=&dir=&filename=` — stream one file to
 * a provider through the server pass-through. Progress rides
 * `upload.onprogress` (fraction of bytes handed to the socket).
 */
export function uploadFile(
  file: File,
  connectionId: string,
  dir: string,
  onProgress?: (progress: UploadProgress) => void,
): UploadTask {
  const xhr = new XMLHttpRequest();
  const params = new URLSearchParams({
    connection_id: connectionId,
    dir,
    filename: file.name,
  });

  const promise = new Promise<string>((resolve, reject) => {
    xhr.open("POST", `/api/uploads?${params.toString()}`);
    const token = getCsrfToken();
    if (token !== null) {
      xhr.setRequestHeader("x-csrf-token", token);
    }
    if (onProgress !== undefined) {
      xhr.upload.onprogress = (event) => {
        onProgress({ loaded: event.loaded, total: event.total });
      };
    }
    xhr.onload = () => {
      const text = xhr.responseText;
      let parsed: unknown = null;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (xhr.status === 201) {
        const fileId =
          parsed !== null &&
          typeof parsed === "object" &&
          "file_id" in parsed &&
          typeof (parsed as { file_id: unknown }).file_id === "string"
            ? (parsed as { file_id: string }).file_id
            : "";
        resolve(fileId);
        return;
      }
      const message =
        parsed !== null &&
        typeof parsed === "object" &&
        "message" in parsed &&
        typeof (parsed as { message: unknown }).message === "string"
          ? (parsed as { message: string }).message
          : `upload failed: ${xhr.status}`;
      reject(new ApiError(xhr.status, message, parsed));
    };
    xhr.onerror = () => {
      reject(new ApiError(0, "Upload stopped — connection lost.", null));
    };
    xhr.onabort = () => {
      reject(new DOMException("upload aborted", "AbortError"));
    };
    xhr.send(file);
  });

  return { promise, abort: () => xhr.abort() };
}
