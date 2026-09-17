import { useNavigate } from "react-router-dom";

import { EmptyState } from "../components/ui/empty-state";

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <section className="mx-auto max-w-md py-16">
      <EmptyState
        title="404"
        body="This page doesn't exist. The link may be old or mistyped."
        actionLabel="Go to library"
        onAction={() => navigate("/")}
      />
    </section>
  );
}
