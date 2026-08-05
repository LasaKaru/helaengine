import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExportJob, ExportStage } from '@helaengine/schema';
import { CloudExports, QuotaExceeded, type ExportQuota } from '../storage/cloudExports';
import { currentSession } from '../storage/backend';
import { useProjectStore } from '../store/projectStore';

/**
 * Building an export on the server, with a bar to watch.
 *
 * Offered *alongside* the browser export rather than instead of it. The in-tab exporter is still
 * the better answer for a small level — instant, no account, works on a train — and replacing it
 * would take that away to solve a problem most projects do not have. This is for the ones that do:
 * a build large enough that assembling it in tab memory is a gamble, or long enough that closing
 * the tab should not cost it.
 */

const STAGE_TEXT: Record<ExportStage, string> = {
  queued: 'Waiting for a build server…',
  loading: 'Loading your project…',
  building: 'Building the game…',
  compressing: 'Compressing…',
  storing: 'Almost done…',
  done: 'Ready',
};

export function ServerExport(): React.JSX.Element | null {
  const projectId = useProjectStore((state) => state.projectId);
  const session = currentSession();

  const [quota, setQuota] = useState<ExportQuota | null>(null);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState(false);

  // Aborted when the dialog closes, so a poll loop does not outlive the component it updates.
  const watching = useRef<AbortController | null>(null);
  useEffect(() => () => watching.current?.abort(), []);

  // Memoised on the session's identity: a fresh client per render would make `start`'s dependency
  // array change every time and defeat the memoisation it is wrapped in.
  const client = useMemo(() => (session ? new CloudExports(session) : null), [session]);
  const available = client !== null && projectId !== null;

  useEffect(() => {
    if (!client) return;
    let live = true;

    // Shown before anything is pressed, so running out of exports is something somebody saw
    // coming rather than something that happened to them.
    client
      .quota()
      .then((found) => {
        if (live) setQuota(found);
      })
      .catch(() => {
        // Not fatal and not worth a banner: the button still works, and the API will refuse with a
        // proper message if there is nothing left.
      });

    return () => {
      live = false;
    };
  }, [client]);

  const start = useCallback(async () => {
    if (!client || !projectId) return;

    setBusy(true);
    setError('');
    setJob(null);

    const controller = new AbortController();
    watching.current?.abort();
    watching.current = controller;

    try {
      const requested = await client.request(projectId);
      setJob(requested);

      const finished = await client.waitFor(requested.id, {
        onProgress: setJob,
        signal: controller.signal,
      });
      setJob(finished);

      if (finished.status === 'failed') {
        // The worker's own sentence, which says what went wrong with *this* build. A generic
        // "export failed" would throw away the only part somebody can act on.
        setError(finished.error ?? 'That export failed.');
      }

      // Refreshed after a build rather than decremented locally: the server is the one counting,
      // and a number this component maintained itself would drift from it.
      setQuota(await client.quota());
    } catch (problem: unknown) {
      if (problem instanceof DOMException && problem.name === 'AbortError') return;
      setError(
        problem instanceof QuotaExceeded
          ? problem.message
          : problem instanceof Error
            ? problem.message
            : String(problem),
      );
    } finally {
      setBusy(false);
    }
  }, [client, projectId]);

  // Nothing to offer without an account and a cloud project. Not an error state — the browser
  // export above is the whole feature for everybody else.
  if (!available) return null;

  const running = job !== null && (job.status === 'queued' || job.status === 'processing');

  return (
    <section className="server-export" aria-label="Build on the server">
      <h3>Build on the server</h3>
      <p className="panel-hint">
        For large projects. The build runs on a build server, so it keeps going if you close this
        tab — and it will not run your browser out of memory.
      </p>

      {quota && (
        <p className="export-quota" data-testid="export-quota">
          {quota.remaining} of {quota.limit} exports left this period
          {quota.tier === 'free' ? ' on the free plan' : ` on the ${quota.tier} plan`}.
        </p>
      )}

      <button type="button" onClick={() => void start()} disabled={busy}>
        {busy ? 'Building…' : 'Build on the server'}
      </button>

      {running && job && (
        <div className="export-progress" data-testid="export-progress">
          {/*
            A real element with a real value rather than an animated stripe. The stages come from
            the worker, so the bar moves when the work moves — see `ExportStage` for why a
            fabricated percentage is worse than a coarse honest one.
          */}
          <progress value={job.progress} max={100} aria-label="Export progress" />
          <span data-stage={job.stage}>{STAGE_TEXT[job.stage]}</span>
          {job.attempts > 1 && (
            // Said out loud rather than hidden: a build that is quietly on its third attempt looks
            // like one that has stalled.
            <span className="export-retry">Retrying (attempt {job.attempts})…</span>
          )}
        </div>
      )}

      {job?.status === 'done' && (
        <p className="export-ready" data-testid="export-ready">
          {/*
            A plain link, so the browser's own download manager handles it. Fetching the zip into a
            Blob first would put the whole build back in tab memory, which is the thing this feature
            exists to avoid.
          */}
          <a href={client!.downloadUrl(job.id)} download>
            Download ({formatBytes(job.artifactBytes ?? 0)})
          </a>{' '}
          <span className="panel-hint">
            This link works for 24 hours. Builds expire so they do not become storage.
          </span>
        </p>
      )}

      {error !== '' && (
        <p className="export-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
