import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { parseAssetManifest, parseScene, type Scene, type SceneGraph } from '@helaengine/schema';
import { ManifestAssetResolver } from './assets.js';
import { registerBuiltinBehaviors } from './behaviors/builtins.js';
import { GameRuntime } from './GameRuntime.js';
import { SceneLoader } from './SceneLoader.js';

/**
 * Level transitions, from the runtime's side.
 *
 * The runtime never loads a level. It records that one was asked for and offers up what the player
 * should take with them; the host — the editor's preview, an exported `main.js` — does the rest.
 * These pin both halves of that contract, and the bit that is easy to get wrong: a request made
 * during a frame must not be acted on during that frame.
 */

registerBuiltinBehaviors();

const manifest = parseAssetManifest({
  version: 1,
  assets: [{ id: 'props_crate_01', name: 'Crate', category: 'props', bounds: [1, 1, 1] }],
});

const PISTOL = { id: 'weapon_pistol', name: 'Pistol', clipSize: 6, reserveAmmo: 12, damage: 10 };

function levelWith(graph: Partial<SceneGraph>, health = 100): Scene {
  return parseScene({
    sceneId: 'scene_demo',
    version: 1,
    player: { spawn: [0, 0, 0], health, respawnSeconds: 0, damageCooldown: 0 },
    inventory: { weapons: [PISTOL], startingWeaponIds: [PISTOL.id] },
    objects: [],
    graph,
  });
}

function runtimeFor(scene: Scene): GameRuntime {
  const resolver = new ManifestAssetResolver(manifest);
  const loader = new SceneLoader({ resolver, warn: () => {} });
  const runtime = new GameRuntime({
    loader,
    loaded: loader.load(scene),
    scene,
    resolver,
    warn: () => {},
  });
  const position = new THREE.Vector3(0, 0, 0);
  runtime.setPlayer({
    position,
    teleport: (to: THREE.Vector3) => position.copy(to),
  } as never);
  return runtime;
}

const doorTo = (levelId: string): Partial<SceneGraph> => ({
  nodes: [
    { id: 'start', type: 'onStart' },
    { id: 'go', type: 'loadLevel', levelId, carryState: true },
  ],
  edges: [{ from: 'start', port: 'then', to: 'go' }],
});

describe('asking for a level', () => {
  it('records the request instead of acting on it', () => {
    const runtime = runtimeFor(levelWith(doorTo('caves')));
    runtime.start();

    // Still running: the request is a note for the host, not a teardown mid-frame.
    expect(runtime.pendingLevel).toEqual({ levelId: 'caves', carryState: true });
    expect(runtime.playerHealth()).toBe(100);
  });

  it('gives the request up once, so one door cannot fire twice', () => {
    const runtime = runtimeFor(levelWith(doorTo('caves')));
    runtime.start();

    expect(runtime.takeLevelRequest()).toEqual({ levelId: 'caves', carryState: true });
    expect(runtime.takeLevelRequest()).toBeNull();
    expect(runtime.pendingLevel).toBeNull();
  });

  it('keeps the first of two requests in one frame', () => {
    const runtime = runtimeFor(levelWith(doorTo('caves')));
    runtime.start();
    runtime.requestLevel('rooftop', false);

    // Two doors firing on one frame is a level design question with no right answer. Taking the
    // last would make it depend on the order nodes happen to sit in the document.
    expect(runtime.takeLevelRequest()).toEqual({ levelId: 'caves', carryState: true });
  });

  it('ignores a request with no level', () => {
    const runtime = runtimeFor(levelWith({}));
    runtime.start();
    runtime.requestLevel('', true);
    expect(runtime.pendingLevel).toBeNull();
  });
});

describe('what the player takes with them', () => {
  const scoring: Partial<SceneGraph> = {
    variables: [{ name: 'score', type: 'number', initial: 0 }],
    nodes: [
      { id: 'start', type: 'onStart' },
      { id: 'set', type: 'setVariable', name: 'score', value: { kind: 'number', value: 42 } },
    ],
    edges: [{ from: 'start', port: 'then', to: 'set' }],
  };

  it('captures health, weapons and graph variables', () => {
    const runtime = runtimeFor(levelWith(scoring));
    runtime.start();
    runtime.damagePlayer(30);

    const carried = runtime.captureCarriedState();
    expect(carried.health).toBe(70);
    expect(carried.currentWeaponId).toBe('weapon_pistol');
    expect(carried.weapons).toHaveLength(1);
    expect(carried.variables).toEqual({ score: 42 });
  });

  it('arrives with the same health in the next level', () => {
    const first = runtimeFor(levelWith(scoring));
    first.start();
    first.damagePlayer(30);
    const carried = first.captureCarriedState();

    const second = runtimeFor(levelWith(scoring));
    second.start();
    // Fresh: the level's own starting values, before anything is carried in.
    expect(second.playerHealth()).toBe(100);
    expect(second.graph?.variable('score')).toBe(42);

    second.applyCarriedState(carried);
    expect(second.playerHealth()).toBe(70);
  });

  it('clamps to what the level it is entering allows', () => {
    const generous = runtimeFor(levelWith({}, 200));
    generous.start();
    const carried = generous.captureCarriedState();
    expect(carried.health).toBe(200);

    // The decision belongs to the level being entered, which is the only one that knows its own
    // ceiling. Arriving at 200 in a 100 HP level would put the HUD past the end of its bar.
    const strict = runtimeFor(levelWith({}, 100));
    strict.start();
    strict.applyCarriedState(carried);
    expect(strict.playerHealth()).toBe(100);
  });

  it('never arrives dead', () => {
    const runtime = runtimeFor(levelWith({}));
    runtime.start();
    // A door reached on the frame the player died would otherwise load the next level and kill them
    // in it, which reads as a bug in the new level rather than the end of the old one.
    runtime.applyCarriedState({
      health: 0,
      weapons: [],
      currentWeaponId: null,
      unlockedIds: [],
      variables: {},
    });
    expect(runtime.playerHealth()).toBe(1);
  });

  it('leaves health alone when nothing was carried', () => {
    const runtime = runtimeFor(levelWith({}));
    runtime.start();
    runtime.damagePlayer(40);
    runtime.applyCarriedState({
      health: null,
      weapons: [],
      currentWeaponId: null,
      unlockedIds: [],
      variables: {},
    });
    // Null means "use this level's own answer", which for a fresh game is its starting health —
    // not a reason to reset a run already in progress.
    expect(runtime.playerHealth()).toBe(60);
  });
});
