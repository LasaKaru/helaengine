import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { parseAssetManifest, parseScene } from '@helaengine/schema';
import { ManifestAssetResolver } from '../assets.js';
import { registerBuiltinBehaviors } from '../behaviors/builtins.js';
import { GameRuntime } from '../GameRuntime.js';
import { SceneLoader } from '../SceneLoader.js';

// `GameRuntime` builds its behaviours from the shipped registry, which is what an exported project
// does too — so the test registers the builtins rather than substituting a registry of its own.
registerBuiltinBehaviors();

const manifest = parseAssetManifest({
  version: 1,
  assets: [
    { id: 'props_flag_01', name: 'Flag', category: 'props', bounds: [1, 2, 1] },
    { id: 'props_crate_01', name: 'Crate', category: 'props', bounds: [1, 1, 1] },
  ],
});

const PISTOL = {
  id: 'weapon_pistol',
  name: 'Pistol',
  clipSize: 6,
  reserveAmmo: 12,
  damage: 10,
};

interface Rig {
  runtime: GameRuntime;
  player: THREE.Vector3;
}

function rig(
  options: {
    checkpoints?: Array<{ id: string; position: [number, number, number]; params?: unknown }>;
    startingWeaponIds?: string[];
  } = {},
): Rig {
  const checkpoints = options.checkpoints ?? [
    { id: 'obj_0001', position: [10, 0, 0] as [number, number, number] },
  ];

  const scene = parseScene({
    sceneId: 'scene_demo',
    version: 1,
    player: { spawn: [0, 0, 0], health: 100, respawnSeconds: 0, damageCooldown: 0 },
    inventory: {
      weapons: [PISTOL],
      startingWeaponIds: options.startingWeaponIds ?? [PISTOL.id],
    },
    objects: checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      assetId: 'props_flag_01',
      transform: { position: checkpoint.position },
      behaviors: [{ type: 'checkpoint', params: checkpoint.params ?? { radius: 2 } }],
    })),
  });

  const resolver = new ManifestAssetResolver(manifest);
  const loader = new SceneLoader({ resolver, warn: () => {} });
  const loaded = loader.load(scene);
  const player = new THREE.Vector3(0, 0, 0);
  const runtime = new GameRuntime({ loader, loaded, scene, resolver, warn: () => {} });
  runtime.setPlayer({
    position: player,
    teleport: (to: THREE.Vector3) => player.copy(to),
  } as never);
  runtime.start();

  return { runtime, player };
}

describe('checkpoints', () => {
  it('does nothing until the player is close enough', () => {
    const { runtime, player } = rig();

    runtime.update(0.1);
    expect(runtime.checkpointId).toBeNull();

    player.set(9, 0, 0);
    runtime.update(0.1);
    expect(runtime.checkpointId).toBe('obj_0001');
  });

  it('announces itself once rather than on every frame the player stands in it', () => {
    const reached = vi.fn();
    const { runtime, player } = rig();
    runtime.behaviors.on('checkpointReached', reached);

    player.set(10, 0, 0);
    for (let frame = 0; frame < 10; frame += 1) runtime.update(0.1);

    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('respawns at the checkpoint rather than the spawn point', () => {
    const { runtime, player } = rig();

    player.set(10, 0, 0);
    runtime.update(0.1);

    player.set(40, 0, 40);
    runtime.damagePlayer(1000);
    runtime.update(0.1);

    expect(runtime.playerAlive).toBe(true);
    expect(player.toArray()).toEqual([10, 0, 0]);
  });

  it('honours the checkpoint reached most recently', () => {
    const { runtime, player } = rig({
      checkpoints: [
        { id: 'obj_0001', position: [10, 0, 0] },
        { id: 'obj_0002', position: [-10, 0, 0] },
      ],
    });

    player.set(10, 0, 0);
    runtime.update(0.1);
    player.set(-10, 0, 0);
    runtime.update(0.1);
    expect(runtime.checkpointId).toBe('obj_0002');

    runtime.damagePlayer(1000);
    runtime.update(0.1);
    expect(player.x).toBe(-10);
  });

  it('restores health the way the checkpoint says', () => {
    const partial = rig({
      checkpoints: [
        {
          id: 'obj_0001',
          position: [10, 0, 0],
          params: { radius: 2, reset: { health: 'partial', healthFraction: 0.25 } },
        },
      ],
    });
    partial.player.set(10, 0, 0);
    partial.runtime.update(0.1);
    partial.runtime.damagePlayer(1000);
    partial.runtime.update(0.1);
    expect(partial.runtime.playerHealth()).toBe(25);

    const none = rig({
      checkpoints: [
        { id: 'obj_0001', position: [10, 0, 0], params: { radius: 2, reset: { health: 'none' } } },
      ],
    });
    none.player.set(10, 0, 0);
    none.runtime.update(0.1);
    none.runtime.damagePlayer(1000);
    none.runtime.update(0.1);
    // One rather than zero: coming back dead would be an instant second death.
    expect(none.runtime.playerHealth()).toBe(1);
  });

  it('refills ammo only when the checkpoint says to', () => {
    const refilling = rig({
      checkpoints: [
        {
          id: 'obj_0001',
          position: [10, 0, 0],
          params: { radius: 2, reset: { ammo: 'full' } },
        },
      ],
    });
    refilling.runtime.inventory.consume();
    refilling.runtime.inventory.consume();
    refilling.player.set(10, 0, 0);
    refilling.runtime.update(0.1);
    refilling.runtime.damagePlayer(1000);
    refilling.runtime.update(0.1);
    expect(refilling.runtime.inventory.ammo).toBe(6);

    const stingy = rig();
    stingy.runtime.inventory.consume();
    stingy.player.set(10, 0, 0);
    stingy.runtime.update(0.1);
    stingy.runtime.damagePlayer(1000);
    stingy.runtime.update(0.1);
    expect(stingy.runtime.inventory.ammo).toBe(5);
  });

  it('captures a save that describes state and never structure', () => {
    const { runtime, player } = rig();
    player.set(10, 0, 0);
    runtime.update(0.1);
    runtime.damagePlayer(30);
    runtime.inventory.consume();

    const save = runtime.captureSave();
    expect(save).toMatchObject({
      version: 1,
      sceneId: 'scene_demo',
      checkpointId: 'obj_0001',
      checkpointPosition: [10, 0, 0],
      health: 70,
      currentWeaponId: PISTOL.id,
    });
    expect(save.weapons).toEqual([{ weaponId: PISTOL.id, clip: 5, reserve: 12 }]);
    // Nothing about what the scene *contains* — a save can never change what the game is.
    expect(Object.keys(save)).not.toContain('objects');
  });

  it('puts a saved run back, player and all', () => {
    const first = rig();
    first.player.set(10, 0, 0);
    first.runtime.update(0.1);
    first.runtime.damagePlayer(40);
    const save = first.runtime.captureSave();

    const second = rig();
    expect(second.runtime.restoreSave(save)).toBe(true);
    expect(second.runtime.playerHealth()).toBe(60);
    expect(second.runtime.checkpointId).toBe('obj_0001');
    expect(second.player.toArray()).toEqual([10, 0, 0]);
  });

  it('refuses a save from a different scene rather than applying it', () => {
    const { runtime } = rig();
    expect(runtime.restoreSave({ ...runtime.captureSave(), sceneId: 'scene_other' })).toBe(false);
  });

  it('clamps a hand-edited save rather than trusting it', () => {
    const { runtime } = rig();
    const tampered = {
      ...runtime.captureSave(),
      health: 9_999,
      weapons: [{ weaponId: PISTOL.id, clip: 500, reserve: 500 }],
    };

    runtime.restoreSave(tampered);
    expect(runtime.playerHealth()).toBe(100);
    expect(runtime.inventory.ammo).toBe(6);
    expect(runtime.inventory.reserve).toBe(12);
  });

  it('drops a weapon the catalogue no longer has rather than losing the whole run', () => {
    const { runtime } = rig();
    runtime.restoreSave({
      ...runtime.captureSave(),
      weapons: [
        { weaponId: 'weapon_deleted', clip: 3, reserve: 3 },
        { weaponId: PISTOL.id, clip: 2, reserve: 4 },
      ],
      currentWeaponId: PISTOL.id,
    });

    expect(runtime.inventory.carried.map((entry) => entry.weapon.id)).toEqual([PISTOL.id]);
    expect(runtime.inventory.ammo).toBe(2);
  });

  it('forgets the checkpoint when the preview stops', () => {
    const { runtime, player } = rig();
    player.set(10, 0, 0);
    runtime.update(0.1);

    runtime.stop();
    expect(runtime.checkpointId).toBeNull();
    expect(runtime.elapsedSeconds).toBe(0);
  });
});
