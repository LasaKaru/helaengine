import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { Scene } from '@helaengine/schema';
import {
  createProject,
  deleteProject,
  duplicateProject,
  listProjects,
  loadProject,
  saveProject,
  type ProjectSummary,
} from '../storage/backend';
import { templateById } from '@helaengine/templates';
import { useSceneStore } from './sceneStore';

export type Screen = 'projects' | 'editor';

export type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; at: number }
  | { status: 'error'; message: string };

/** Supplied by the viewport; returns a data URL, or null when the canvas cannot be read. */
export type ThumbnailCapture = () => string | null;

export interface ProjectState {
  screen: Screen;
  projectId: string | null;
  projects: ProjectSummary[];
  saveState: SaveState;
  /** True when the document has changed since the last successful save. */
  dirty: boolean;
  loadError: string | null;

  setCaptureThumbnail(capture: ThumbnailCapture | null): void;
  refreshProjects(): Promise<void>;
  createFromTemplate(templateId: string): Promise<void>;
  open(id: string): Promise<void>;
  save(): Promise<void>;
  remove(id: string): Promise<void>;
  duplicate(id: string): Promise<void>;
  goHome(): Promise<void>;
  markDirty(): void;
}

let captureThumbnail: ThumbnailCapture | null = null;

export const useProjectStore = create<ProjectState>()(
  devtools(
    (set, get) => ({
      screen: 'projects',
      projectId: null,
      projects: [],
      saveState: { status: 'idle' },
      dirty: false,
      loadError: null,

      setCaptureThumbnail: (capture) => {
        captureThumbnail = capture;
      },

      refreshProjects: async () => {
        set({ projects: await listProjects() }, false, 'projects/refresh');
      },

      createFromTemplate: async (templateId) => {
        const template = templateById(templateId);
        if (!template) throw new Error(`Unknown template "${templateId}"`);

        const scene = template.build();

        // Written to storage immediately, so a new project survives a reload even if the user
        // never touches the save button. The backend mints the id — locally that is a generated
        // string, in the cloud it is whatever the server assigned.
        const id = await createProject(scene.name, scene);
        useSceneStore.getState().setScene(scene);

        set(
          {
            projectId: id,
            screen: 'editor',
            dirty: false,
            loadError: null,
            saveState: { status: 'idle' },
          },
          false,
          'project/create',
        );
        await get().refreshProjects();
      },

      open: async (id) => {
        try {
          const { scene } = await loadProject(id);
          useSceneStore.getState().setScene(scene);
          set(
            {
              projectId: id,
              screen: 'editor',
              dirty: false,
              loadError: null,
              saveState: { status: 'idle' },
            },
            false,
            'project/open',
          );
        } catch (error) {
          // A project that cannot be validated must not take the editor down with it — the user
          // needs to get back to the list and open something else.
          set(
            { loadError: error instanceof Error ? error.message : String(error) },
            false,
            'project/openFailed',
          );
        }
      },

      save: async () => {
        const { projectId } = get();
        if (!projectId) return;

        set({ saveState: { status: 'saving' } }, false, 'project/saving');
        try {
          const scene: Scene = useSceneStore.getState().scene;
          await saveProject({ id: projectId, scene, thumbnail: captureThumbnail?.() ?? undefined });
          set(
            { saveState: { status: 'saved', at: Date.now() }, dirty: false },
            false,
            'project/saved',
          );
          await get().refreshProjects();
        } catch (error) {
          set(
            {
              saveState: {
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
              },
            },
            false,
            'project/saveFailed',
          );
        }
      },

      remove: async (id) => {
        await deleteProject(id);
        if (get().projectId === id)
          set({ projectId: null, screen: 'projects' }, false, 'project/removed');
        await get().refreshProjects();
      },

      duplicate: async (id) => {
        await duplicateProject(id);
        await get().refreshProjects();
      },

      goHome: async () => {
        // Leaving always saves, without consulting the dirty flag. That flag is maintained by an
        // effect, so an edit made a few milliseconds before the click may not have registered yet
        // — and losing work to that race is far worse than one redundant write.
        if (get().projectId) await get().save();
        set({ screen: 'projects', loadError: null }, false, 'screen/home');
        await get().refreshProjects();
      },

      markDirty: () => {
        if (!get().dirty) set({ dirty: true }, false, 'project/dirty');
      },
    }),
    { name: 'helaengine/projects' },
  ),
);
