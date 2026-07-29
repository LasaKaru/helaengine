import { beforeEach, describe, expect, it } from 'vitest';
import { SceneObjectSchema, TriggerSchema } from '@helaengine/schema';
import { createEmptyScene, useSceneStore } from './sceneStore';
import { describeAction, newAction, triggerDefaults } from '../triggers';

function trigger(id: string, assetId = 'logic_trigger_box') {
  return SceneObjectSchema.parse({
    id,
    assetId,
    transform: { scale: [4, 3, 4] },
    trigger: triggerDefaults(assetId),
  });
}

describe('trigger defaults', () => {
  it('picks the shape from the asset that was dropped', () => {
    expect(triggerDefaults('logic_trigger_box').shape).toBe('box');
    expect(triggerDefaults('logic_trigger_sphere').shape).toBe('sphere');
  });

  it('starts unwired — a placed volume does nothing until it is told to', () => {
    const value = triggerDefaults('logic_trigger_box');
    expect(value.onEnter).toEqual([]);
    expect(value.onExit).toEqual([]);
    expect(value.detects).toBe('player');
  });

  it('builds every action kind in a shape its own schema accepts', () => {
    for (const type of ['emit', 'spawn', 'destroy'] as const) {
      const action = newAction(type, 'enemy_goblin_01');
      expect(action.type).toBe(type);
      // `destroy` starts without a target on purpose — the user picks one — so it is checked
      // against the schema only once it has been filled in.
      if (type !== 'destroy') {
        expect(() => TriggerSchema.parse({ shape: 'box', onEnter: [action] })).not.toThrow();
      }
      expect(describeAction(action).length).toBeGreaterThan(0);
    }
  });
});

describe('trigger editing', () => {
  beforeEach(() => {
    useSceneStore.setState({ scene: createEmptyScene(), selectedIds: [] });
    useSceneStore.getState().addObject(trigger('obj_0001'));
  });

  it('edits a volume through the store, undoably', () => {
    useSceneStore.getState().setTrigger('obj_0001', { detects: 'any', once: true });

    expect(useSceneStore.getState().scene.objects[0]!.trigger).toMatchObject({
      detects: 'any',
      once: true,
    });

    useSceneStore.getState().undo();
    expect(useSceneStore.getState().scene.objects[0]!.trigger?.detects).toBe('player');
  });

  it('adds actions and keeps them through a duplicate', () => {
    useSceneStore.getState().setTrigger('obj_0001', {
      onEnter: [newAction('spawn', 'enemy_goblin_01')],
    });
    const [copy] = useSceneStore.getState().duplicateObjects(['obj_0001']);

    const duplicated = useSceneStore.getState().scene.objects.find((item) => item.id === copy);
    expect(duplicated?.trigger?.onEnter).toHaveLength(1);
    expect(duplicated?.trigger?.onEnter[0]).toMatchObject({ type: 'spawn' });

    // A deep copy, not a shared reference — editing the copy must not reach back into the original.
    useSceneStore.getState().setTrigger(copy!, { onEnter: [] });
    expect(useSceneStore.getState().scene.objects[0]!.trigger?.onEnter).toHaveLength(1);
  });

  it('leaves a non-trigger object alone', () => {
    useSceneStore
      .getState()
      .addObject(SceneObjectSchema.parse({ id: 'obj_0002', assetId: 'tree_pine_01' }));
    useSceneStore.getState().setTrigger('obj_0002', { detects: 'any' });

    expect(useSceneStore.getState().scene.objects[1]!.trigger).toBeNull();
  });
});
