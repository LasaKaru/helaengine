import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  InventorySchema,
  parseAssetManifest,
  parseScene,
  type Inventory as InventoryConfig,
} from '@helaengine/schema';
import { ManifestAssetResolver } from '../assets.js';
import { BehaviorRegistry } from '../behaviors/BehaviorRegistry.js';
import { BehaviorRuntime } from '../BehaviorRuntime.js';
import { pickupDefinition } from '../behaviors/PickupBehavior.js';
import { SceneLoader } from '../SceneLoader.js';
import { INERT_WORLD, type PickupRequest, type WorldHandle } from '../world.js';
import { Inventory } from './Inventory.js';
import { WeaponSystem, type ShotHit, type WeaponInput } from './WeaponSystem.js';

const PISTOL = {
  id: 'weapon_pistol',
  name: 'Pistol',
  damage: 20,
  range: 40,
  fireInterval: 0.2,
  clipSize: 3,
  reserveAmmo: 6,
  reloadSeconds: 1,
};

const KNIFE = { id: 'weapon_knife', name: 'Knife', damage: 8, range: 2, clipSize: 0 };

function config(overrides: Record<string, unknown> = {}): InventoryConfig {
  return InventorySchema.parse({ weapons: [PISTOL, KNIFE], ...overrides });
}

function input(overrides: Partial<WeaponInput> = {}): WeaponInput {
  return {
    fire: false,
    firePressed: false,
    reload: false,
    nextWeapon: false,
    origin: new THREE.Vector3(),
    direction: new THREE.Vector3(0, 0, -1),
    ...overrides,
  };
}

interface Harness {
  system: WeaponSystem;
  inventory: Inventory;
  events: Array<{ event: string; payload: unknown }>;
}

function harness(
  options: { inventory?: InventoryConfig; hit?: Omit<ShotHit, 'point'> | null } = {},
): Harness {
  const inventory = new Inventory(options.inventory ?? config({ startingWeaponIds: [PISTOL.id] }));
  const events: Array<{ event: string; payload: unknown }> = [];
  const hit = options.hit === undefined ? { objectId: 'obj_0001', distance: 5 } : options.hit;

  const system = new WeaponSystem({
    inventory,
    cast: () => (hit === null ? null : { ...hit, point: new THREE.Vector3(0, 0, -hit.distance) }),
    emit: (event, payload) => events.push({ event, payload }),
    // Deterministic spread, so a test can assert on the aim rather than on a range.
    random: () => 1,
  });

  return { system, inventory, events };
}

function names(harness: Harness): string[] {
  return harness.events.map((entry) => entry.event);
}

describe('Inventory', () => {
  it('starts holding what the document says, in order', () => {
    const inventory = new Inventory(config({ startingWeaponIds: [KNIFE.id, PISTOL.id] }));

    expect(inventory.carried.map((entry) => entry.weapon.id)).toEqual([KNIFE.id, PISTOL.id]);
    expect(inventory.current?.weapon.id).toBe(KNIFE.id);
  });

  it('reports no ammo at all for a weapon with no clip, rather than zero', () => {
    // The difference matters to the HUD: 0 means "you are out", null means "this never runs out".
    const inventory = new Inventory(config({ startingWeaponIds: [KNIFE.id] }));

    expect(inventory.ammo).toBeNull();
    expect(inventory.loaded).toBe(true);
    expect(inventory.consume()).toBe(true);
    expect(inventory.ammo).toBeNull();
  });

  it('gives a weapon once and tops up the reserve after that', () => {
    const inventory = new Inventory(config());

    expect(inventory.give(PISTOL.id)).toBe(true);
    expect(inventory.reserve).toBe(6);

    inventory.consume();
    inventory.reload();
    expect(inventory.reserve).toBe(5);

    // Already held: the second crate is ammo rather than a duplicate gun.
    expect(inventory.give(PISTOL.id)).toBe(true);
    expect(inventory.carried).toHaveLength(1);
    expect(inventory.reserve).toBe(6);

    // And with the reserve already full it gives nothing, so the crate stays for later — the same
    // rule as a medkit at full health.
    expect(inventory.give(PISTOL.id)).toBe(false);
  });

  it('refuses ammo it cannot use, so the box stays in the world', () => {
    const inventory = new Inventory(config({ startingWeaponIds: [KNIFE.id] }));

    // Not carried at all.
    expect(inventory.addAmmo(PISTOL.id, 10)).toBe(false);
    // Carried, but has no ammo to speak of.
    expect(inventory.addAmmo(KNIFE.id, 10)).toBe(false);

    inventory.give(PISTOL.id);
    expect(inventory.addAmmo(PISTOL.id, 10)).toBe(false); // reserve already at its ceiling

    inventory.select(PISTOL.id);
    inventory.consume();
    inventory.reload(); // draws one round out of the reserve, leaving room in it
    expect(inventory.addAmmo('', 10)).toBe(true); // empty id means the held weapon
  });

  it('swaps rather than refusing once the carry limit is reached', () => {
    const inventory = new Inventory(config({ maxCarried: 1, startingWeaponIds: [KNIFE.id] }));

    expect(inventory.give(PISTOL.id)).toBe(true);
    expect(inventory.carried.map((entry) => entry.weapon.id)).toEqual([PISTOL.id]);
  });

  it('moves rounds from reserve to clip and no further', () => {
    const inventory = new Inventory(config({ startingWeaponIds: [PISTOL.id] }));

    expect(inventory.canReload).toBe(false); // clip is already full
    inventory.consume();
    inventory.consume();
    expect(inventory.ammo).toBe(1);
    expect(inventory.reload()).toBe(2);
    expect(inventory.ammo).toBe(3);
    expect(inventory.reserve).toBe(4);
  });

  it('cycles weapons and stays put with only one', () => {
    const single = new Inventory(config({ startingWeaponIds: [PISTOL.id] }));
    expect(single.next()?.weapon.id).toBe(PISTOL.id);

    const both = new Inventory(config({ startingWeaponIds: [PISTOL.id, KNIFE.id] }));
    both.select(PISTOL.id);
    expect(both.next()?.weapon.id).toBe(KNIFE.id);
    expect(both.next()?.weapon.id).toBe(PISTOL.id);
  });
});

describe('WeaponSystem', () => {
  it('fires once per click for a semi-automatic weapon', () => {
    const rig = harness();

    rig.system.update(0.016, input({ fire: true, firePressed: true }));
    rig.system.update(0.016, input({ fire: true })); // held, but not pressed again
    rig.system.update(0.016, input({ fire: true }));

    expect(rig.system.shotsFired).toBe(1);
    expect(rig.inventory.ammo).toBe(2);
  });

  it('keeps firing while held for an automatic weapon, at its own rate', () => {
    const rig = harness({
      inventory: config({
        weapons: [{ ...PISTOL, automatic: true, clipSize: 10 }],
        startingWeaponIds: [PISTOL.id],
      }),
    });

    for (let frame = 0; frame < 30; frame += 1) {
      rig.system.update(0.016, input({ fire: true }));
    }

    // 30 frames is 0.48s; at one shot per 0.2s that is three, not thirty.
    expect(rig.system.shotsFired).toBe(3);
  });

  it('turns a hit into a damage event the enemy behaviour already answers to', () => {
    const rig = harness();
    rig.system.update(0.016, input({ fire: true, firePressed: true }));

    const damage = rig.events.find((entry) => entry.event === 'damage');
    expect(damage?.payload).toMatchObject({ targetId: 'obj_0001', amount: 20, source: 'player' });
  });

  it('reports a hit on the terrain without damaging anything', () => {
    const rig = harness({ hit: { objectId: null, distance: 3 } });
    rig.system.update(0.016, input({ fire: true, firePressed: true }));

    expect(names(rig)).toContain('weaponHit');
    expect(names(rig)).not.toContain('damage');
  });

  it('says nothing was hit rather than damaging the first thing behind the wall', () => {
    const rig = harness({ hit: null });
    rig.system.update(0.016, input({ fire: true, firePressed: true }));

    expect(names(rig)).toEqual(['weaponFired']);
  });

  it('reloads on a dry trigger rather than appearing broken', () => {
    const rig = harness();

    // Three rounds, then a fourth pull on an empty clip.
    for (let shot = 0; shot < 4; shot += 1) {
      rig.system.update(0.2, input({ fire: true, firePressed: true }));
    }

    expect(rig.system.shotsFired).toBe(3);
    expect(names(rig)).toContain('weaponEmpty');
    expect(rig.system.reloading).toBe(true);

    // Firing is dead while reloading, and the clip is back afterwards.
    rig.system.update(0.5, input({ fire: true, firePressed: true }));
    expect(rig.system.shotsFired).toBe(3);
    rig.system.update(0.6, input());
    expect(rig.system.reloading).toBe(false);
    expect(rig.inventory.ammo).toBe(3);
  });

  it('reloads instantly when the weapon says it takes no time', () => {
    const rig = harness({
      inventory: config({
        weapons: [{ ...PISTOL, reloadSeconds: 0 }],
        startingWeaponIds: [PISTOL.id],
      }),
    });

    rig.inventory.consume();
    expect(rig.system.beginReload()).toBe(true);
    expect(rig.system.reloading).toBe(false);
    expect(rig.inventory.ammo).toBe(3);
  });

  it('switches weapons instead of firing when both are pressed in one frame', () => {
    const rig = harness({ inventory: config({ startingWeaponIds: [PISTOL.id, KNIFE.id] }) });
    rig.inventory.select(PISTOL.id);

    rig.system.update(0.016, input({ fire: true, firePressed: true, nextWeapon: true }));

    expect(rig.system.shotsFired).toBe(0);
    expect(rig.inventory.current?.weapon.id).toBe(KNIFE.id);
    expect(names(rig)).toEqual(['weaponSwitched']);
  });

  it('spreads a shot off the aim, and leaves a pinpoint weapon pinpoint', () => {
    const spread = harness({
      inventory: config({
        weapons: [{ ...PISTOL, spreadDegrees: 10 }],
        startingWeaponIds: [PISTOL.id],
      }),
    });
    spread.system.update(0.016, input({ fire: true, firePressed: true }));
    const spreadAim = spread.events[0]?.payload as { direction: number[] };
    expect(spreadAim.direction[0]).not.toBeCloseTo(0, 5);

    const exact = harness();
    exact.system.update(0.016, input({ fire: true, firePressed: true }));
    const exactAim = exact.events[0]?.payload as { direction: number[] };
    expect(exactAim.direction).toEqual([0, 0, -1]);
  });

  it('does nothing at all with empty hands', () => {
    const rig = harness({ inventory: config({ startingWeaponIds: [] }) });
    rig.system.update(0.016, input({ fire: true, firePressed: true }));

    expect(rig.system.shotsFired).toBe(0);
    expect(rig.events).toHaveLength(0);
  });
});

const manifest = parseAssetManifest({
  version: 1,
  assets: [{ id: 'props_crate_01', name: 'Crate', category: 'props', bounds: [1, 1, 1] }],
});

/** A world that records what was offered and answers however the test wants. */
function pickupWorld(answer: (request: PickupRequest) => boolean): {
  world: WorldHandle;
  offers: PickupRequest[];
  destroyed: string[];
  player: THREE.Vector3;
} {
  const offers: PickupRequest[] = [];
  const destroyed: string[] = [];
  const player = new THREE.Vector3(10, 0, 0);

  return {
    offers,
    destroyed,
    player,
    world: {
      ...INERT_WORLD,
      playerPosition: () => player,
      collect: (request) => {
        offers.push(request);
        return answer(request);
      },
      destroy: (objectId) => destroyed.push(objectId),
    },
  };
}

function pickupRuntime(
  params: Record<string, unknown>,
  world: WorldHandle,
): { runtime: BehaviorRuntime; node: THREE.Object3D } {
  const scene = parseScene({
    sceneId: 'scene_test',
    version: 1,
    objects: [
      { id: 'obj_0001', assetId: 'props_crate_01', behaviors: [{ type: 'pickup', params }] },
    ],
  });
  const loader = new SceneLoader({ resolver: new ManifestAssetResolver(manifest), warn: () => {} });
  const loaded = loader.load(scene);
  const registry = new BehaviorRegistry().register(pickupDefinition);

  const runtime = new BehaviorRuntime({ loaded, scene, registry, world, warn: () => {} });
  runtime.start();
  return { runtime, node: loaded.objects.get('obj_0001')! };
}

describe('PickupBehavior', () => {
  it('offers itself only once the player is inside its radius', () => {
    const rig = pickupWorld(() => true);
    const { runtime } = pickupRuntime({ kind: 'health', amount: 25, radius: 2 }, rig.world);

    runtime.update(0.016);
    expect(rig.offers).toHaveLength(0);

    rig.player.set(1, 0, 0);
    runtime.update(0.016);
    expect(rig.offers).toEqual([{ kind: 'health', weaponId: '', amount: 25 }]);
    expect(rig.destroyed).toEqual(['obj_0001']);
  });

  it('stays in the world when the offer is refused', () => {
    // The medkit-at-full-health case, and the single most annoying bug this kind of behaviour has.
    const rig = pickupWorld(() => false);
    const { runtime, node } = pickupRuntime({ kind: 'health', radius: 2 }, rig.world);

    rig.player.set(0, 0, 0);
    runtime.update(0.016);
    runtime.update(0.016);

    expect(rig.offers).toHaveLength(2);
    expect(rig.destroyed).toHaveLength(0);
    expect(node.visible).toBe(true);
  });

  it('hides and comes back rather than being destroyed when it respawns', () => {
    const rig = pickupWorld(() => true);
    const { runtime, node } = pickupRuntime(
      { kind: 'ammo', amount: 12, radius: 2, respawnSeconds: 1 },
      rig.world,
    );

    rig.player.set(0, 0, 0);
    runtime.update(0.016);
    expect(node.visible).toBe(false);
    expect(rig.destroyed).toHaveLength(0);

    // The behaviour runtime clamps its delta to 100ms, so a second of game time is ten frames of
    // it — passing 1.0 in one call would advance the timer by a tenth of what the test meant.
    for (let frame = 0; frame < 5; frame += 1) runtime.update(0.1);
    expect(node.visible).toBe(false);
    for (let frame = 0; frame < 6; frame += 1) runtime.update(0.1);
    expect(node.visible).toBe(true);

    // And it can be taken again.
    runtime.update(0.016);
    expect(rig.offers).toHaveLength(2);
  });

  it('ignores a player standing far above or below it', () => {
    const rig = pickupWorld(() => true);
    const { runtime } = pickupRuntime({ kind: 'health', radius: 2 }, rig.world);

    rig.player.set(0, 6, 0);
    runtime.update(0.016);
    expect(rig.offers).toHaveLength(0);
  });

  it('raises the named sound event, without knowing what it sounds like', () => {
    const rig = pickupWorld(() => true);
    const heard: string[] = [];
    const { runtime } = pickupRuntime(
      { kind: 'health', radius: 2, sfxEvent: 'medkitTaken' },
      rig.world,
    );
    for (const event of ['medkitTaken', 'itemPickedUp']) {
      runtime.on(event, () => heard.push(event));
    }

    rig.player.set(0, 0, 0);
    runtime.update(0.016);
    expect(heard).toContain('medkitTaken');
    expect(heard).toContain('itemPickedUp');
  });
});
