// CopyLinkButton — copy a relative share path as an absolute URL.
//
// Thin wrapper over the ui/CopyButton primitive: this component owns the
// share-specific bit (resolving the relative `linkPath` to an absolute
// URL); the primitive owns the copy behavior, "Copied" feedback, and the
// failure path.

import { CopyButton } from "./ui/copy-button";
import { absoluteShareUrl } from "../hooks/use-shares";

/** `linkPath` is relative (`/share/{token}`); the absolute URL is what
 * lands on the clipboard. */
export function CopyLinkButton({ linkPath }: { linkPath: string }) {
  return <CopyButton value={absoluteShareUrl(linkPath)} />;
}
