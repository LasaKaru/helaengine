import { create } from 'zustand';
import { trackFirst } from '../telemetry/funnel';
import { devtools } from 'zustand/middleware';
import {
  CURRENT_SCENE_VERSION,
  SceneSchema,
  UnlockableSchema,
  WeaponSchema,
  type Environment,
  type GameConfig,
  type ObjectPhysics,
  type Player,
  type Scene,
  type SceneObject,
  type Terrain,
  type Transform,
  type Trigger,
  type HudElement,
  type AudioConfig,
  type Inventory,
  type Unlockable,
  type Weapon,
  type UiButton,
  type UiConfig,
  type Vec3,
} from '@helaengine/schema';
import { isBuiltinTriggerAsset, triggerDefaults } from '../triggers';
import {
  commitToHistory,
  EMPTY_HISTORY,
  redo as redoHistory,
  undo as undoHistory,
  type History,
} from './history';

/**
 * The editor's working copy of the scene document.
 *
 * The store mirrors `SceneSchema` exactly — no extra gameplay fields, no derived state that isn't
 * recomputable. Anything the user can change has to have a home in the schema, or it will not
 * survive save, load or export. Ephemeral UI state (what's selected, which panel is open) lives
 * beside the document rather than inside it, since none of it belongs in a saved file.
 *
 * Every mutation goes through `commit`, which records an Immer patch pair so the change can be
 * undone. Actions that bypass it are invisible to undo — which is correct for selection, and a
 * bug for anything else.
 */
/**
 * A patch for `uiConfig`, one level deep.
 *
 * The shell's config is a handful of sections and every edit belongs to exactly one of them, so a
 * patch is "some sections, some of their fields". A plain `Partial` would force the caller to
 * re-supply a whole section to change one field in it, which is how a theme swap ends up wiping
 * somebody's menu buttons.
 */
export type UiConfigPatch = {
  [K in keyof UiConfig]?: UiConfig[K] extends object ? Partial<UiConfig[K]> : UiConfig[K];
};

export interface SceneState {
  scene: Scene;
  /** Ids of the currently selected objects. Editor-only; never serialised, never undoable. */
  selectedIds: string[];
  history: History;

  setScene(scene: Scene): void;
  /**
   * Replaces the document as a single undoable edit.
   *
   * `setScene` is for *loading* — a fresh document whose history is not this one's. This is for a
   * change made to the document somebody is already working on, which the release gate's automatic
   * repair is: it has to be visible in the undo stack, because a tool that edits your level and
   * leaves you no way back has not asked permission, it has taken it.
   */
  replaceScene(scene: Scene, label: string): void;
  /**
   * Adopts a change made by somebody else, without touching this client's undo stack.
   *
   * The third way to set a document, and the distinction matters: see the implementation for why
   * neither of the other two is correct for a remote edit.
   */
  applyRemoteScene(scene: Scene): void;
  addObject(object: SceneObject): void;
  removeObject(objectId: string): void;
  removeObjects(objectIds: string[]): void;
  duplicateObjects(objectIds: string[], offset?: Vec3): string[];
  setTransform(objectId: string, transform: Partial<Transform>): void;
  setTransforms(updates: Array<{ id: string; transform: Transform }>, group?: string): void;
  setPosition(objectId: string, position: Vec3): void;
  setParent(objectId: string, parentId: string | null, localTransform?: Transform): void;
  setLabel(objectId: string, label: string): void;
  addBehavior(objectId: string, type: string, params: Record<string, unknown>): void;
  removeBehavior(objectId: string, index: number): void;
  setBehaviorParams(objectId: string, index: number, params: Record<string, unknown>): void;
  setObjectPhysics(objectId: string, physics: Partial<ObjectPhysics>): void;
  setTrigger(objectId: string, trigger: Partial<Trigger>): void;
  setPlayer(player: Partial<Player>): void;
  setInventory(inventory: Partial<Inventory>): void;
  addWeapon(): string;
  removeWeapon(weaponId: string): void;
  setWeapon(weaponId: string, weapon: Partial<Weapon>): void;
  toggleStartingWeapon(weaponId: string): void;
  addUnlockable(): string;
  removeUnlockable(unlockableId: string): void;
  setUnlockable(unlockableId: string, patch: Partial<Unlockable>): void;
  setAudioConfig(
    config: Partial<Omit<AudioConfig, 'music'>> & { music?: Partial<AudioConfig['music']> },
  ): void;
  setGameConfig(config: Partial<GameConfig>): void;
  setUiConfig(config: UiConfigPatch): void;
  setMenuButtons(menu: 'mainMenu' | 'pauseMenu', buttons: UiButton[]): void;
  moveMenuButton(menu: 'mainMenu' | 'pauseMenu', index: number, direction: -1 | 1): void;
  setHudElements(elements: HudElement[]): void;
  setTerrain(terrain: Partial<Terrain>): void;
  setTerrainData(heightmap: string | null, splatmap: string | null): void;
  setEnvironment(environment: Partial<Environment>): void;
  setName(name: string): void;

  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;

  select(objectIds: string[]): void;
  toggleSelected(objectId: string): void;
  clearSelection(): void;
}

export function createEmptyScene(name = 'Untitled scene'): Scene {
  return SceneSchema.parse({
    sceneId: `scene_${Math.random().toString(36).slice(2, 10)}`,
    version: CURRENT_SCENE_VERSION,
    name,
    objects: [],
  });
}

function sameVec(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * True when a transform is value-identical to another.
 *
 * Immer treats an assignment as a change even when the new array holds the same numbers, so
 * without this a gizmo that ends where it started — or a field re-entered with the same value —
 * leaves an undo step that does nothing when pressed.
 */
function sameTransform(a: Transform, b: Transform): boolean {
  return (
    sameVec(a.position, b.position) && sameVec(a.rotation, b.rotation) && sameVec(a.scale, b.scale)
  );
}

/** Every descendant of an object, so deleting a parent takes its children with it. */
export function collectDescendants(scene: Scene, objectIds: string[]): Set<string> {
  const doomed = new Set(objectIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const object of scene.objects) {
      if (object.parentId !== null && doomed.has(object.parentId) && !doomed.has(object.id)) {
        doomed.add(object.id);
        grew = true;
      }
    }
  }
  return doomed;
}

/** True when `candidateParentId` is `objectId` itself or sits beneath it. */
export function wouldCreateCycle(
  scene: Scene,
  objectId: string,
  candidateParentId: string | null,
): boolean {
  if (candidateParentId === null) return false;
  if (candidateParentId === objectId) return true;

  const parentById = new Map(scene.objects.map((object) => [object.id, object.parentId]));
  let ancestor = parentById.get(candidateParentId) ?? null;
  const seen = new Set<string>();
  while (ancestor !== null && ancestor !== undefined) {
    if (ancestor === objectId) return true;
    if (seen.has(ancestor)) return true;
    seen.add(ancestor);
    ancestor = parentById.get(ancestor) ?? null;
  }
  return false;
}

export const useSceneStore = create<SceneState>()(
  devtools(
    (set, get) => {
      /** Applies an undoable change to the document. */
      const commit = (
        label: string,
        recipe: (draft: Scene) => void,
        group: string | null = null,
      ): void => {
        const { scene, history } = get();
        set(commitToHistory(scene, history, label, group, recipe), false, label);
      };

      return {
        scene: createEmptyScene(),
        selectedIds: [],
        history: EMPTY_HISTORY,

        // Loading a whole document is a fresh start, not an edit: the history of the previous
        // document does not describe this one, and applying its patches would corrupt it.
        setScene: (scene) =>
          set({ scene, selectedIds: [], history: EMPTY_HISTORY }, false, 'scene/set'),

        replaceScene: (next, label) =>
          commit(label, (draft) => {
            // Assigned field by field rather than returned, because Immer's draft is the document
            // being patched — replacing the reference would produce a patch nobody can invert.
            for (const key of Object.keys(next) as Array<keyof Scene>) {
              (draft as Record<string, unknown>)[key] = next[key];
            }
          }),

        addObject: (object) => {
          commit('object/add', (draft) => {
            draft.objects.push(object);
          });
          // The first moment the product has done something for them, and the step the plan most
          // wants a number for. `trackFirst`, because a per-drop event would make placement look
          // wider than project creation above it.
          trackFirst('object_placed', { objectCount: get().scene.objects.length });
        },

        removeObject: (objectId) => get().removeObjects([objectId]),

        removeObjects: (objectIds) => {
          const doomed = collectDescendants(get().scene, objectIds);
          commit('object/remove', (draft) => {
            draft.objects = draft.objects.filter((item) => !doomed.has(item.id));
          });
          set(
            (state) => ({ selectedIds: state.selectedIds.filter((id) => !doomed.has(id)) }),
            false,
            'selection/prune',
          );
        },

        duplicateObjects: (objectIds, offset = [1, 0, 1]) => {
          const created: string[] = [];
          commit('object/duplicate', (draft) => {
            const wanted = new Set(objectIds);
            const sources = draft.objects.filter((item) => wanted.has(item.id));

            for (const source of sources) {
              const id = nextObjectId(draft);
              const { position, rotation, scale } = source.transform;

              // Built field by field rather than with `structuredClone`: `source` is an Immer
              // draft, and structured cloning a proxy throws DataCloneError.
              draft.objects.push({
                id,
                assetId: source.assetId,
                parentId: source.parentId,
                transform: {
                  position: [
                    position[0] + offset[0],
                    position[1] + offset[1],
                    position[2] + offset[2],
                  ],
                  rotation: [...rotation],
                  scale: [...scale],
                },
                // Behaviours come along with a copy — duplicating a patrolling guard should give
                // you a second patrolling guard, not a statue.
                behaviors: source.behaviors.map((behavior) => ({
                  type: behavior.type,
                  params: { ...behavior.params },
                })),
                physics: { ...source.physics },
                // A duplicated trigger keeps its wiring: copying a spawn point should give you a
                // second spawn point, not an inert box.
                trigger: source.trigger
                  ? (JSON.parse(JSON.stringify(source.trigger)) as typeof source.trigger)
                  : null,
                metadata: {
                  ...source.metadata,
                  ...(source.metadata.label ? { label: `${source.metadata.label} copy` } : {}),
                },
              });
              created.push(id);
            }
          });

          // Selecting the copies means the next drag moves what was just made, not the originals.
          set({ selectedIds: created }, false, 'selection/duplicated');
          return created;
        },

        setTransform: (objectId, transform) =>
          commit('object/setTransform', (draft) => {
            const object = draft.objects.find((item) => item.id === objectId);
            if (!object) return;
            const next = { ...object.transform, ...transform };
            if (!sameTransform(object.transform, next)) object.transform = next;
          }),

        setTransforms: (updates, group) =>
          commit(
            'object/setTransforms',
            (draft) => {
              // One store write for the whole selection: a group drag would otherwise emit a
              // separate update per object per frame.
              const byId = new Map(updates.map((update) => [update.id, update.transform]));
              for (const object of draft.objects) {
                const transform = byId.get(object.id);
                if (transform && !sameTransform(object.transform, transform)) {
                  object.transform = transform;
                }
              }
            },
            group ?? null,
          ),

        setPosition: (objectId, position) =>
          commit('object/setPosition', (draft) => {
            const object = draft.objects.find((item) => item.id === objectId);
            if (object && !sameVec(object.transform.position, position)) {
              object.transform.position = position;
            }
          }),

        setParent: (objectId, parentId, localTransform) => {
          if (wouldCreateCycle(get().scene, objectId, parentId)) return;
          commit('object/setParent', (draft) => {
            const object = draft.objects.find((item) => item.id === objectId);
            if (!object) return;
            object.parentId = parentId;
            if (localTransform) object.transform = localTransform;
          });
        },

        setLabel: (objectId, label) =>
          commit('object/setLabel', (draft) => {
            const object = draft.objects.find((item) => item.id === objectId);
            if (!object) return;
            const trimmed = label.trim();
            if (trimmed === '') delete object.metadata.label;
            else object.metadata.label = trimmed;
          }),

        addBehavior: (objectId, type, params) =>
          commit('behavior/add', (draft) => {
            const object = draft.objects.find((item) => item.id === objectId);
            object?.behaviors.push({ type, params });
          }),

        removeBehavior: (objectId, index) =>
          commit('behavior/remove', (draft) => {
            const object = draft.objects.find((item) => item.id === objectId);
            object?.behaviors.splice(index, 1);
          }),

        setBehaviorParams: (objectId, index, params) =>
          commit('behavior/setParams', (draft) => {
            const object = draft.objects.find((item) => item.id === objectId);
            const behavior = object?.behaviors[index];
            if (behavior) behavior.params = params;
          }),

        setObjectPhysics: (objectId, physics) =>
          commit('object/setPhysics', (draft) => {
            const object = draft.objects.find((item) => item.id === objectId);
            if (object) Object.assign(object.physics, physics);
          }),

        setTrigger: (objectId, trigger) =>
          commit('object/setTrigger', (draft) => {
            const object = draft.objects.find((item) => item.id === objectId);
            if (!object) return;

            // An object placed from the Logic category arrives with its trigger already filled in,
            // but an object that got there another way — the dev API, a hand-written document —
            // should still become a volume rather than silently ignoring the edit.
            if (!object.trigger) {
              if (!isBuiltinTriggerAsset(object.assetId)) return;
              object.trigger = triggerDefaults(object.assetId);
            }
            Object.assign(object.trigger, trigger);
          }),

        setGameConfig: (config) =>
          commit('scene/setGameConfig', (draft) => {
            Object.assign(draft.gameConfig, config);
          }),

        setUiConfig: (config) =>
          commit('scene/setUiConfig', (draft) => {
            // Shallow-merged per section, so setting a theme does not wipe the menus and setting
            // a title does not wipe the theme.
            for (const [key, value] of Object.entries(config)) {
              const current = draft.uiConfig[key as keyof UiConfig];
              if (value && typeof value === 'object' && !Array.isArray(value) && current) {
                Object.assign(current as object, value);
              } else {
                (draft.uiConfig as Record<string, unknown>)[key] = value;
              }
            }
          }),

        setMenuButtons: (menu, buttons) =>
          commit('ui/setMenuButtons', (draft) => {
            draft.uiConfig[menu].buttons = buttons;
          }),

        moveMenuButton: (menu, index, direction) =>
          commit('ui/moveMenuButton', (draft) => {
            const buttons = draft.uiConfig[menu].buttons;
            const target = index + direction;
            if (index < 0 || index >= buttons.length || target < 0 || target >= buttons.length) {
              return;
            }
            // Swap rather than splice-and-insert: reordering by one place is the only motion the
            // UI offers, and a swap cannot lose an entry the way a mis-indexed splice can.
            const moved = buttons[index]!;
            buttons[index] = buttons[target]!;
            buttons[target] = moved;
          }),

        setHudElements: (elements) =>
          commit('ui/setHudElements', (draft) => {
            draft.uiConfig.hud.customElements = elements;
          }),

        setInventory: (inventory) =>
          commit('scene/setInventory', (draft) => {
            Object.assign(draft.inventory, inventory);
          }),

        addWeapon: () => {
          const id = nextWeaponId(get().scene);
          commit('inventory/addWeapon', (draft) => {
            draft.inventory.weapons.push(
              WeaponSchema.parse({ id, name: `Weapon ${draft.inventory.weapons.length + 1}` }),
            );
          });
          return id;
        },

        removeWeapon: (weaponId) =>
          commit('inventory/removeWeapon', (draft) => {
            draft.inventory.weapons = draft.inventory.weapons.filter(
              (weapon) => weapon.id !== weaponId,
            );
            // The starting loadout references weapons by id, and the schema rejects a document
            // whose loadout names a weapon that is not in the catalogue — so the two have to be
            // edited together or a delete would make the scene unsaveable.
            draft.inventory.startingWeaponIds = draft.inventory.startingWeaponIds.filter(
              (id) => id !== weaponId,
            );
          }),

        setWeapon: (weaponId, weapon) =>
          commit('inventory/setWeapon', (draft) => {
            const found = draft.inventory.weapons.find((entry) => entry.id === weaponId);
            if (found) Object.assign(found, weapon);
          }),

        toggleStartingWeapon: (weaponId) =>
          commit('inventory/toggleStartingWeapon', (draft) => {
            const ids = draft.inventory.startingWeaponIds;
            const at = ids.indexOf(weaponId);
            if (at >= 0) ids.splice(at, 1);
            else ids.push(weaponId);
          }),

        addUnlockable: () => {
          const id = nextUnlockableId(get().scene);
          commit('unlockable/add', (draft) => {
            draft.unlockables.push(
              UnlockableSchema.parse({
                id,
                label: `Secret ${draft.unlockables.length + 1}`,
                // The Konami code, because a secret with an empty sequence is not a secret and a
                // panel that opens on an invalid document is worse than one that opens on a joke.
                unlockMethod: {
                  type: 'inputSequence',
                  sequence: [
                    'Up',
                    'Up',
                    'Down',
                    'Down',
                    'Left',
                    'Right',
                    'Left',
                    'Right',
                    'B',
                    'A',
                  ],
                },
                actions: [{ type: 'emit', event: 'secretFound' }],
              }),
            );
          });
          return id;
        },

        removeUnlockable: (unlockableId) =>
          commit('unlockable/remove', (draft) => {
            draft.unlockables = draft.unlockables.filter((entry) => entry.id !== unlockableId);
          }),

        setUnlockable: (unlockableId, patch) =>
          commit('unlockable/set', (draft) => {
            const found = draft.unlockables.find((entry) => entry.id === unlockableId);
            if (found) Object.assign(found, patch);
          }),

        setAudioConfig: (config) =>
          commit('scene/setAudioConfig', (draft) => {
            const { music, ...rest } = config;
            Object.assign(draft.audioConfig, rest);
            // Music is merged rather than replaced, so setting one track does not clear the others.
            if (music) Object.assign(draft.audioConfig.music, music);
          }),

        setPlayer: (player) =>
          commit('scene/setPlayer', (draft) => {
            Object.assign(draft.player, player);
          }),

        setTerrain: (terrain) =>
          commit('terrain/set', (draft) => {
            Object.assign(draft.terrain, terrain);
          }),

        // One commit per completed stroke, not per frame: the whole heightmap is a single patch,
        // so recording one mid-drag would put tens of megabytes through the undo stack.
        setTerrainData: (heightmap, splatmap) =>
          commit('terrain/sculpt', (draft) => {
            draft.terrain.type = 'heightmap';
            draft.terrain.heightmap = heightmap ? { encoding: 'base64', data: heightmap } : null;
            draft.terrain.splatmap = splatmap ? { encoding: 'base64', data: splatmap } : null;
          }),

        setEnvironment: (environment) =>
          commit('environment/set', (draft) => {
            Object.assign(draft.environment, environment);
          }),

        setName: (name) =>
          commit('scene/setName', (draft) => {
            draft.name = name;
          }),

        /**
         * A change that came from a collaborator.
         *
         * Neither `setScene` nor `replaceScene`. `setScene` clears the undo stack, which would mean
         * losing your history every time somebody else nudges a rock. `replaceScene` commits an
         * undo entry, which would put *their* edit on *your* undo stack — press Ctrl+Z and you
         * silently revert a colleague's work.
         *
         * So: the document changes and history does not move at all. In a collaborative session
         * undo is Yjs's job (see `collab/session.ts`), scoped to this client's own operations, so
         * that Ctrl+Z takes back what you did and nothing else.
         */
        applyRemoteScene: (next) => {
          const alive = new Set(next.objects.map((object) => object.id));
          set(
            (state) => ({
              scene: next,
              // Somebody else deleting what you had selected must not leave the inspector pointing
              // at an object that is no longer in the scene.
              selectedIds: state.selectedIds.filter((id) => alive.has(id)),
            }),
            false,
            'scene/remote',
          );
        },

        undo: () => {
          const { scene, history } = get();
          const result = undoHistory(scene, history);
          const alive = new Set(result.scene.objects.map((object) => object.id));
          set(
            {
              ...result,
              // An undone creation leaves its object selected but gone; prune rather than leaving
              // the inspector pointing at something that is not there.
              selectedIds: get().selectedIds.filter((id) => alive.has(id)),
            },
            false,
            'history/undo',
          );
        },

        redo: () => {
          const { scene, history } = get();
          const result = redoHistory(scene, history);
          const alive = new Set(result.scene.objects.map((object) => object.id));
          set(
            { ...result, selectedIds: get().selectedIds.filter((id) => alive.has(id)) },
            false,
            'history/redo',
          );
        },

        canUndo: () => get().history.past.length > 0,
        canRedo: () => get().history.future.length > 0,

        select: (objectIds) => set({ selectedIds: objectIds }, false, 'selection/set'),

        toggleSelected: (objectId) =>
          set(
            (state) => ({
              selectedIds: state.selectedIds.includes(objectId)
                ? state.selectedIds.filter((id) => id !== objectId)
                : [...state.selectedIds, objectId],
            }),
            false,
            'selection/toggle',
          ),

        clearSelection: () => set({ selectedIds: [] }, false, 'selection/clear'),
      };
    },
    { name: 'helaengine/scene' },
  ),
);

/** Generates the next free `obj_NNNN` id for a scene. */
export function nextObjectId(scene: Scene): string {
  let highest = 0;
  for (const object of scene.objects) {
    const match = /^obj_(\d+)$/.exec(object.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `obj_${String(highest + 1).padStart(4, '0')}`;
}

/** Generates the next free `secret_NNNN` id. */
export function nextUnlockableId(scene: Scene): string {
  let highest = 0;
  for (const unlockable of scene.unlockables) {
    const match = /^secret_(\d+)$/.exec(unlockable.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `secret_${String(highest + 1).padStart(4, '0')}`;
}

/**
 * Generates the next free `weapon_NNNN` id.
 *
 * Ids are generated rather than derived from the name for the same reason object ids are: a weapon
 * gets renamed, and every pickup that granted it would otherwise stop granting anything.
 *
 * The pickups are scanned as well as the catalogue, and that is the whole point of this function
 * rather than a copy of `nextObjectId`. Deleting the highest-numbered weapon would otherwise free
 * its id, and the next weapon added would inherit every pickup that used to grant the deleted one —
 * a crate that quietly hands out the wrong gun, with nothing anywhere saying so.
 */
export function nextWeaponId(scene: Scene): string {
  let highest = 0;
  const consider = (id: string): void => {
    const match = /^weapon_(\d+)$/.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  };

  for (const weapon of scene.inventory.weapons) consider(weapon.id);
  for (const object of scene.objects) {
    for (const behavior of object.behaviors) {
      const weaponId = (behavior.params as { weaponId?: unknown }).weaponId;
      if (typeof weaponId === 'string') consider(weaponId);
    }
  }
  return `weapon_${String(highest + 1).padStart(4, '0')}`;
}
