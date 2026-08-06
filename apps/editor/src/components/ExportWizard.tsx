import { useEffect, useMemo, useState } from 'react';
import { track, trackFirst } from '../telemetry/funnel';
import type { AssetManifest, Visibility } from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { ServerExport } from './ServerExport';
import {
  collectUsedAssets,
  DEFAULT_EXPORT_OPTIONS,
  formatBytes,
  slugify,
  SIZE_WARN_BYTES,
  type ExportOptions,
} from '@helaengine/export';
import { planExport, runExport } from '../export/runExport';
import { publishBuild, ShareFailed } from '../export/publish';
import { explainBlock, runGate, type GateResult, type GateStage } from '../validation/gate';

/**
 * Where the dialog is.
 *
 * `checking` is the state this sprint adds, and it is the one that has to be visible: a build is
 * played before anybody can download it, that takes a few seconds, and a few seconds of nothing is
 * indistinguishable from broken.
 */
type Phase = 'idle' | 'checking' | 'blocked' | 'working' | 'done' | 'error';

/**
 * What the button says in each state.
 *
 * A table rather than nested ternaries, because "never a spinner that never resolves" starts with
 * every state having a name somebody wrote on purpose. `blocked` says "Check again" rather than
 * "Export": pressing it re-runs the gate, which is the only honest thing it could do.
 */
const BUTTON_TEXT: Record<Phase, string> = {
  idle: 'Check and export',
  checking: 'Checking…',
  blocked: 'Check again',
  working: 'Exporting…',
  done: 'Export again',
  error: 'Try again',
};

const STAGE_TEXT: Record<GateStage['kind'], string> = {
  playing: 'Playing your game…',
  thinking: 'Working out what went wrong…',
  fixing: 'Trying a fix…',
  done: 'Finishing up…',
};

const CHECK_MARK: Record<string, string> = {
  passed: '✓',
  failed: '✗',
  skipped: '–',
  'not-applicable': '·',
};

/** The checks in the user's words. The ids are for logs; these are for people. */
const CHECK_LABEL: Record<string, string> = {
  'page-loads': 'The game starts without errors',
  'assets-resolve': 'Every model loads',
  'scene-loaded': 'The world builds',
  'physics-initialises': 'Physics starts',
  'player-moves': 'The player can move',
  'player-survives-idle': 'The player is safe at the start point',
  'memory-stable': 'Memory stays steady',
};

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
  const replaceScene = useSceneStore((state) => state.replaceScene);
  const [options, setOptions] = useState<ExportOptions>({
    ...DEFAULT_EXPORT_OPTIONS,
    projectName: scene.name || DEFAULT_EXPORT_OPTIONS.projectName,
  });
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<{
    filename: string;
    bytes: number;
    warnings: string[];
  } | null>(null);
  const [error, setError] = useState<string>('');
  const [stage, setStage] = useState<GateStage>({ kind: 'done' });
  const [gate, setGate] = useState<GateResult | null>(null);
  const [shared, setShared] = useState<{ url: string; visibility: Visibility } | null>(null);
  const [visibility, setVisibility] = useState<Visibility>('unlisted');

  const summary = useMemo(() => collectUsedAssets(scene, manifest), [scene, manifest]);

  /**
   * A size estimate, before anything is fetched.
   *
   * Estimated rather than measured because measuring means downloading every asset — which is the
   * export. Somebody deciding whether to press the button deserves a number first, and a rough one
   * they get instantly beats an exact one they get afterwards.
   */
  const estimatedBytes = useMemo(() => {
    const runtime = options.mode === 'game' ? 3_200_000 : 920_000;
    const perAsset = summary.used.reduce(
      (sum, asset) => sum + (asset.polyCount ? asset.polyCount * 40 : 8_000),
      0,
    );
    return runtime + perAsset + JSON.stringify(scene).length * (options.includeSource ? 2 : 1);
  }, [options.mode, options.includeSource, summary.used, scene]);

  // Escape closes, like every other modal in the editor. Not while an export is running, though —
  // dismissing the dialog mid-write would leave somebody wondering whether they got a file.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && phase !== 'working' && phase !== 'checking') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase]);

  /**
   * Plays the game, then exports it — in that order, and only in that order.
   *
   * The gate is not advisory. A build that has not been proved to run does not get a download
   * button, because "here is your game, we have no idea whether it works" is the promise this
   * product exists not to make. A repair, if one was needed, is applied to the real document and
   * disclosed before the file is written.
   */
  const start = async (deliver: 'download' | 'share'): Promise<void> => {
    // Raised on intent, and paired with a completion event below. The gap between the two is where
    // a build that fails its own release gate lives, and that gap is the most useful thing this
    // funnel can show — "people press Export and never get a file" is a different problem from
    // "people never press Export".
    trackFirst('export_started', { exportMode: options.mode, objectCount: scene.objects.length });
    setPhase('checking');
    setError('');
    setGate(null);
    setShared(null);

    try {
      const outcome = await runGate({
        scene,
        manifest,
        onStage: setStage,
      });
      setGate(outcome);

      if (!outcome.releasable) {
        setPhase('blocked');
        track('export_completed', { exportMode: options.mode, outcome: 'failed' });
        return;
      }

      // Kept in the user's project, not just in the exported copy. A repair that only exists inside
      // a zip is one they hit again the next time they press Export.
      if (outcome.disclosure.length > 0) {
        replaceScene(outcome.scene, 'gate/repair');
      }

      setPhase('working');

      if (deliver === 'share') {
        // The same plan the zip would have been built from, sent as JSON instead of compressed.
        const plan = await planExport(outcome.scene, manifest, options);
        const published = await publishBuild({
          plan,
          sceneName: options.projectName,
          report: outcome.report,
          visibility,
        });
        setShared({ url: published.url, visibility });
        setResult({
          filename: published.build.id,
          bytes: published.build.sizeBytes,
          warnings: plan.warnings,
        });
      } else {
        const written = await runExport(outcome.scene, manifest, options);
        setResult({
          filename: written.filename,
          bytes: written.bytes,
          warnings: written.plan.warnings,
        });
      }
      setPhase('done');
      track('export_completed', { exportMode: options.mode, outcome: 'succeeded' });
    } catch (caught) {
      const message =
        caught instanceof ShareFailed
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : String(caught);
      setError(message);
      setPhase('error');
      track('export_completed', { exportMode: options.mode, outcome: 'failed' });
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={() => phase !== 'working' && phase !== 'checking' && onClose()}
    >
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

        <div className="gizmo-modes" role="group" aria-label="Export mode">
          {(
            [
              ['game', 'Playable game', 'Physics, behaviours, menus, combat and sound.'],
              ['static', 'Static scene', 'Renders the world. Smaller, and nothing runs.'],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              title={hint}
              className={options.mode === value ? 'active' : ''}
              aria-pressed={options.mode === value}
              onClick={() => setOptions({ ...options, mode: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="panel-hint">
          {options.mode === 'game'
            ? 'Includes the physics engine — about 3 MB before compression.'
            : 'No physics engine: about a third the size, and Play does nothing.'}
        </p>

        <label className="param-check">
          <input
            type="checkbox"
            aria-label="Readable level listing"
            checked={options.codeStyle === 'readable'}
            onChange={(event) =>
              setOptions({ ...options, codeStyle: event.target.checked ? 'readable' : 'document' })
            }
          />
          Also write the level out as readable code
        </label>

        <label className="param-check">
          <input
            type="checkbox"
            checked={options.includeSource}
            onChange={(event) => setOptions({ ...options, includeSource: event.target.checked })}
          />
          Include a readable copy of scene.json
        </label>

        <div className="gizmo-modes" role="group" aria-label="Who can play it">
          {(
            [
              ['unlisted', 'Anyone with the link', 'Not listed anywhere. The link is the key.'],
              ['public', 'Listed publicly', 'Appears in the public list of shared games.'],
              ['org', 'My team only', 'Needs the team token the share service was started with.'],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              title={hint}
              className={visibility === value ? 'active' : ''}
              aria-pressed={visibility === value}
              onClick={() => setVisibility(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="panel-hint">Applies to the share link. A download is yours either way.</p>

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
          <p className="panel-hint">
            About {formatBytes(estimatedBytes)} before compression.
            {estimatedBytes >= SIZE_WARN_BYTES
              ? ' That is large enough to be awkward to host — consider splitting the scene.'
              : ''}
          </p>
          {summary.missing.length > 0 && (
            <p className="panel-hint error">
              Missing from the library: {summary.missing.join(', ')}. These will render as
              placeholders.
            </p>
          )}
        </div>

        {phase === 'checking' && (
          <div className="export-summary" role="status" aria-live="polite">
            <p>
              <strong>{STAGE_TEXT[stage.kind]}</strong>
              {stage.kind !== 'done' && stage.attempt > 0 ? ` (attempt ${stage.attempt} of 3)` : ''}
            </p>
            <p className="panel-hint">
              Your game is being played before you download it — the start point, the physics, the
              models and whether the player can actually move.
            </p>
          </div>
        )}

        {phase === 'blocked' && gate && (
          <div className="export-summary" role="alert">
            <p className="panel-hint error">
              <strong>This build was not exported.</strong> {explainBlock(gate.report).headline}
            </p>
            <p className="panel-hint">{explainBlock(gate.report).suggestion}</p>
            <ul className="check-list">
              {gate.report.checks.map((item) => (
                <li key={item.id} className={`check-${item.status}`}>
                  <span aria-hidden="true">{CHECK_MARK[item.status]}</span> {CHECK_LABEL[item.id]}
                </li>
              ))}
            </ul>
            {gate.log.attempts.length > 0 && (
              <p className="panel-hint">
                We tried to fix it automatically {gate.log.attempts.length}{' '}
                {gate.log.attempts.length === 1 ? 'time' : 'times'} and could not.
              </p>
            )}
          </div>
        )}

        {gate && gate.disclosure.length > 0 && phase !== 'blocked' && (
          <div className="export-summary" role="status">
            <p>
              <strong>We changed your scene to make it work:</strong>
            </p>
            <ul className="check-list">
              {gate.disclosure.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="panel-hint">
              The change is in your project, not only in the download — undo it with Ctrl+Z if you
              would rather fix it yourself.
            </p>
          </div>
        )}

        {phase === 'error' && (
          <p className="panel-hint error" role="alert">
            Export failed: {error}
          </p>
        )}

        {phase === 'done' && shared && (
          <div className="export-summary" role="status">
            <p>
              <strong>Your game is live.</strong>
            </p>
            <p>
              <a href={shared.url} target="_blank" rel="noreferrer">
                {shared.url}
              </a>
            </p>
            <p className="panel-hint">
              {shared.visibility === 'unlisted'
                ? 'Anyone with this link can play it. It is not listed anywhere, so the link is the only way in — treat it like a password.'
                : shared.visibility === 'public'
                  ? 'Listed publicly. Anyone can find and play it.'
                  : 'Only people with your team token can open it.'}
            </p>
          </div>
        )}

        {phase === 'done' && result && !shared && (
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

        {/*
          Offered beside the in-tab export rather than instead of it. Renders nothing at all
          without an account and a cloud project, which is most people most of the time.
        */}
        <ServerExport />

        <div className="modal-actions">
          <button
            type="button"
            onClick={onClose}
            disabled={phase === 'working' || phase === 'checking'}
          >
            {phase === 'done' ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => void start('share')}
            disabled={phase === 'working' || phase === 'checking'}
          >
            {phase === 'working' ? 'Sharing…' : 'Check and share a link'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void start('download')}
            disabled={phase === 'working' || phase === 'checking'}
          >
            {BUTTON_TEXT[phase]}
          </button>
        </div>
      </div>
    </div>
  );
}
