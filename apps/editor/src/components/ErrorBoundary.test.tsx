import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { rememberCorrelationId } from '../telemetry/report';

/**
 * What a user sees when a panel throws.
 *
 * The behaviour under test is not "React catches errors" — it does — but the product decision built
 * on top of it: a crash shows a screen that says the work is safe, names the failure, and offers a
 * reference an operator can search for.
 */

let thrown = true;

function Boom(): React.JSX.Element {
  if (thrown) throw new Error('cannot read properties of undefined');
  return <p>Recovered</p>;
}

beforeEach(() => {
  thrown = true;
  // React logs a caught error to the console by design. Silenced so a passing test is quiet and a
  // failing one is readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the error boundary', () => {
  it('shows the panel that broke, and says the project is still saved', () => {
    render(
      <ErrorBoundary where="the properties panel">
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('crash-screen')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveTextContent('the properties panel');
    // The sentence that stops somebody force-quitting the tab.
    expect(screen.getByText(/still saved/i)).toBeInTheDocument();
    expect(screen.getByText('cannot read properties of undefined')).toBeInTheDocument();
  });

  it('offers the reference an operator can search the logs for', () => {
    rememberCorrelationId(
      new Response('{}', { headers: { 'x-correlation-id': 'hela_abcdef0123456789' } }),
    );

    render(
      <ErrorBoundary where="the level view">
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('crash-correlation')).toHaveTextContent('hela_abcdef0123456789');
  });

  it('renders the children again when the cause has gone', async () => {
    render(
      <ErrorBoundary where="the level view">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('crash-screen')).toBeInTheDocument();

    thrown = false;
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    // Retry rather than reload, because a reload costs whatever is not yet saved.
    expect(screen.getByText('Recovered')).toBeInTheDocument();
    expect(screen.queryByTestId('crash-screen')).not.toBeInTheDocument();
  });

  it('leaves everything else standing', () => {
    render(
      <div>
        <ErrorBoundary where="the properties panel">
          <Boom />
        </ErrorBoundary>
        <p>The level view</p>
      </div>,
    );

    // The whole reason there is a boundary per panel: a broken panel is a broken panel, not a
    // white page with a scene still in memory behind it.
    expect(screen.getByText('The level view')).toBeInTheDocument();
  });
});
