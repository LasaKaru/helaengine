import { create } from 'zustand';
import { buildHelaFile, importHelaFile } from '../storage/helaFile';
import {
  openFile as openLocalFile,
  PickerCancelled,
  saveAs,
  writeTo,
  type HelaFileHandle,
} from '../storage/localFile';
import { registerImportedAssets } from '../storage/importedAssets';
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
  /**
   * The exact document this project was opened with.
   *
   * Held by reference so `useAutosave` can tell "this scene change *is* the project opening" from
   * "this scene change is an edit that arrived in the same pass as the opening". Comparing project
   * ids alone cannot: both look like the first run for a new id, and the second was silently
   * treated as a load — leaving the first edit of a session undirty and unsaved.
   */
  adoptedScene: Scene | null;
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

  /**
   * Writes the open project to the user's own disk as a `.hela` file.
   *
   * `saveAs` always asks where; `saveToFile` writes back to the file the user last chose, and falls
   * back to asking when there is nothing to write back to. That is the split every desktop
   * application has, and the reason a file handle is worth holding at all.
   */
  saveToFile(): Promise<void>;
  saveFileAs(): Promise<void>;
  /** Opens a `.hela` from disk as a new project. */
  openFromFile(): Promise<void>;
  /** Opens bytes that arrived some other way — dropped on the window, most likely. */
  importFile(bytes: Uint8Array): Promise<void>;
  /** The file this project is bound to, for the "Save to file" label. */
  fileName: string | null;
  /** Something the last import wants the user to know. Cleared when acknowledged. */
  fileNotice: string | null;
  dismissFileNotice(): void;
}

let captureThumbnail: ThumbnailCapture | null = null;

/**
 * The file the open project is bound to.
 *
 * Module-level rather than in the store because a `FileSystemFileHandle` is a live browser object,
 * not serialisable state — putting one in a store that devtools serialises is how a handle becomes
 * a `{}` that silently fails to write.
 */
let fileHandle: HelaFileHandle | null = null;

/**
 * Writes the open project to disk.
 *
 * Shared by "Save to file" and "Save as" because the only difference between them is whether the
 * user is asked, and duplicating the build-and-write around that one branch is how the two end up
 * embedding different things.
 */
async function writeProjectFile(
  get: () => ProjectState,
  set: (partial: Partial<ProjectState>, replace?: false, action?: string) => void,
  options: { ask: boolean },
): Promise<void> {
  const scene = useSceneStore.getState().scene;
  set({ saveState: { status: 'saving' } }, false, 'file/saving');

  try {
    const bytes = await buildHelaFile({ scene, thumbnail: captureThumbnail?.() ?? undefined });

    if (!options.ask && fileHandle) {
      await writeTo(fileHandle, bytes);
    } else {
      const handle = await saveAs(bytes, scene.name);
      // Null on a browser with no picker, where the bytes went to the downloads folder and there
      // is nothing to write back to. Recorded honestly so the button keeps saying "Save as".
      fileHandle = handle;
    }

    set(
      {
        saveState: { status: 'saved', at: Date.now() },
        fileName: fileHandle?.name ?? null,
      },
      false,
      'file/saved',
    );
  } catch (error) {
    if (error instanceof PickerCancelled) {
      set({ saveState: { status: 'idle' } }, false, 'file/cancelled');
      return;
    }
    set(
      {
        saveState: {
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      false,
      'file/saveFailed',
    );
  }
}

export const useProjectStore = create<ProjectState>()(
  devtools(
    (set, get) => ({
      screen: 'projects',
      projectId: null,
      projects: [],
      saveState: { status: 'idle' },
      dirty: false,
      adoptedScene: null,
      loadError: null,
      fileName: null,
      fileNotice: null,

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
            adoptedScene: scene,
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
              adoptedScene: scene,
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

      saveFileAs: async () => {
        await writeProjectFile(get, set, { ask: true });
      },

      saveToFile: async () => {
        await writeProjectFile(get, set, { ask: false });
      },

      openFromFile: async () => {
        try {
          const { bytes, handle } = await openLocalFile();
          fileHandle = handle;
          await get().importFile(bytes);
        } catch (error) {
          // Dismissing the dialog is not a failure and must not put an error on screen.
          if (error instanceof PickerCancelled) return;
          set(
            { loadError: error instanceof Error ? error.message : String(error) },
            false,
            'file/openFailed',
          );
        }
      },

      importFile: async (bytes) => {
        try {
          const imported = await importHelaFile(bytes);

          // Created as a project rather than opened in place: an imported file is somebody's work
          // arriving, and dropping it over whatever was on screen would be an edit nobody asked
          // for. It gets its own entry in the list and its own id.
          const id = await createProject(imported.name, imported.scene);
          useSceneStore.getState().setScene(imported.scene);

          if (imported.thumbnail) {
            await saveProject({ id, scene: imported.scene, thumbnail: imported.thumbnail });
          }

          set(
            {
              projectId: id,
              screen: 'editor',
              dirty: false,
              adoptedScene: imported.scene,
              loadError: null,
              saveState: { status: 'idle' },
              fileName: null,
              fileNotice: imported.notes[0] ?? null,
            },
            false,
            'file/imported',
          );
          registerImportedAssets(imported.restoredAssets);
          await get().refreshProjects();
        } catch (error) {
          set(
            { loadError: error instanceof Error ? error.message : String(error) },
            false,
            'file/importFailed',
          );
        }
      },

      dismissFileNotice: () => set({ fileNotice: null }, false, 'file/noticeDismissed'),
    }),
    { name: 'helaengine/projects' },
  ),
);
