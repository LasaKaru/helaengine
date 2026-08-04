import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useSceneStore } from '../store/sceneStore';
import { isCloud, projectHistory, restoreVersion } from '../storage/backend';
import type { VersionSummary } from '../storage/cloudProjects';

/**
 * Every save, and a way back to any of them.
 *
 * "Restore" appends rather than rewinds: the old content becomes a *new* version at the top of the
 * list, and everything between stays exactly where it was. That is a property of the API rather
 * than of this panel, but it is the thing the panel has to be honest about — a history that a
 * button can shorten is a history nobody trusts.
 */
export function VersionHistory({ onClose }: { onClose(): void }): React.JSX.Element {
  const projectId = useProjectStore((state) => state.projectId);
  const setScene = useSceneStore((state) => state.setScene);

  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!projectId) return;
    void projectHistory(projectId)
      .then(setVersions)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, [projectId]);

  const restore = async (version: number): Promise<void> => {
    if (!projectId) return;
    setBusy(true);
    setError('');
    try {
      const scene = await restoreVersion(projectId, version);
      // `setScene`, not `replaceScene`: this is a different document arriving, and the undo history
      // of the one being replaced does not describe it.
      setScene(scene);
      setVersions(await projectHistory(projectId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => !busy && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Version history"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Version history</h2>

        {!isCloud() && (
          <p className="panel-hint">
            This project is stored in this browser, which keeps only its current state. Sign in to
            get a version for every save.
          </p>
        )}

        {error && (
          <p className="panel-hint error" role="alert">
            {error}
          </p>
        )}

        {versions === null && isCloud() && <p className="panel-hint">Loading…</p>}

        {versions !== null && versions.length === 0 && isCloud() && (
          <p className="panel-hint">No saved versions yet.</p>
        )}

        {versions !== null && versions.length > 0 && (
          <ul className="version-list">
            {versions.map((entry, index) => (
              <li key={entry.version}>
                <span className="version-number">v{entry.version}</span>
                <span className="version-when">{new Date(entry.createdAt).toLocaleString()}</span>
                <span className="version-who">{entry.authorName}</span>
                {index === 0 ? (
                  <span className="panel-hint">current</span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void restore(entry.version)}
                    aria-label={`Restore version ${entry.version}`}
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="panel-hint">
          Restoring adds a new version holding the old content. Nothing in this list is ever
          removed.
        </p>

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
