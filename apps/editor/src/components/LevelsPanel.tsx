import { useMemo } from 'react';
import { danglingLevelLinks } from '@helaengine/schema';
import { levelSummaries, useLevelsStore } from '../store/levelsStore';
import { useSceneStore } from '../store/sceneStore';
import { useEditorStore } from '../store/editorStore';

/**
 * The levels in this game.
 *
 * A project starts as one level and most stay that way, so the panel's job when there is nothing to
 * manage is to be small and explain what adding a second one buys. It grows into a list only when
 * somebody takes it up on that.
 *
 * The dangling-link warning is the reason levels live in one document rather than in a folder of
 * files: "this door leads to `caves`, and there is no `caves`" is a question that can only be
 * answered by something holding the whole set, and answering it here means an author finds out
 * while building rather than when a player walks into the door.
 */
export function LevelsPanel(): React.JSX.Element {
  const scene = useSceneStore((state) => state.scene);
  const levelsState = useLevelsStore();
  const walking = useEditorStore((state) => state.walking);

  const rows = useMemo(() => levelSummaries(levelsState, scene), [levelsState, scene]);
  const dangling = useMemo(
    () => danglingLevelLinks(levelsState.project()),
    // Recomputed whenever the set or the live document changes: a graph edit can create one of
    // these, and so can deleting the level it points at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [levelsState.levels, levelsState.startLevelId, scene],
  );

  return (
    <section className="panel" aria-label="Levels">
      <h2>Levels</h2>

      {rows.length === 1 && (
        <p className="panel-hint">
          One level. Add another and a <strong>Load level</strong> node can send the player between
          them, carrying their health, weapons and the graph&rsquo;s variables.
        </p>
      )}

      <ul className="level-list">
        {rows.map((row) => (
          <li key={row.id} className={row.isActive ? 'level-row active' : 'level-row'}>
            <button
              type="button"
              className="level-open"
              aria-label={`Edit ${row.name}`}
              aria-current={row.isActive}
              disabled={row.isActive || walking}
              onClick={() => levelsState.switchTo(row.id)}
            >
              <span className="level-name">{row.name}</span>
              <span className="level-meta">
                {row.objectCount} object{row.objectCount === 1 ? '' : 's'}
                {row.isStart && ' · starts here'}
              </span>
            </button>

            <div className="level-actions">
              <button
                type="button"
                aria-label={`Make ${row.name} the start level`}
                aria-pressed={row.isStart}
                disabled={row.isStart}
                onClick={() => levelsState.setStartLevel(row.id)}
              >
                Start
              </button>
              <button
                type="button"
                className="danger"
                aria-label={`Delete ${row.name}`}
                // A game with no levels is not a game.
                disabled={rows.length <= 1 || walking}
                onClick={() => {
                  if (window.confirm(`Delete "${row.name}"? This cannot be undone.`)) {
                    levelsState.removeLevel(row.id);
                  }
                }}
              >
                Delete
              </button>
            </div>

            <label className="param-row">
              <span className="visually-hidden">{row.name} name</span>
              <input
                type="text"
                aria-label={`${row.name} name`}
                value={row.name}
                onChange={(event) => levelsState.renameLevel(row.id, event.target.value)}
              />
            </label>
          </li>
        ))}
      </ul>

      <button type="button" disabled={walking} onClick={() => levelsState.addLevel()}>
        Add level
      </button>

      {walking && <p className="panel-hint">Leave the preview to change levels.</p>}

      {dangling.length > 0 && (
        <div className="level-problems" role="status" aria-label="Level problems">
          {dangling.map((link) => (
            <p key={`${link.from}-${link.to}`}>
              &ldquo;{link.from}&rdquo; has a door to &ldquo;{link.to}&rdquo;, which is not a level.
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
