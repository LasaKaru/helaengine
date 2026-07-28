import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import type { Scene } from '@helaengine/schema';

enablePatches();

/** How many steps back the editor can go. Bounded so a long session cannot grow without limit. */
export const HISTORY_LIMIT = 100;

export interface HistoryEntry {
  /** Human-readable, shown in the undo tooltip and in devtools. */
  label: string;
  /** Coalescing key: consecutive commits sharing one become a single undo step. */
  group: string | null;
  patches: Patch[];
  inversePatches: Patch[];
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export const EMPTY_HISTORY: History = { past: [], future: [] };

export interface CommitResult {
  scene: Scene;
  history: History;
}

/**
 * Applies a change to the scene and records how to undo it.
 *
 * Patches rather than snapshots: a scene with several hundred objects is not something to copy on
 * every mouse-move, and Immer already computes the forward and inverse diffs as a side effect of
 * the change it is making. The undo stack ends up storing the handful of values that actually
 * moved, which is what makes a 100-step history affordable.
 */
export function commitToHistory(
  scene: Scene,
  history: History,
  label: string,
  group: string | null,
  recipe: (draft: Scene) => void,
): CommitResult {
  const [nextScene, patches, inversePatches] = produceWithPatches(scene, recipe);

  // A change that did not change anything — re-entering the same number in a field, a gizmo
  // that moved zero pixels — must not become an undo step the user has to press through.
  if (patches.length === 0) {
    return { scene: nextScene as Scene, history };
  }

  const previous = history.past.at(-1);
  if (group !== null && previous?.group === group) {
    // Coalesce: the drag as a whole is one undo step, not one per animation frame. Forward
    // patches append; inverse patches prepend, since undo replays them in reverse.
    const merged: HistoryEntry = {
      label: previous.label,
      group,
      patches: [...previous.patches, ...patches],
      inversePatches: [...inversePatches, ...previous.inversePatches],
    };
    return {
      scene: nextScene as Scene,
      history: { past: [...history.past.slice(0, -1), merged], future: [] },
    };
  }

  const past = [...history.past, { label, group, patches, inversePatches }];

  return {
    scene: nextScene as Scene,
    // Any new edit discards the redo branch — the standard linear-history model, and the one
    // users expect from every other tool.
    history: { past: past.slice(-HISTORY_LIMIT), future: [] },
  };
}

export function undo(scene: Scene, history: History): CommitResult {
  const entry = history.past.at(-1);
  if (!entry) return { scene, history };

  return {
    scene: applyPatches(scene, entry.inversePatches),
    history: { past: history.past.slice(0, -1), future: [entry, ...history.future] },
  };
}

export function redo(scene: Scene, history: History): CommitResult {
  const [entry, ...rest] = history.future;
  if (!entry) return { scene, history };

  return {
    scene: applyPatches(scene, entry.patches),
    history: { past: [...history.past, entry], future: rest },
  };
}
