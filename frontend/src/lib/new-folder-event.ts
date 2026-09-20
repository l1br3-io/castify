// New-folder signal — the sidebar's "New folder" entry points (empty
// tree, and later the tree header) open the organizer's create dialog.
// The sidebar and the organizer are siblings under the layout, and open
// dialogs are ephemeral client state (never URL, never server) — a DOM
// custom event is the thinnest bridge that keeps both sides decoupled.

const EVENT = "castify:new-library-folder";

/** Fire the "open the create-folder dialog" signal (sidebar buttons). */
export function signalNewFolder(): void {
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Subscribe to the signal; returns an unsubscribe fn for effects. */
export function onNewFolder(handler: () => void): () => void {
  const listener = () => handler();
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
