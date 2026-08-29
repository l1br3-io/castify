// Clipboard helper with a legacy fallback.
//
// `navigator.clipboard` is absent or throws in non-secure contexts and
// older browsers; the `execCommand("copy")` dance (off-screen textarea,
// programmatic select) covers those. Callers only need the boolean — the
// copied/failed feedback is theirs to render.

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Keep it off-screen and unfocusable so the fallback never flashes or
    // steals focus in the middle of the page.
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
