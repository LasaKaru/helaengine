import { Component, type ErrorInfo, type ReactNode } from 'react';
import { currentCorrelationId, reportCrash } from '../telemetry/report';

/**
 * The screen a user sees instead of a white page.
 *
 * React unmounts the whole tree when a render throws, which in an editor means the level, the
 * panels and the toolbar all vanish at once — and the work in the store is still there, unreachable,
 * until the tab is reloaded. That is the specific outcome this exists to prevent: **a crash must
 * not silently look like lost work.**
 *
 * A class, because `componentDidCatch` has no hook equivalent — this is one of the two places React
 * still requires one, and pretending otherwise would mean a dependency to hide four lines.
 */

interface Props {
  /** Named in the message, so "the properties panel broke" is distinguishable from "everything did". */
  where: string;
  children: ReactNode;
  /** Rendered instead of the default screen. Used by panels, which should not offer a page reload. */
  fallback?: (state: { message: string; retry: () => void }) => ReactNode;
}

interface State {
  error: Error | null;
  correlationId: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, correlationId: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The correlation id is captured here rather than read at render time, so the id shown to the
    // user is the one from when it broke — not from whatever request happened afterwards.
    const correlationId = currentCorrelationId();
    this.setState({ correlationId });
    reportCrash({
      message: error.message,
      stack: `${error.stack ?? ''}\n\nComponent stack:${info.componentStack ?? ''}`,
      where: this.props.where,
      correlationId,
    });
  }

  private readonly retry = (): void => {
    // Clearing the error re-renders the children. It works when the cause was transient — a panel
    // handed a half-loaded object — and fails identically when it was not, which is honest: the
    // alternative is a button that reloads the page and takes unsaved work with it.
    this.setState({ error: null, correlationId: null });
  };

  override render(): ReactNode {
    const { error, correlationId } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback({ message: error.message, retry: this.retry });
    }

    return (
      <div className="crash-screen" role="alert" data-testid="crash-screen">
        <h1>Something in {this.props.where} broke.</h1>
        <p>
          Your project is still saved — this is the editor’s interface failing, not your work. Try
          again, and if it keeps happening, reload the page.
        </p>
        <pre className="crash-message">{error.message}</pre>
        {correlationId && (
          // The one thing that turns "it crashed" into a searchable incident. Shown rather than
          // only sent, because the user is often the fastest route to an operator.
          <p className="panel-hint">
            Reference: <code data-testid="crash-correlation">{correlationId}</code>
          </p>
        )}
        <div className="crash-actions">
          <button type="button" onClick={this.retry}>
            Try again
          </button>
          <button type="button" onClick={() => window.location.reload()}>
            Reload the editor
          </button>
        </div>
      </div>
    );
  }
}
