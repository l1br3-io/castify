// Placeholder for the share watch page — the real implementation (player
// reuse through the share scope, owner-only affordances hidden, zero server
// writes) lands in sharing task 010. Public route: `/share/{token}/watch/{videoId}`
// renders without a session.

import { useParams } from "react-router-dom";

export function ShareWatchPage() {
  const { token, videoId } = useParams<{ token: string; videoId: string }>();
  return (
    <main>
      <h1>Shared video</h1>
      <p data-testid="share-watch-params">
        {token}/{videoId}
      </p>
    </main>
  );
}
