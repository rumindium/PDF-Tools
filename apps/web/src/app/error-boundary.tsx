import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button } from '../components/ui';

/**
 * Root error boundary.
 *
 * A tool UI is mostly one long form, so a render-time crash in an option panel must not blank the whole page and
 * lose the user's file selection. The boundary shows what happened and offers a retry; the file list lives in the
 * route's own state and is not part of this subtree.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console only: the API already has server-side logging, and shipping a client error reporter is a
    // separate concern with its own privacy review.
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="container page stack">
        <Alert tone="danger" title="This screen stopped working">
          <p className="small">{this.state.error.message}</p>
          <p className="small" style={{ marginTop: 6 }}>
            Reloading the page is safe: uploads and finished results are tracked by the server, not by this tab.
          </p>
        </Alert>
        <div className="row">
          <Button variant="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      </div>
    );
  }
}
