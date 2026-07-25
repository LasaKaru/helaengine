import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import {
  CURRENT_SCENE_VERSION,
  SceneSchema,
  type Environment,
  type Scene,
  type SceneObject,
  type Terrain,
  type Transform,
  type Vec3,
} from '@helaengine/schema';

/**
 * The editor's working copy of the scene document.
 *
 * The store mirrors `SceneSchema` exactly — no extra gameplay fields, no derived state that isn't
 * recomputable. Anything the user can change has to have a home in the schema, or it will not
 * survive save, load or export. Ephemeral UI state (what's selected, which panel is open) lives
 * beside the document rather than inside it, since none of it belongs in a saved file.
 */
export interface SceneState {
  scene: Scene;
  /** Ids of the currently selected objects. Editor-only; never serialised. */
  selectedIds: string[];

  setScene(scene: Scene): void;
  addObject(object: SceneObject): void;
  removeObject(objectId: string): void;
  setTransform(objectId: string, transform: Partial<Transform>): void;
  setPosition(objectId: string, position: Vec3): void;
  setTerrain(terrain: Partial<Terrain>): void;
  setEnvironment(environment: Partial<Environment>): void;
  setName(name: string): void;
  select(objectIds: string[]): void;
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

export const useSceneStore = create<SceneState>()(
  devtools(
    immer((set) => ({
      scene: createEmptyScene(),
      selectedIds: [],

      setScene: (scene) =>
        set(
          (state) => {
            state.scene = scene;
            state.selectedIds = [];
          },
          false,
          'scene/set',
        ),

      addObject: (object) =>
        set(
          (state) => {
            state.scene.objects.push(object);
          },
          false,
          'object/add',
        ),

      removeObject: (objectId) =>
        set(
          (state) => {
            state.scene.objects = state.scene.objects.filter((item) => item.id !== objectId);
            state.selectedIds = state.selectedIds.filter((id) => id !== objectId);
          },
          false,
          'object/remove',
        ),

      setTransform: (objectId, transform) =>
        set(
          (state) => {
            const object = state.scene.objects.find((item) => item.id === objectId);
            if (object) Object.assign(object.transform, transform);
          },
          false,
          'object/setTransform',
        ),

      setPosition: (objectId, position) =>
        set(
          (state) => {
            const object = state.scene.objects.find((item) => item.id === objectId);
            if (object) object.transform.position = position;
          },
          false,
          'object/setPosition',
        ),

      setTerrain: (terrain) =>
        set(
          (state) => {
            Object.assign(state.scene.terrain, terrain);
          },
          false,
          'terrain/set',
        ),

      setEnvironment: (environment) =>
        set(
          (state) => {
            Object.assign(state.scene.environment, environment);
          },
          false,
          'environment/set',
        ),

      setName: (name) =>
        set(
          (state) => {
            state.scene.name = name;
          },
          false,
          'scene/setName',
        ),

      select: (objectIds) => set({ selectedIds: objectIds }, false, 'selection/set'),
      clearSelection: () => set({ selectedIds: [] }, false, 'selection/clear'),
    })),
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
