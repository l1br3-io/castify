// Placeholder for the share landing page — the real implementation (resolve
// → password gate → item list) lands in sharing task 009. Registered as a
// public route (no `requireSessionLoader`) so recipients can open
// `/share/{token}` without a session; rendering the token marker makes the
// routing verifiable in `just dev` before 009 replaces this file.

import { useParams } from "react-router-dom";

export function SharePage() {
  const { token } = useParams<{ token: string }>();
  return (
    <main>
      <h1>Shared items</h1>
      <p data-testid="share-token">{token}</p>
    </main>
  );
}
