import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import {
  CURRENT_PROJECT_VERSION,
  GameProjectSchema,
  asProject,
  type GameProject,
  type Scene,
} from '@helaengine/schema';
import { createEmptyScene, useSceneStore } from './sceneStore';

/**
 * The other levels in this game.
 *
 * ## Why the active level is not stored here
 *
 * `sceneStore` is the level being edited, and it stays that way. Every panel, every gizmo, undo,
 * the collaboration CRDT and the export all read `sceneStore.scene`, and moving the active level
 * into a list would mean rewriting all of them to ask "which one" — for a feature most projects
 * never use.
 *
 * So this store holds the *set*, and the entry matching `activeLevelId` is a stale snapshot: it is
 * whatever the level looked like when it was last switched away from. `project()` reads the live
 * one out of `sceneStore` on the way past, which is the single place that reconciliation happens.
 *
 * The alternative — mirroring every scene edit into this list — would be a second copy of the
 * document updated sixty times a second while a gizmo is dragged, and two copies of a document is
 * one document and one bug.
 */

export interface LevelSummary {
  id: string;
  name: string;
  objectCount: number;
  isStart: boolean;
  isActive: boolean;
}

export interface LevelsState {
  /** Every level, in editor order. The active one's entry may be stale — see the note above. */
  levels: Scene[];
  activeLevelId: string;
  startLevelId: string;

  /** Replaces the whole set, and makes the start level active. Used when a project is opened. */
  adoptProject(project: GameProject): void;
  /** Reads either shape — a project or a lone scene — and adopts it. */
  adoptDocument(document: unknown): void;

  /** The project as it stands, with the active level taken live from `sceneStore`. */
  project(): GameProject;

  addLevel(name?: string): string;
  removeLevel(levelId: string): void;
  renameLevel(levelId: string, name: string): void;
  setStartLevel(levelId: string): void;
  /** Saves the current level back into the set and loads another. */
  switchTo(levelId: string): void;
}

/** A level id nothing in the set is using. */
function freshId(levels: readonly Scene[]): string {
  const taken = new Set(levels.map((level) => level.sceneId));
  for (let index = 1; ; index += 1) {
    const candidate = `level_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const useLevelsStore = create<LevelsState>()(
  devtools(
    (set, get) => ({
      levels: [],
      activeLevelId: '',
      startLevelId: '',

      adoptProject: (project) => {
        const start = project.levels.find((level) => level.sceneId === project.startLevelId);
        const active = start ?? project.levels[0]!;
        set(
          {
            levels: project.levels,
            activeLevelId: active.sceneId,
            startLevelId: project.startLevelId,
          },
          false,
          'levels/adopt',
        );
        useSceneStore.getState().setScene(active);
      },

      adoptDocument: (document) => {
        get().adoptProject(asProject(document));
      },

      project: () => {
        const { levels, activeLevelId, startLevelId } = get();
        const live = useSceneStore.getState().scene;

        // A project with no levels at all cannot exist, and a project the user has never opened the
        // Levels panel on has an empty set here — so the live scene is the whole game.
        if (levels.length === 0) {
          return {
            version: CURRENT_PROJECT_VERSION,
            name: live.name,
            startLevelId: live.sceneId,
            levels: [live],
          };
        }

        // The one place the stale snapshot is reconciled with the live document.
        const merged = levels.map((level) => (level.sceneId === activeLevelId ? live : level));
        return GameProjectSchema.parse({
          version: CURRENT_PROJECT_VERSION,
          name: live.name,
          startLevelId: merged.some((level) => level.sceneId === startLevelId)
            ? startLevelId
            : merged[0]!.sceneId,
          levels: merged,
        });
      },

      addLevel: (name) => {
        const { levels, activeLevelId } = get();
        const live = useSceneStore.getState().scene;

        // Seeded from the set the game already has, which for a project that has never been split
        // is just the level on screen.
        const existing =
          levels.length === 0
            ? [live]
            : levels.map((level) => (level.sceneId === activeLevelId ? live : level));

        const id = freshId(existing);
        const level: Scene = {
          ...createEmptyScene(name ?? `Level ${existing.length + 1}`),
          sceneId: id,
        };

        set(
          {
            levels: [...existing, level],
            // Not switched to. Adding a level while mid-edit and being thrown into an empty field
            // is the kind of helpfulness that loses work.
            activeLevelId: get().activeLevelId || live.sceneId,
            startLevelId: get().startLevelId || live.sceneId,
          },
          false,
          'levels/add',
        );
        return id;
      },

      removeLevel: (levelId) => {
        const { levels, activeLevelId, startLevelId } = get();
        // A game with no levels is not a game. The last one cannot be removed.
        if (levels.length <= 1) return;

        const remaining = levels.filter((level) => level.sceneId !== levelId);
        const nextStart = remaining.some((level) => level.sceneId === startLevelId)
          ? startLevelId
          : remaining[0]!.sceneId;

        set({ levels: remaining, startLevelId: nextStart }, false, 'levels/remove');

        // Deleting the level you are editing has to put you somewhere. The start level is the least
        // surprising answer, and leaving the editor pointed at a document no longer in the set is
        // the one thing that would definitely be wrong.
        if (levelId === activeLevelId) {
          const next = remaining.find((level) => level.sceneId === nextStart) ?? remaining[0]!;
          set({ activeLevelId: next.sceneId }, false, 'levels/removeActive');
          useSceneStore.getState().setScene(next);
        }
      },

      renameLevel: (levelId, name) => {
        // The active level's name lives in the live document, not in the snapshot — renaming it
        // through the snapshot would be overwritten the next time the two are reconciled.
        if (levelId === get().activeLevelId) {
          useSceneStore.getState().setName(name);
          return;
        }
        set(
          (state) => ({
            levels: state.levels.map((level) =>
              level.sceneId === levelId ? { ...level, name } : level,
            ),
          }),
          false,
          'levels/rename',
        );
      },

      setStartLevel: (startLevelId) => set({ startLevelId }, false, 'levels/start'),

      switchTo: (levelId) => {
        const { levels, activeLevelId } = get();
        if (levelId === activeLevelId) return;

        const target = levels.find((level) => level.sceneId === levelId);
        if (!target) return;

        // Save first, load second. The other order loses every edit made since the last switch.
        const live = useSceneStore.getState().scene;
        set(
          {
            levels: levels.map((level) => (level.sceneId === activeLevelId ? live : level)),
            activeLevelId: levelId,
          },
          false,
          'levels/switch',
        );

        // `setScene` rather than `replaceScene`: this is a different document, and its undo history
        // is not the one being left behind. Carrying the stack across would let Ctrl+Z on the caves
        // undo something in the forest.
        useSceneStore.getState().setScene(target);
      },
    }),
    { name: 'levels' },
  ),
);

/** Rows for the panel, with the active level's name read live. */
export function levelSummaries(state: LevelsState, liveScene: Scene): LevelSummary[] {
  const levels = state.levels.length === 0 ? [liveScene] : state.levels;
  const startId = state.startLevelId || liveScene.sceneId;

  return levels.map((level) => {
    const active = level.sceneId === (state.activeLevelId || liveScene.sceneId);
    const source = active ? liveScene : level;
    return {
      id: level.sceneId,
      name: source.name,
      objectCount: source.objects.length,
      isStart: level.sceneId === startId,
      isActive: active,
    };
  });
}
