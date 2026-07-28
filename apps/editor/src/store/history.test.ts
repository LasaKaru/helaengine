import { beforeEach, describe, expect, it } from 'vitest';
import { SceneObjectSchema } from '@helaengine/schema';
import { createEmptyScene, useSceneStore } from './sceneStore';
import { HISTORY_LIMIT } from './history';

function object(id: string, position: [number, number, number] = [0, 0, 0]) {
  return SceneObjectSchema.parse({ id, assetId: 'tree_pine_01', transform: { position } });
}

function reset(): void {
  useSceneStore.setState({
    scene: createEmptyScene(),
    selectedIds: [],
    history: { past: [], future: [] },
  });
}

describe('undo / redo', () => {
  beforeEach(reset);

  it('starts with nothing to undo or redo', () => {
    expect(useSceneStore.getState().canUndo()).toBe(false);
    expect(useSceneStore.getState().canRedo()).toBe(false);
  });

  it('undoes an add and redoes it', () => {
    const store = useSceneStore.getState();
    store.addObject(object('obj_0001'));
    expect(useSceneStore.getState().scene.objects).toHaveLength(1);

    useSceneStore.getState().undo();
    expect(useSceneStore.getState().scene.objects).toHaveLength(0);

    useSceneStore.getState().redo();
    expect(useSceneStore.getState().scene.objects).toHaveLength(1);
  });

  it('restores exact transform values', () => {
    useSceneStore.getState().addObject(object('obj_0001', [1, 2, 3]));
    useSceneStore.getState().setPosition('obj_0001', [9, 9, 9]);

    useSceneStore.getState().undo();

    expect(useSceneStore.getState().scene.objects[0]!.transform.position).toEqual([1, 2, 3]);
  });

  it('survives 50 consecutive undo/redo cycles without corrupting state', () => {
    for (let index = 1; index <= 50; index += 1) {
      useSceneStore
        .getState()
        .addObject(object(`obj_${String(index).padStart(4, '0')}`, [index, 0, 0]));
    }
    const expected = useSceneStore.getState().scene.objects.map((item) => item.id);

    for (let index = 0; index < 50; index += 1) useSceneStore.getState().undo();
    expect(useSceneStore.getState().scene.objects).toHaveLength(0);

    for (let index = 0; index < 50; index += 1) useSceneStore.getState().redo();
    expect(useSceneStore.getState().scene.objects.map((item) => item.id)).toEqual(expected);
  });

  it('discards the redo branch once a new edit lands', () => {
    useSceneStore.getState().addObject(object('obj_0001'));
    useSceneStore.getState().undo();
    expect(useSceneStore.getState().canRedo()).toBe(true);

    useSceneStore.getState().addObject(object('obj_0002'));

    expect(useSceneStore.getState().canRedo()).toBe(false);
  });

  it('ignores undo when there is nothing to undo', () => {
    expect(() => useSceneStore.getState().undo()).not.toThrow();
    expect(useSceneStore.getState().scene.objects).toHaveLength(0);
  });

  it('does not record a step for a change that changes nothing', () => {
    useSceneStore.getState().addObject(object('obj_0001', [1, 0, 0]));
    const depth = useSceneStore.getState().history.past.length;

    useSceneStore.getState().setPosition('obj_0001', [1, 0, 0]);

    expect(useSceneStore.getState().history.past).toHaveLength(depth);
  });

  it('collapses a grouped drag into a single step', () => {
    useSceneStore.getState().addObject(object('obj_0001'));
    const depth = useSceneStore.getState().history.past.length;

    // Sixty frames of a gizmo drag, all sharing one group id.
    for (let frame = 1; frame <= 60; frame += 1) {
      useSceneStore.getState().setTransforms(
        [
          {
            id: 'obj_0001',
            transform: { position: [frame, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        ],
        'drag-1',
      );
    }

    expect(useSceneStore.getState().history.past).toHaveLength(depth + 1);

    useSceneStore.getState().undo();
    // One undo returns to where the drag started, not to frame 59.
    expect(useSceneStore.getState().scene.objects[0]!.transform.position).toEqual([0, 0, 0]);
  });

  it('keeps separate drags as separate steps', () => {
    useSceneStore.getState().addObject(object('obj_0001'));
    const transform = {
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    };

    useSceneStore
      .getState()
      .setTransforms(
        [{ id: 'obj_0001', transform: { ...transform, position: [1, 0, 0] } }],
        'drag-1',
      );
    useSceneStore
      .getState()
      .setTransforms(
        [{ id: 'obj_0001', transform: { ...transform, position: [2, 0, 0] } }],
        'drag-2',
      );

    useSceneStore.getState().undo();
    expect(useSceneStore.getState().scene.objects[0]!.transform.position).toEqual([1, 0, 0]);
  });

  it('caps the history at the documented depth', () => {
    for (let index = 0; index < HISTORY_LIMIT + 25; index += 1) {
      useSceneStore.getState().setName(`Scene ${index}`);
    }
    expect(useSceneStore.getState().history.past).toHaveLength(HISTORY_LIMIT);
  });

  it('drops the selection when undo removes the selected object', () => {
    useSceneStore.getState().addObject(object('obj_0001'));
    useSceneStore.getState().select(['obj_0001']);

    useSceneStore.getState().undo();

    expect(useSceneStore.getState().selectedIds).toEqual([]);
  });

  it('clears history when a whole new document is loaded', () => {
    useSceneStore.getState().addObject(object('obj_0001'));
    expect(useSceneStore.getState().canUndo()).toBe(true);

    // The previous document's patches do not describe this one, so replaying them would corrupt it.
    useSceneStore.getState().setScene(createEmptyScene('Fresh'));

    expect(useSceneStore.getState().canUndo()).toBe(false);
  });

  it('undoes a delete, bringing the objects back', () => {
    useSceneStore.getState().addObject(object('obj_0001'));
    useSceneStore.getState().addObject(object('obj_0002'));
    useSceneStore.getState().removeObjects(['obj_0001', 'obj_0002']);
    expect(useSceneStore.getState().scene.objects).toHaveLength(0);

    useSceneStore.getState().undo();

    expect(useSceneStore.getState().scene.objects.map((item) => item.id)).toEqual([
      'obj_0001',
      'obj_0002',
    ]);
  });
});
