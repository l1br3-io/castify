// UploadVeil (drag-and-drop task 012) — the window-level OS-file veil.
// When files from the file manager drift over the window, the canvas
// dims and a sunken well rises with amber corner brackets (viewfinder
// marks — not the generic dashed border) and the mono eyebrow
// `DROP TO UPLOAD`. Internal pointer drags never trigger it: only
// `dataTransfer` carrying `Files` counts.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** One corner bracket — draws in with the veil over 120ms (instant
 *  under reduced motion). */
function Bracket({ className }: { className: string }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <span
      aria-hidden
      className={`absolute h-6 w-6 border-[var(--color-castify-accent)] transition-opacity duration-[120ms] motion-reduce:transition-none ${className} ${
        drawn ? "opacity-100" : "opacity-0"
      }`}
    />
  );
}

export function UploadVeil({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // dragenter/leave fire for every element crossing — a depth counter
    // keeps the veil steady while the pointer moves between children.
    let depth = 0;
    const carriesFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");

    const onDragEnter = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setVisible(true);
    };
    const onDragLeave = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setVisible(false);
    };
    // preventDefault on dragover is what makes the window a drop target.
    const onDragOver = (event: DragEvent): void => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setVisible(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onFiles(files);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [onFiles]);

  if (!visible) return null;

  return createPortal(
    <div
      data-testid="upload-veil"
      // aria-hidden: the veil is the visual affordance of a pointer
      // gesture; keyboard users reach uploads through the queue's
      // non-drag equivalents (spec: drag is never the only way).
      aria-hidden="true"
      className="fixed inset-0 z-[70] bg-[rgb(10_12_16_/_0.5)]"
    >
      <div className="absolute inset-0 flex items-center justify-center p-8">
        <div className="relative w-full max-w-xl rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-sunken)] px-10 py-14 text-center">
          <Bracket className="left-3 top-3 rounded-tl-[var(--radius-button)] border-l-2 border-t-2" />
          <Bracket className="right-3 top-3 rounded-tr-[var(--radius-button)] border-r-2 border-t-2" />
          <Bracket className="bottom-3 left-3 rounded-bl-[var(--radius-button)] border-b-2 border-l-2" />
          <Bracket className="bottom-3 right-3 rounded-br-[var(--radius-button)] border-b-2 border-r-2" />
          <p className="eyebrow text-[var(--color-castify-accent)]">
            DROP TO UPLOAD
          </p>
          <p className="mt-3 text-sm text-[var(--color-castify-muted)]">
            Choose a destination after you drop.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
