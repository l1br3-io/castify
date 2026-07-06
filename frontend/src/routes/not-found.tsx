import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section className="text-center space-y-4 py-16">
      <h1 className="text-6xl font-bold">404</h1>
      <p className="opacity-70">This page drifted off into the cloud.</p>
      <Link to="/" className="inline-block underline">
        Back to home
      </Link>
    </section>
  );
}
