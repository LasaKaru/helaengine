import { beforeEach, describe, expect, it } from 'vitest';
import { SceneSchema, SceneObjectSchema } from '@helaengine/schema';
import { createEmptyScene, nextObjectId, useSceneStore } from './sceneStore';

function object(id: string, assetId = 'tree_pine_01') {
  return SceneObjectSchema.parse({ id, assetId });
}

describe('sceneStore', () => {
  beforeEach(() => {
    useSceneStore.setState({ scene: createEmptyScene(), selectedIds: [] });
  });

  it('starts from a document that satisfies the schema', () => {
    expect(SceneSchema.safeParse(useSceneStore.getState().scene).success).toBe(true);
  });

  it('keeps the document schema-valid after edits', () => {
    const { addObject, setPosition, setEnvironment } = useSceneStore.getState();

    addObject(object('obj_0001'));
    setPosition('obj_0001', [4, 0, -2]);
    setEnvironment({ background: '#101010' });

    const result = SceneSchema.safeParse(useSceneStore.getState().scene);
    expect(result.success).toBe(true);
  });

  it('adds and removes objects', () => {
    const { addObject, removeObject } = useSceneStore.getState();

    addObject(object('obj_0001'));
    addObject(object('obj_0002'));
    expect(useSceneStore.getState().scene.objects).toHaveLength(2);

    removeObject('obj_0001');
    expect(useSceneStore.getState().scene.objects.map((item) => item.id)).toEqual(['obj_0002']);
  });

  it('replaces the document by reference so subscribers re-render', () => {
    const before = useSceneStore.getState().scene;
    useSceneStore.getState().addObject(object('obj_0001'));

    expect(useSceneStore.getState().scene).not.toBe(before);
    expect(before.objects).toHaveLength(0);
  });

  it('updates a single transform field without clobbering the others', () => {
    const { addObject, setTransform } = useSceneStore.getState();
    addObject(object('obj_0001'));

    setTransform('obj_0001', { rotation: [0, 90, 0] });

    expect(useSceneStore.getState().scene.objects[0]?.transform).toEqual({
      position: [0, 0, 0],
      rotation: [0, 90, 0],
      scale: [1, 1, 1],
    });
  });

  it('ignores edits addressed to an object that is not there', () => {
    expect(() => useSceneStore.getState().setPosition('nope', [1, 2, 3])).not.toThrow();
    expect(useSceneStore.getState().scene.objects).toHaveLength(0);
  });

  it('drops a removed object from the selection', () => {
    const { addObject, select, removeObject } = useSceneStore.getState();
    addObject(object('obj_0001'));
    select(['obj_0001']);

    removeObject('obj_0001');

    expect(useSceneStore.getState().selectedIds).toEqual([]);
  });

  it('clears the selection when a whole new document is loaded', () => {
    useSceneStore.getState().select(['obj_0001']);
    useSceneStore.getState().setScene(createEmptyScene('Another'));

    expect(useSceneStore.getState().selectedIds).toEqual([]);
    expect(useSceneStore.getState().scene.name).toBe('Another');
  });
});

describe('nextObjectId', () => {
  it('starts at obj_0001 for an empty scene', () => {
    expect(nextObjectId(createEmptyScene())).toBe('obj_0001');
  });

  it('continues from the highest existing id, not the object count', () => {
    const scene = { ...createEmptyScene(), objects: [object('obj_0001'), object('obj_0007')] };
    expect(nextObjectId(scene)).toBe('obj_0008');
  });

  it('ignores ids that do not follow the pattern', () => {
    const scene = { ...createEmptyScene(), objects: [object('player-start'), object('obj_0003')] };
    expect(nextObjectId(scene)).toBe('obj_0004');
  });
});
