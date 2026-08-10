import { beforeEach, describe, expect, it } from 'vitest';
import { SceneObjectSchema, type Scene } from '@helaengine/schema';
import { createEmptyScene, useSceneStore } from './sceneStore';
import { levelSummaries, useLevelsStore } from './levelsStore';

/**
 * The level set, and its one genuinely dangerous operation.
 *
 * `switchTo` saves the live document into the set and then loads another. The other order loses
 * every edit made since the last switch, silently, and the author finds out when they come back to
 * a level and their work is gone. Most of this file is about that.
 */

const object = (id: string) =>
  SceneObjectSchema.parse({ id, assetId: 'prop_crate_01', transform: { position: [1, 0, 1] } });

function reset(): void {
  useSceneStore.setState({ scene: createEmptyScene('Forest'), selectedIds: [] });
  useLevelsStore.setState({ levels: [], activeLevelId: '', startLevelId: '' });
}

const live = (): Scene => useSceneStore.getState().scene;

beforeEach(reset);

describe('a project that has never been split', () => {
  it('is one level, taken live from the scene store', () => {
    const project = useLevelsStore.getState().project();
    expect(project.levels).toHaveLength(1);
    expect(project.levels[0]).toEqual(live());
    expect(project.startLevelId).toBe(live().sceneId);
  });

  it('lists one row without an empty set pretending to be no levels', () => {
    const rows = levelSummaries(useLevelsStore.getState(), live());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Forest', isActive: true, isStart: true });
  });
});

describe('adding a level', () => {
  it('seeds the set from the level already on screen', () => {
    useLevelsStore.getState().addLevel('Caves');

    const project = useLevelsStore.getState().project();
    expect(project.levels.map((level) => level.name)).toEqual(['Forest', 'Caves']);
    // The first level keeps being the start: adding a second one is not a decision about where the
    // game begins.
    expect(project.startLevelId).toBe(live().sceneId);
  });

  it('does not switch to it', () => {
    const before = live().sceneId;
    useLevelsStore.getState().addLevel('Caves');

    // Being thrown into an empty field mid-edit is the kind of helpfulness that loses work.
    expect(useSceneStore.getState().scene.sceneId).toBe(before);
    expect(useLevelsStore.getState().activeLevelId).toBe(before);
  });

  it('gives each level an id nothing else is using', () => {
    useLevelsStore.getState().addLevel('A');
    useLevelsStore.getState().addLevel('B');
    const ids = useLevelsStore.getState().levels.map((level) => level.sceneId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('switching', () => {
  it('saves the live document before loading the other one', () => {
    /**
     * The claim this store exists to get right.
     *
     * The active level's entry in the set is a snapshot from the last switch, so anything done
     * since then lives only in `sceneStore`. Loading first would overwrite it.
     */
    const forestId = live().sceneId;
    const cavesId = useLevelsStore.getState().addLevel('Caves');

    useSceneStore.getState().addObject(object('crate_1'));
    expect(live().objects).toHaveLength(1);

    useLevelsStore.getState().switchTo(cavesId);
    expect(useSceneStore.getState().scene.sceneId).toBe(cavesId);
    expect(useSceneStore.getState().scene.objects).toHaveLength(0);

    useLevelsStore.getState().switchTo(forestId);
    expect(useSceneStore.getState().scene.objects.map((o) => o.id)).toEqual(['crate_1']);
  });

  it('keeps edits made to the second level too', () => {
    const forestId = live().sceneId;
    const cavesId = useLevelsStore.getState().addLevel('Caves');

    useLevelsStore.getState().switchTo(cavesId);
    useSceneStore.getState().addObject(object('stalactite'));
    useLevelsStore.getState().switchTo(forestId);
    useLevelsStore.getState().switchTo(cavesId);

    expect(useSceneStore.getState().scene.objects.map((o) => o.id)).toEqual(['stalactite']);
  });

  it('starts the new level with a clean undo history', () => {
    const cavesId = useLevelsStore.getState().addLevel('Caves');
    useSceneStore.getState().addObject(object('crate_1'));
    expect(useSceneStore.getState().canUndo()).toBe(true);

    useLevelsStore.getState().switchTo(cavesId);

    // Carrying the stack across would let Ctrl+Z in the caves undo something in the forest.
    expect(useSceneStore.getState().canUndo()).toBe(false);
  });

  it('ignores a switch to where you already are, and to a level that is not there', () => {
    const forestId = live().sceneId;
    useLevelsStore.getState().addLevel('Caves');
    useSceneStore.getState().addObject(object('crate_1'));

    useLevelsStore.getState().switchTo(forestId);
    useLevelsStore.getState().switchTo('nowhere');

    expect(useSceneStore.getState().scene.objects).toHaveLength(1);
  });
});

describe('deleting', () => {
  it('refuses to remove the last level', () => {
    useLevelsStore.getState().addLevel('Caves');
    const [first] = useLevelsStore.getState().levels;
    useLevelsStore.getState().removeLevel(first!.sceneId);
    useLevelsStore.getState().removeLevel(useLevelsStore.getState().levels[0]!.sceneId);

    // A game with no levels is not a game.
    expect(useLevelsStore.getState().levels).toHaveLength(1);
  });

  it('moves you somewhere real when you delete the level you are editing', () => {
    const forestId = live().sceneId;
    const cavesId = useLevelsStore.getState().addLevel('Caves');
    useLevelsStore.getState().switchTo(cavesId);

    useLevelsStore.getState().removeLevel(cavesId);

    // Leaving the editor pointed at a document no longer in the set is the one thing that would
    // definitely be wrong.
    expect(useSceneStore.getState().scene.sceneId).toBe(forestId);
    expect(useLevelsStore.getState().activeLevelId).toBe(forestId);
  });

  it('moves the start level when the start level is the one deleted', () => {
    const forestId = live().sceneId;
    const cavesId = useLevelsStore.getState().addLevel('Caves');
    useLevelsStore.getState().setStartLevel(forestId);

    useLevelsStore.getState().removeLevel(forestId);

    // A project whose start level does not exist fails its own schema, so this cannot be left to
    // be noticed on save.
    expect(useLevelsStore.getState().startLevelId).toBe(cavesId);
    expect(() => useLevelsStore.getState().project()).not.toThrow();
  });
});

describe('renaming', () => {
  it('renames the active level through the live document', () => {
    useLevelsStore.getState().addLevel('Caves');
    useLevelsStore.getState().renameLevel(live().sceneId, 'Deep Forest');

    // Written to the snapshot instead, it would be overwritten the next time the two reconcile.
    expect(useSceneStore.getState().scene.name).toBe('Deep Forest');
    expect(useLevelsStore.getState().project().levels[0]?.name).toBe('Deep Forest');
  });

  it('renames an inactive level in the set', () => {
    const cavesId = useLevelsStore.getState().addLevel('Caves');
    useLevelsStore.getState().renameLevel(cavesId, 'Caverns');

    const project = useLevelsStore.getState().project();
    expect(project.levels.find((level) => level.sceneId === cavesId)?.name).toBe('Caverns');
  });
});

describe('adopting a document', () => {
  it('reads a lone scene as a one-level game', () => {
    const solo = { ...createEmptyScene('Old project'), sceneId: 'legacy' };
    useLevelsStore.getState().adoptDocument(solo);

    // Every file written before levels existed holds exactly this shape.
    expect(useLevelsStore.getState().levels).toHaveLength(1);
    expect(useSceneStore.getState().scene.sceneId).toBe('legacy');
  });

  it('opens a project on its start level, not on its first', () => {
    useLevelsStore.getState().adoptDocument({
      version: 1,
      name: 'Game',
      startLevelId: 'b',
      levels: [
        { ...createEmptyScene('A'), sceneId: 'a' },
        { ...createEmptyScene('B'), sceneId: 'b' },
      ],
    });

    expect(useSceneStore.getState().scene.sceneId).toBe('b');
    expect(useLevelsStore.getState().activeLevelId).toBe('b');
  });
});
