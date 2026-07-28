import { beforeEach, describe, expect, it } from 'vitest';
import { SceneObjectSchema } from '@helaengine/schema';
import { createEmptyScene, useSceneStore } from './sceneStore';

function object(id: string, assetId = 'tree_pine_01') {
  return SceneObjectSchema.parse({ id, assetId });
}

describe('physics editing', () => {
  beforeEach(() => {
    useSceneStore.setState({ scene: createEmptyScene(), selectedIds: [] });
    useSceneStore.getState().addObject(object('obj_0001'));
  });

  it("defaults to a static body deferring to the asset's own collider", () => {
    expect(useSceneStore.getState().scene.objects[0]!.physics).toEqual({
      body: 'static',
      collider: 'auto',
    });
  });

  it('overrides body and collider per instance, one undo step each', () => {
    useSceneStore.getState().setObjectPhysics('obj_0001', { body: 'dynamic' });
    useSceneStore.getState().setObjectPhysics('obj_0001', { collider: 'mesh' });

    expect(useSceneStore.getState().scene.objects[0]!.physics).toMatchObject({
      body: 'dynamic',
      collider: 'mesh',
    });

    useSceneStore.getState().undo();

    expect(useSceneStore.getState().scene.objects[0]!.physics.collider).toBe('auto');
    expect(useSceneStore.getState().scene.objects[0]!.physics.body).toBe('dynamic');
  });

  it('carries physics settings onto a duplicate', () => {
    useSceneStore.getState().setObjectPhysics('obj_0001', { body: 'dynamic', collider: 'sphere' });
    const [copy] = useSceneStore.getState().duplicateObjects(['obj_0001']);

    const duplicated = useSceneStore.getState().scene.objects.find((item) => item.id === copy);
    expect(duplicated?.physics).toMatchObject({ body: 'dynamic', collider: 'sphere' });
  });

  it('moves the player spawn without disturbing the rest of the player', () => {
    useSceneStore.getState().setPlayer({ spawn: [4, 0, -6] });

    const { player } = useSceneStore.getState().scene;
    expect(player.spawn).toEqual([4, 0, -6]);
    expect(player.moveSpeed).toBe(6);
  });

  it('keeps the player out of the objects list — it is not a placed asset', () => {
    // Worth pinning: the temptation is to make the player "just another object", which quietly
    // makes it selectable, deletable and duplicable.
    expect(useSceneStore.getState().scene.objects).toHaveLength(1);
    expect(useSceneStore.getState().scene.player.height).toBe(1.8);
  });
});
