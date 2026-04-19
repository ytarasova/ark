/**
 * Generic error boundary. Catches render-time errors in the subtree so one
 * broken view doesn't take down the whole app.
 *
 * Usage: wrap suspect subtrees (e.g. the route-level <Suspense>, a session
 * transcript stream that parses server events) with either <RouteErrorBoundary>
 * or <SessionStreamErrorBoundary>. Those two wrappers below are tuned for the
 * two specific places the audit calls out; the base class is exported so new
 * call sites can build on it.
 *
 * Class component (hooks can't catch errors). Reset key lets parents force a
 * remount when the underlying input changes (e.g. sessionId).
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Changing this value remounts the boundary and clears the error state. */
  resetKey?: string | number | null;
  /** Custom fallback renderer. Gets the error + a retry callback. */
  fallback?: (error: Error, retry: () => void) => ReactNode;
  /** Optional name -- shown in the default fallback to help triage. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Errors are logged to the console (dev tools aggregate stack traces).
    // We intentionally do NOT swallow -- console.error makes this visible in
    // headless test runs too. console.error is on the eslint allowlist.
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`, error, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.retry);
      return <DefaultFallback error={this.state.error} onRetry={this.retry} label={this.props.label} />;
    }
    return this.props.children;
  }
}

function DefaultFallback({ error, onRetry, label }: { error: Error; onRetry: () => void; label?: string }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 p-8 text-sm text-[var(--fg-muted)]">
      <div className="text-[13px] font-semibold text-[var(--fg)]">
        {label ? `${label} crashed` : "Something went wrong"}
      </div>
      <pre className="max-w-[560px] whitespace-pre-wrap break-words rounded-md border border-[var(--border)] bg-[var(--bg-code,var(--bg-hover))] p-3 text-[11px] leading-relaxed">
        {error.message}
      </pre>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-[var(--border)] px-3 py-1 text-[12px] font-medium text-[var(--fg)] hover:bg-[var(--bg-hover)]"
      >
        Try again
      </button>
    </div>
  );
}

/** Wrap a route-level page subtree. */
export function RouteErrorBoundary({ children, view }: { children: ReactNode; view?: string }) {
  return (
    <ErrorBoundary resetKey={view ?? null} label={view ? `Route:${view}` : "Route"}>
      {children}
    </ErrorBoundary>
  );
}

/** Wrap the session detail / transcript stream. Resets when sessionId changes. */
export function SessionStreamErrorBoundary({ children, sessionId }: { children: ReactNode; sessionId: string | null }) {
  return (
    <ErrorBoundary resetKey={sessionId} label="SessionStream">
      {children}
    </ErrorBoundary>
  );
}
