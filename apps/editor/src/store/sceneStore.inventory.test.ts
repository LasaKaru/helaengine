import { beforeEach, describe, expect, it } from 'vitest';
import { SceneObjectSchema, SceneSchema } from '@helaengine/schema';
import { createEmptyScene, useSceneStore } from './sceneStore';

const inventory = () => useSceneStore.getState().scene.inventory;

describe('weapon catalogue', () => {
  beforeEach(() => {
    useSceneStore.setState({ scene: createEmptyScene(), selectedIds: [] });
  });

  it('starts empty, because a scene is not a shooter until someone says so', () => {
    expect(inventory().weapons).toEqual([]);
    expect(inventory().startingWeaponIds).toEqual([]);
  });

  it('adds weapons with sequential ids and readable names', () => {
    const first = useSceneStore.getState().addWeapon();
    const second = useSceneStore.getState().addWeapon();

    expect([first, second]).toEqual(['weapon_0001', 'weapon_0002']);
    expect(inventory().weapons.map((weapon) => weapon.name)).toEqual(['Weapon 1', 'Weapon 2']);
  });

  it('never reuses an id a pickup still refers to', () => {
    // Reusing one would hand every crate that granted the deleted weapon a different gun, with
    // nothing anywhere saying so.
    useSceneStore.getState().addWeapon();
    useSceneStore.getState().addWeapon();
    useSceneStore.getState().addObject(
      SceneObjectSchema.parse({
        id: 'obj_0001',
        assetId: 'props_crate_01',
        behaviors: [{ type: 'pickup', params: { kind: 'weapon', weaponId: 'weapon_0002' } }],
      }),
    );
    useSceneStore.getState().removeWeapon('weapon_0002');

    expect(useSceneStore.getState().addWeapon()).toBe('weapon_0003');
  });

  it('does reuse an id nothing refers to', () => {
    useSceneStore.getState().addWeapon();
    useSceneStore.getState().addWeapon();
    useSceneStore.getState().removeWeapon('weapon_0002');

    expect(useSceneStore.getState().addWeapon()).toBe('weapon_0002');
  });

  it('edits one weapon without touching the others', () => {
    useSceneStore.getState().addWeapon();
    useSceneStore.getState().addWeapon();
    useSceneStore.getState().setWeapon('weapon_0001', { damage: 99, automatic: true });

    expect(inventory().weapons[0]).toMatchObject({ damage: 99, automatic: true });
    expect(inventory().weapons[1]?.damage).toBe(25);
  });

  it('drops a deleted weapon from the starting loadout as well as the catalogue', () => {
    // The schema rejects a loadout naming a weapon that is not in the catalogue, so a delete that
    // left the id behind would make the scene unsaveable — and the failure would surface at save
    // time, a long way from the button that caused it.
    useSceneStore.getState().addWeapon();
    useSceneStore.getState().toggleStartingWeapon('weapon_0001');
    expect(inventory().startingWeaponIds).toEqual(['weapon_0001']);

    useSceneStore.getState().removeWeapon('weapon_0001');
    expect(inventory().startingWeaponIds).toEqual([]);
    expect(() => SceneSchema.parse(useSceneStore.getState().scene)).not.toThrow();
  });

  it('toggles a weapon in and out of the starting loadout', () => {
    useSceneStore.getState().addWeapon();
    useSceneStore.getState().toggleStartingWeapon('weapon_0001');
    useSceneStore.getState().toggleStartingWeapon('weapon_0001');

    expect(inventory().startingWeaponIds).toEqual([]);
  });

  it('undoes a weapon edit as one step', () => {
    useSceneStore.getState().addWeapon();
    useSceneStore.getState().setWeapon('weapon_0001', { damage: 99 });
    useSceneStore.getState().undo();

    expect(inventory().weapons[0]?.damage).toBe(25);
  });

  it('keeps the carry limit inside the schema', () => {
    useSceneStore.getState().setInventory({ maxCarried: 2 });
    expect(inventory().maxCarried).toBe(2);
    expect(() => SceneSchema.parse(useSceneStore.getState().scene)).not.toThrow();
  });
});
