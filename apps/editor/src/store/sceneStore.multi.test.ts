import { beforeEach, describe, expect, it } from 'vitest';
import { SceneObjectSchema, SceneSchema } from '@helaengine/schema';
import { createEmptyScene, useSceneStore } from './sceneStore';

function seed(count: number): string[] {
  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `obj_${String(index).padStart(4, '0')}`;
    useSceneStore.getState().addObject(
      SceneObjectSchema.parse({
        id,
        assetId: 'tree_pine_01',
        transform: { position: [index, 0, 0] },
        metadata: { label: `Tree ${index}` },
      }),
    );
    ids.push(id);
  }
  return ids;
}

describe('multi-object editing', () => {
  beforeEach(() => {
    useSceneStore.setState({ scene: createEmptyScene(), selectedIds: [] });
  });

  it('removes several objects in one action', () => {
    const ids = seed(3);
    useSceneStore.getState().removeObjects([ids[0]!, ids[2]!]);

    expect(useSceneStore.getState().scene.objects.map((item) => item.id)).toEqual(['obj_0002']);
  });

  it('duplicates a selection and moves the selection onto the copies', () => {
    const ids = seed(2);
    const created = useSceneStore.getState().duplicateObjects(ids);

    const state = useSceneStore.getState();
    expect(created).toEqual(['obj_0003', 'obj_0004']);
    expect(state.scene.objects).toHaveLength(4);
    expect(state.selectedIds).toEqual(created);
  });

  it('gives every copy a distinct id', () => {
    const ids = seed(3);
    const created = useSceneStore.getState().duplicateObjects(ids);
    expect(new Set(created).size).toBe(3);
  });

  it('offsets copies so they do not hide inside the originals', () => {
    const ids = seed(1);
    useSceneStore.getState().duplicateObjects(ids, [2, 0, 3]);

    const copy = useSceneStore.getState().scene.objects[1]!;
    expect(copy.transform.position).toEqual([3, 0, 3]);
    expect(copy.metadata.label).toBe('Tree 1 copy');
  });

  it('leaves the duplicated document schema-valid', () => {
    useSceneStore.getState().duplicateObjects(seed(2));
    expect(SceneSchema.safeParse(useSceneStore.getState().scene).success).toBe(true);
  });

  it('applies a batch of transforms in one write', () => {
    const ids = seed(2);
    useSceneStore.getState().setTransforms([
      { id: ids[0]!, transform: { position: [9, 1, 2], rotation: [0, 45, 0], scale: [2, 2, 2] } },
      { id: ids[1]!, transform: { position: [8, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    ]);

    const objects = useSceneStore.getState().scene.objects;
    expect(objects[0]!.transform.position).toEqual([9, 1, 2]);
    expect(objects[0]!.transform.rotation).toEqual([0, 45, 0]);
    expect(objects[1]!.transform.position).toEqual([8, 0, 0]);
  });

  it('ignores batch updates addressed to objects that are gone', () => {
    seed(1);
    expect(() =>
      useSceneStore.getState().setTransforms([
        {
          id: 'ghost',
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ]),
    ).not.toThrow();
  });

  it('toggles an id in and out of the selection', () => {
    const ids = seed(2);
    const { toggleSelected } = useSceneStore.getState();

    toggleSelected(ids[0]!);
    expect(useSceneStore.getState().selectedIds).toEqual([ids[0]]);

    toggleSelected(ids[1]!);
    expect(useSceneStore.getState().selectedIds).toEqual(ids);

    toggleSelected(ids[0]!);
    expect(useSceneStore.getState().selectedIds).toEqual([ids[1]]);
  });
});
