import { useEffect, useMemo, useState } from 'react';
import type { AssetManifest } from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import {
  collectUsedAssets,
  DEFAULT_EXPORT_OPTIONS,
  slugify,
  type ExportOptions,
} from '../export/bundle';
import { runExport } from '../export/runExport';

type Phase = 'idle' | 'working' | 'done' | 'error';

/**
 * The export dialog.
 *
 * It shows what is about to be shipped *before* shipping it — how many assets, how many are being
 * left out, and how big the result is likely to be. An export that takes ten seconds and produces
 * a file of unexplained size is one somebody has to unzip to understand.
 */
export function ExportWizard({
  manifest,
  onClose,
}: {
  manifest: AssetManifest;
  onClose(): void;
}): React.JSX.Element {
  const scene = useSceneStore((state) => state.scene);
  const [options, setOptions] = useState<ExportOptions>({
    ...DEFAULT_EXPORT_OPTIONS,
    projectName: scene.name || DEFAULT_EXPORT_OPTIONS.projectName,
  });
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<{ filename: string; bytes: number; warnings: string[] } | null>(
    null,
  );
  const [error, setError] = useState<string>('');

  const summary = useMemo(() => collectUsedAssets(scene, manifest), [scene, manifest]);

  // Escape closes, like every other modal in the editor. Not while an export is running, though —
  // dismissing the dialog mid-write would leave somebody wondering whether they got a file.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && phase !== 'working') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase]);

  const start = async (): Promise<void> => {
    setPhase('working');
    setError('');
    try {
      const outcome = await runExport(scene, manifest, options);
      setResult({
        filename: outcome.filename,
        bytes: outcome.bytes,
        warnings: outcome.plan.warnings,
      });
      setPhase('done');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase('error');
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => phase !== 'working' && onClose()}>
      <div
        className="modal export-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Export"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Export</h2>

        <label className="param-row">
          <span>Project name</span>
          <input
            type="text"
            aria-label="Project name"
            value={options.projectName}
            onChange={(event) => setOptions({ ...options, projectName: event.target.value })}
          />
        </label>
        <p className="panel-hint">
          Downloads as <code>{slugify(options.projectName)}.zip</code>
        </p>

        <label className="param-check">
          <input
            type="checkbox"
            checked={options.includeSource}
            onChange={(event) => setOptions({ ...options, includeSource: event.target.checked })}
          />
          Include a readable copy of scene.json
        </label>

        <label className="param-check">
          <input
            type="checkbox"
            checked={options.minify}
            onChange={(event) => setOptions({ ...options, minify: event.target.checked })}
          />
          Minify main.js
        </label>

        <div className="export-summary" role="status">
          <p>
            {scene.objects.length} object{scene.objects.length === 1 ? '' : 's'} ·{' '}
            <strong>{summary.used.length}</strong> asset{summary.used.length === 1 ? '' : 's'}{' '}
            included
            {summary.usedIds.length < manifest.assets.length && (
              <>
                {' '}
                · {manifest.assets.length - summary.used.length} left out because this scene does
                not use them
              </>
            )}
          </p>
          {summary.missing.length > 0 && (
            <p className="panel-hint error">
              Missing from the library: {summary.missing.join(', ')}. These will render as
              placeholders.
            </p>
          )}
        </div>

        {phase === 'error' && (
          <p className="panel-hint error" role="alert">
            Export failed: {error}
          </p>
        )}

        {phase === 'done' && result && (
          <div className="export-summary" role="status">
            <p>
              Downloaded <strong>{result.filename}</strong> ({formatBytes(result.bytes)}).
            </p>
            <p className="panel-hint">
              Unzip it and run <code>npx serve .</code> inside the folder — browsers refuse to load
              ES modules over <code>file://</code>.
            </p>
            {result.warnings.map((warning) => (
              <p className="panel-hint error" key={warning}>
                {warning}
              </p>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={phase === 'working'}>
            {phase === 'done' ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void start()}
            disabled={phase === 'working'}
          >
            {phase === 'working' ? 'Exporting…' : phase === 'done' ? 'Export again' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
