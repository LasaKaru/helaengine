import { useRef, useState } from 'react';
import {
  PackParseError,
  parseSkillPack,
  type AssetManifest,
  type SkillPack,
} from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { applyPack, planPack, type PackPlan } from '../packs/applyPack';

/**
 * Skill packs: recipes an author can apply to a level.
 *
 * The panel's real job is the *preview*. A pack changes settings on a level somebody may have spent
 * an afternoon on, so it says what it will do before it does anything — and refuses outright when
 * it cannot do all of it, because half a pack leaves the author with no way to name which half is
 * missing.
 */

interface Loaded {
  pack: SkillPack;
  plan: PackPlan;
}

export function PacksPanel({ manifest }: { manifest: AssetManifest }): React.JSX.Element {
  const scene = useSceneStore((state) => state.scene);
  const replaceScene = useSceneStore((state) => state.replaceScene);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const read = async (file: File): Promise<void> => {
    setApplied(null);
    try {
      const pack = parseSkillPack(await file.text());
      setLoaded({ pack, plan: planPack(pack, manifest) });
      setError(null);
    } catch (cause) {
      setLoaded(null);
      // A `PackParseError` already names the block and the patch. Anything else is unexpected and
      // shown as-is rather than flattened into "could not read file".
      setError(cause instanceof PackParseError ? cause.message : String(cause));
    }
  };

  const apply = (): void => {
    if (!loaded || loaded.plan.problems.length > 0) return;
    // One `replaceScene`, so the whole pack is a single undo step. Half a pack is worse than none.
    replaceScene(applyPack(scene, loaded.pack, manifest), `pack/${loaded.pack.frontmatter.id}`);
    setApplied(loaded.pack.frontmatter.name);
    setLoaded(null);
  };

  return (
    <section className="panel" aria-label="Skill packs">
      <h2>Skill packs</h2>

      <p className="panel-hint">
        A recipe someone worked out once — an atmosphere, a puzzle — as a markdown file. Packs are
        data, never code: a pack can change settings and add content, and cannot introduce anything
        the engine does not already do.
      </p>

      <input
        ref={input}
        type="file"
        accept=".md,text/markdown"
        aria-label="Open a skill pack"
        className="visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void read(file);
          // Cleared so re-picking the same file after an edit still fires a change.
          event.target.value = '';
        }}
      />
      <button type="button" onClick={() => input.current?.click()}>
        Open a pack…
      </button>

      {applied && (
        <p className="pack-applied" role="status">
          Applied &ldquo;{applied}&rdquo;. Ctrl+Z undoes the whole thing.
        </p>
      )}

      {error && (
        <p className="pack-error" role="alert">
          {error}
        </p>
      )}

      {loaded && (
        <div className="pack-preview">
          <h3>{loaded.pack.frontmatter.name}</h3>
          <p className="pack-description">{loaded.pack.frontmatter.description}</p>

          <h4>What it will change</h4>
          <ol className="pack-steps">
            {loaded.plan.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>

          {loaded.plan.problems.length > 0 && (
            <div className="pack-problems" role="status" aria-label="Pack problems">
              {loaded.plan.problems.map((problem) => (
                <p key={problem}>{problem}</p>
              ))}
            </div>
          )}

          <div className="pack-actions">
            <button
              type="button"
              disabled={loaded.plan.problems.length > 0}
              onClick={apply}
              aria-label={`Apply ${loaded.pack.frontmatter.name}`}
            >
              Apply
            </button>
            <button type="button" onClick={() => setLoaded(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
