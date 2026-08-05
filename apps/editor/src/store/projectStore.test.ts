import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from './projectStore';
import { useSceneStore } from './sceneStore';

/**
 * The document a project was opened with, held by reference.
 *
 * `useAutosave` uses it to tell two identical-looking situations apart: a scene change that *is*
 * the project opening, and an edit that arrived in the same effect pass as the opening. Both look
 * like "the first run for this project id", and the second was being treated as a load — so a real
 * edit stayed undirty and unsaved until the next one. An end-to-end test caught it as a save-state
 * indicator that stayed empty; these pin the invariant the fix rests on.
 */

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('helaengine');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});

describe('the document a project was opened with', () => {
  it('is the exact object the scene store holds after a template opens', async () => {
    await useProjectStore.getState().createFromTemplate('blank');

    // By reference, not by value: a deep comparison of a whole scene on every edit would be the
    // most expensive thing in the editor's hot path, and identity is precisely the question.
    expect(useProjectStore.getState().adoptedScene).toBe(useSceneStore.getState().scene);
    expect(useProjectStore.getState().dirty).toBe(false);
  });

  it('stops being the current scene the moment anything is edited', async () => {
    await useProjectStore.getState().createFromTemplate('blank');
    const adopted = useProjectStore.getState().adoptedScene;

    useSceneStore.getState().setName('Renamed');

    // This inequality is the whole signal: an edit always produces a new object, so a scene that
    // is no longer the adopted one is an edit however soon after the opening it arrived.
    expect(useSceneStore.getState().scene).not.toBe(adopted);
  });

  it('follows a reopen, so the next project is judged against its own document', async () => {
    await useProjectStore.getState().createFromTemplate('blank');
    const first = useProjectStore.getState().projectId!;
    useSceneStore.getState().setName('First');
    await useProjectStore.getState().save();

    await useProjectStore.getState().createFromTemplate('forest-clearing');
    expect(useProjectStore.getState().adoptedScene).toBe(useSceneStore.getState().scene);

    await useProjectStore.getState().open(first);
    // Stale by one project would be worse than not tracking it at all: every edit would look like
    // a load, and nothing would ever be marked dirty.
    expect(useProjectStore.getState().adoptedScene).toBe(useSceneStore.getState().scene);
    expect(useSceneStore.getState().scene.name).toBe('First');
  });
});
