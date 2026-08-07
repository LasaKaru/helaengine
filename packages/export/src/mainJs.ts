import type { Scene, SceneObject } from '@helaengine/schema';

/**
 * What an export *does* when it is opened.
 *
 * - `static` draws the world and stops there. Small, and the right answer for a level someone
 *   wants to show rather than play.
 * - `game` starts everything: physics, behaviours, the menu shell, combat, checkpoints, sound.
 *
 * A mode rather than a pile of toggles, because the two are not points on a scale — they need
 * different engine bundles, and half the toggles would be meaningless in one of them.
 */
export type ExportMode = 'static' | 'game';

/** How the scene is written into `main.js`. Cosmetic: both drive the same data-driven engine. */
export type CodeStyle = 'document' | 'readable';

const STATIC_MAIN = `import {
  GltfModelSource,
  ManifestAssetResolver,
  SceneLoader,
  Viewport,
} from './engine/runtime.js';

/**
 * A HelaEngine export.
 *
 * This file is yours: it is deliberately short and unminified so you can read it, change it, or
 * throw it away and drive the engine yourself. Everything it uses is exported from
 * ./engine/runtime.js.
 */
const [scene, manifest] = await Promise.all([
  fetch('./scene.json').then((response) => response.json()),
  fetch('./assets/manifest.json').then((response) => response.json()),
]);

const loader = new SceneLoader({
  resolver: new ManifestAssetResolver(manifest),
  modelSource: new GltfModelSource({ baseUrl: './assets/' }),
});

const viewport = new Viewport({ container: document.getElementById('viewport'), loader });

// Built twice, on purpose. The first pass draws immediately from the manifest's bounds, so the
// world is there while the models are still downloading; the second rebuilds it once they have
// arrived. \`load()\` is synchronous and takes whatever is in the model cache at the time, so
// preloading after the only build would fill a cache nothing ever reads — and every object would
// stay a placeholder box.
viewport.setScene(scene);
viewport.frameScene();
viewport.start();

const report = await loader.preload(scene);
if (report.failed.length > 0) console.warn('[helaengine] some assets failed', report.failed);
viewport.setScene(scene);
viewport.frameScene();

/**
 * A small handle on the running export.
 *
 * Not test scaffolding — it is here because an export is meant to be *yours*, and the first thing
 * anybody hand-editing one needs is a way to poke at it from the console. It is also what lets the
 * editor's visual-regression suite point its own camera exactly where this one is, so "the export
 * renders what the editor renders" is a claim about the world rather than about camera defaults.
 */
window.helaengineExport = {
  // A static export draws the world and stops, so it has no physics, no player and no menu. The
  // smoke harness reads this and skips the checks that would be meaningless rather than failing a
  // build for not doing something it was never asked to do.
  mode: 'static',
  sceneReady: true,
  ready: true,
  scene,
  loader,
  viewport,
  camera: viewport.camera,
  cameraPose: () => ({
    position: viewport.camera.position.toArray(),
    target: viewport.controls.target.toArray(),
    fov: viewport.camera.fov,
  }),
  assetsFailed: report.failed.map((failure) => failure.assetId),
};
`;

const GAME_MAIN = `import {
  AudioSystem,
  createCameraRig,
  createPlayerAvatar,
  GltfModelSource,
  InputManager,
  ManifestAssetResolver,
  MixerStore,
  nextCameraMode,
  PhysicsWorld,
  registerBuiltinBehaviors,
  SaveStore,
  SceneLoader,
  startScene,
  THREE,
  UIRenderer,
  Viewport,
} from './engine/runtime.js';

/**
 * A HelaEngine game.
 *
 * This is the same code path the editor's Play Preview runs, written out so you can read it. There
 * is nothing here the engine hides: it loads a document, builds a world, and drives a loop.
 */
const [scene, manifest] = await Promise.all([
  fetch('./scene.json').then((response) => response.json()),
  fetch('./assets/manifest.json').then((response) => response.json()),
]);

registerBuiltinBehaviors();

const loader = new SceneLoader({
  resolver: new ManifestAssetResolver(manifest),
  modelSource: new GltfModelSource({ baseUrl: './assets/' }),
});
const resolver = new ManifestAssetResolver(manifest);

const container = document.getElementById('viewport');
const viewport = new Viewport({ container, loader });
viewport.setScene(scene);
viewport.start();

// Models first, then the world is rebuilt with them in it — see the note in the static export.
const report = await loader.preload(scene);
if (report.failed.length > 0) console.warn('[helaengine] some assets failed', report.failed);
const loaded = viewport.setScene(scene);

/**
 * A small handle on the running export, published in stages.
 *
 * Not test scaffolding — an export is meant to be *yours*, and the first thing anybody hand-editing
 * one wants is something to poke at from the console. Each field becomes true at the moment the
 * thing it describes actually happened, so a build that dies halfway still says how far it got:
 * "the scene loaded but physics did not" is a diagnosis, and a blank page is not.
 */
window.helaengineExport = {
  mode: 'game',
  sceneReady: true,
  physicsReady: false,
  ready: false,
  scene,
  loader,
  viewport,
  camera: viewport.camera,
  cameraPose: () => ({
    position: viewport.camera.position.toArray(),
    target: viewport.controls.target.toArray(),
    fov: viewport.camera.fov,
  }),
  assetsFailed: report.failed.map((failure) => failure.assetId),
};

const physics = await PhysicsWorld.create({ gravity: scene.player.gravity });
window.helaengineExport.physicsReady = true;
const [spawnX, spawnY, spawnZ] = scene.player.spawn;
const ground = loaded.terrainField ? loaded.terrainField.sampleHeight(spawnX, spawnZ) : 0;
const spawn = new THREE.Vector3(spawnX, Math.max(spawnY, ground + 0.5), spawnZ);
const player = physics.createPlayer(scene.player, spawn);

const game = startScene({ loader, loaded, scene, resolver, physics, player, spawnPoint: spawn });

const saves = new SaveStore({ sceneId: scene.sceneId });
const saved = saves.read();
if (saved) game.restoreSave(saved);
game.behaviors.on('checkpointReached', () => saves.write(game.captureSave()));

const input = new InputManager({ element: viewport.renderer.domElement });
input.attach();

const mixer = new MixerStore();
const audio = new AudioSystem({
  config: scene.audioConfig,
  bus: game.behaviors,
  resolve: (assetId) => {
    const entry = resolver.get(assetId);
    return entry && entry.audioPath ? './assets/' + entry.audioPath : null;
  },
  listener: () => ({
    position: viewport.camera.getWorldPosition(new THREE.Vector3()),
    forward: viewport.camera.getWorldDirection(new THREE.Vector3()),
  }),
});
audio.setMixer(mixer.read());
audio.start();

const avatar = createPlayerAvatar(scene.player);
loaded.threeScene.add(avatar.node);
let rig = createCameraRig(scene.gameConfig.cameraMode);
const look = { yaw: 0, pitch: 0 };
const lookDelta = { x: 0, y: 0 };
const MAX_PITCH = Math.PI / 2 - 0.05;

const shell = new UIRenderer({
  container,
  config: scene.uiConfig,
  mixer: mixer.read(),
  resolveAsset: (assetId) => {
    const entry = resolver.get(assetId);
    return entry && entry.thumbnailPath ? './assets/' + entry.thumbnailPath : null;
  },
  onVolumeChange: (channel, value) => {
    const next = Object.assign({}, mixer.read(), { [channel]: value });
    mixer.write(next);
    audio.setMixer(next);
  },
  onScreenChange: (screen) => {
    input.captureOnClick = screen === 'playing';
    if (screen !== 'playing') input.releasePointerLock();
  },
  onAction: (action) => {
    if (action === 'restartCheckpoint') game.respawnPlayer();
    if (action === 'startGame' || action === 'resume' || action === 'restartCheckpoint') {
      input.requestPointerLock();
      AudioSystem.resume();
    }
  },
});
shell.mount();
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') shell.togglePause();
});

// The whole game loop. Physics steps at a fixed rate inside \`physics.step\`; everything else runs
// once per rendered frame.
viewport.onFrame((delta) => {
  const playing = shell.screen === 'playing';
  audio.setSuspended(!playing);
  audio.update(delta, playing ? undefined : 'menu');
  // Ambience that opted in follows the wind, so a gale is heard as well as seen.
  audio.setWindStrength(scene.environment.wind.strength);

  input.update(delta);
  if (!playing) {
    input.consumeLook(lookDelta);
    input.endFrame();
    return;
  }

  input.consumeLook(lookDelta);
  look.yaw += lookDelta.x;
  look.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, look.pitch + lookDelta.y));

  if (scene.gameConfig.allowModeSwitch && input.wasPressed('switchCamera')) {
    rig = createCameraRig(nextCameraMode(rig.mode));
  }

  const move = input.move;
  physics.step(delta, (step) =>
    player.move(
      {
        forward: move.y,
        right: move.x,
        jump: input.isDown('jump'),
        sprint: input.isDown('sprint'),
        crouch: input.isDown('crouch'),
        yaw: look.yaw,
      },
      step,
    ),
  );

  const origin = viewport.camera.getWorldPosition(new THREE.Vector3());
  const direction = viewport.camera.getWorldDirection(new THREE.Vector3());
  game.update(
    delta,
    {
      fire: input.isDown('fire'),
      firePressed: input.wasPressed('fire'),
      reload: input.wasPressed('reload'),
      nextWeapon: input.wasPressed('nextWeapon'),
      origin,
      direction,
    },
    input.sequenceKeys,
  );

  shell.setHud({
    health: game.playerHealth(),
    maxHealth: scene.player.health,
    ammo: game.inventory.ammo,
    timer: game.elapsedSeconds,
  });

  avatar.update(player.position, look.yaw, player.crouched);
  avatar.node.visible = rig.mode !== 'fps';

  rig.update(
    viewport.camera,
    {
      position: player.position,
      eyeHeight: player.eyeHeight,
      speed: player.speed,
      grounded: player.grounded,
    },
    look,
    delta,
    {
      fieldOfView: scene.gameConfig.fieldOfView,
      distance: scene.gameConfig.thirdPersonDistance,
      height: scene.gameConfig.topDownHeight,
      headBob: scene.gameConfig.headBob,
      probe: (from, dir, max) => physics.castDistance(from, dir, max, player.colliderHandle),
    },
  );

  input.endFrame();
});

// The last stage of the handle above: the loop is running, so there is now a player to ask about.
// This is what the pre-delivery smoke test reads. Deliberately *state* rather than a verdict — a
// build that could grade itself is a build that could grade itself wrong.
Object.assign(window.helaengineExport, {
  ready: true,
  game,
  playerPosition: () => [player.position.x, player.position.y, player.position.z],
  playerHealth: () => game.playerHealth(),
  screen: () => shell.screen,
});
`;

/**
 * The "readable code" preamble.
 *
 * Purely cosmetic, and worth being blunt about that: the engine is data-driven, and this emits
 * literal calls that reconstruct exactly the document sitting next to them. It exists because a
 * person who opens an export and finds `SceneLoader.load('scene.json')` learns nothing about their
 * own level, while a list of `place('tree_pine_01', …)` calls is something they can edit. Both run
 * the same engine; one is legible.
 */
function readablePlacements(scene: Scene): string {
  const lines: string[] = [];

  for (const object of scene.objects) {
    lines.push(describe(object));
  }

  return lines.join('\n');
}

function describe(object: SceneObject): string {
  const { position, rotation, scale } = object.transform;
  const parts = [`  place('${object.assetId}', {`, `    id: '${object.id}',`];

  parts.push(`    position: [${position.join(', ')}],`);
  if (rotation.some((value) => value !== 0)) parts.push(`    rotation: [${rotation.join(', ')}],`);
  if (scale.some((value) => value !== 1)) parts.push(`    scale: [${scale.join(', ')}],`);
  if (object.parentId) parts.push(`    parent: '${object.parentId}',`);

  for (const behavior of object.behaviors) {
    parts.push(`    // behaviour: ${behavior.type} ${JSON.stringify(behavior.params)}`);
  }
  if (object.trigger) parts.push(`    // trigger volume: ${object.trigger.shape}`);

  parts.push('  });');
  return parts.join('\n');
}

export interface MainJsInput {
  scene: Scene;
  mode: ExportMode;
  style: CodeStyle;
  minify: boolean;
}

export function mainJs(input: MainJsInput): string {
  const base = input.mode === 'game' ? GAME_MAIN : STATIC_MAIN;
  const source = input.style === 'readable' ? withReadableIndex(base, input.scene) : base;

  if (!input.minify) return source;

  // Block comments go first, and that ordering is the whole correctness of this function. Removing
  // `*`-prefixed lines beforehand strips the `*/` terminators, which leaves an unclosed `/**` that
  // then swallows everything up to the next one — an export that still built, still zipped, and
  // shipped a `main.js` with its import list deleted.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .concat('\n');
}

/** Appends the human-readable listing, as running code that reproduces the document. */
function withReadableIndex(base: string, scene: Scene): string {
  return `${base}
/**
 * Your level, written out.
 *
 * The engine is data-driven: everything below is already in scene.json, and the world you are
 * looking at was built from that file. This function is here so the level is *legible* — so you
 * can find the tree you want to move without reading JSON. Calling it re-places the same objects
 * on top of the ones already there, so it is commented out by default.
 */
export function describeLevel(place) {
${readablePlacements(scene)}
}
`;
}
