// ErrorBoundary — top-level catch for uncaught render exceptions.
//
// Without this, a single thrown render error blanks the entire SPA. The
// fallback is friendly (EmptyState-style), offers a Reload button, and can
// expand to show the error message for diagnostics.
//
// The boundary is intentionally simple — it does not attempt to recover
// partial UI. A reload is the right answer for an unexpected render
// exception in a single-user app.

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught render error:", error, info);
  }

  private handleReload = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-8 text-center">
          <p className="text-lg font-medium">Something went wrong.</p>
          <p className="mt-2 text-sm opacity-70">
            Castify hit an unexpected error. Reload to continue.
          </p>
          <pre className="mt-4 max-h-32 overflow-auto rounded-[var(--radius-button)] bg-[var(--color-castify-canvas)] p-3 text-left text-xs text-[var(--color-castify-muted)]">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={this.handleReload}
            className="mt-5 inline-flex items-center justify-center rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-5 py-2 text-sm font-semibold text-[var(--color-on-accent)] transition hover:opacity-90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
