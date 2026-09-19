import React from 'react';

interface ErrorBoundaryProps {
  /** Shown when the child tree crashes. */
  fallback?: React.ReactNode;
  /** When this changes, a previous error is cleared (e.g. doc switch). */
  resetKey?: string | null;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render crashes in the lazy PDF viewer (EmbedPDF engine/worker
 * failures) so one bad document can't blank the whole app.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="pdf-loading-spinner">
            <span>Something went wrong loading this view.</span>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
