import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { reportCrash } from './telemetry/report';
import { configureFunnel, LocalAnalytics } from './telemetry/funnel';
import './styles.css';

/**
 * The funnel sink.
 *
 * `LocalAnalytics` rather than nothing, and rather than a vendor: there is no analytics account
 * here, so this keeps the last few hundred milestones in `localStorage` where the dev API can read
 * them back and compute the drop-off table. That makes "we integrated analytics" checkable in a
 * minute instead of a claim resting on a service nobody can log into.
 *
 * A real deployment swaps this one line for `new PostHogSink({ host, projectKey })`. Nothing else
 * in the editor knows or cares which sink it is talking to.
 */
configureFunnel(new LocalAnalytics());

/**
 * The two crashes React never sees (Sprint 33).
 *
 * An error boundary catches what throws *during render*. It does not catch a promise rejected in an
 * event handler, or an exception thrown from a `setTimeout` — and in an editor that loads models,
 * saves to a server and drives a WebGL loop, those are most of them. Without these two listeners,
 * the errors that actually happen in the field are the ones nobody hears about.
 */
window.addEventListener('error', (event) => {
  reportCrash({
    message: event.message,
    stack: event.error instanceof Error ? event.error.stack : undefined,
    where: 'the editor',
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  reportCrash({
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    where: 'a background task',
  });
});

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');

createRoot(container).render(
  <StrictMode>
    {/* The outermost net. Every panel has its own inside `App`; this one catches the rest. */}
    <ErrorBoundary where="the editor">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
