import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  AudioSystem,
  CoopClient,
  InputManager,
  MixerStore,
  PhysicsWorld,
  createCameraRig,
  createPlayerAvatar,
  nextCameraMode,
  registerBuiltinBehaviors,
  RemotePlayers,
  SaveStore,
  startScene,
  UIRenderer,
  type AssetResolver,
  type CameraRig,
  type GameRuntime,
  type LoadedScene,
  type PlayerAvatar,
  type PlayerController,
  type SceneLoader,
} from '@helaengine/engine';
import type { CameraMode } from '@helaengine/schema';
import { ASSET_BASE_URL } from '../engine/assetLibrary';
import { ColyseusTransport } from '../net/colyseusTransport';
import { cachedUiAssetUrl } from '../storage/uiAssets';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';
import {
  recordSimulationTiming,
  setAudioSystem,
  setCoopClient,
  resetSimulationTiming,
  setGameRuntime,
  setLookHandler,
  setPlayer,
} from '../devApi';
import { setPauseHandler } from '../useShortcuts';

registerBuiltinBehaviors();

/** Just short of straight up/down, so the view never flips through the pole. */
const MAX_PITCH = Math.PI / 2 - 0.05;

/** Reused per frame: a shot's origin and direction, which would otherwise allocate 120 times a second. */
const shotOrigin = new THREE.Vector3();
const shotDirection = new THREE.Vector3();

interface PhysicsPreviewProps {
  loadedScene: LoadedScene | null;
  resolver: AssetResolver;
  loader: SceneLoader;
}

/**
 * Play Preview: physics on, and the camera is a person standing in the world.
 *
 * The rule this shares with `BehaviorPreview` is the important one — the preview moves Three.js
 * nodes and never the document. Walking through a scene and knocking a crate over is a rehearsal,
 * not an edit, so leaving the mode puts every object back exactly where the document says it is.
 *
 * The world is built from a snapshot taken when the mode starts rather than from the live store.
 * A preview that rebuilt its physics world whenever the document changed would be rebuilding it
 * every time a dynamic body nudged something — and the document does not change while walking.
 */
export function PhysicsPreview({ loadedScene, resolver, loader }: PhysicsPreviewProps): null {
  const walking = useEditorStore((state) => state.walking);
  const setWalking = useEditorStore((state) => state.setWalking);
  const setPhysicsStatus = useEditorStore((state) => state.setPhysicsStatus);

  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);

  const [world, setWorld] = useState<PhysicsWorld | null>(null);
  const runtime = useRef<GameRuntime | null>(null);
  const controller = useRef<PlayerController | null>(null);
  const input = useRef<InputManager | null>(null);
  const rig = useRef<CameraRig | null>(null);
  const avatar = useRef<PlayerAvatar | null>(null);
  const ui = useRef<UIRenderer | null>(null);
  const saves = useRef<SaveStore | null>(null);
  const audio = useRef<AudioSystem | null>(null);
  const coop = useRef<CoopClient | null>(null);
  const remotes = useRef<RemotePlayers | null>(null);
  const look = useRef({ yaw: 0, pitch: 0 });
  const lookDelta = useRef({ x: 0, y: 0 });
  const health = useRef<number | null>(null);
  /** Seconds of actual play, for a HUD element bound to `timer`. Paused time does not count. */
  const elapsed = useRef(0);
  const setCameraMode = useEditorStore((state) => state.setCameraMode);
  const setUiScreen = useEditorStore((state) => state.setUiScreen);
  // The one piece of the document this component subscribes to. Everything else it reads once, at
  // the moment play starts — but the shell is authored while it is on screen, so it has to follow.
  const uiConfig = useSceneStore((state) => state.scene.uiConfig);
  const audioConfig = useSceneStore((state) => state.scene.audioConfig);

  useEffect(() => {
    if (!walking || !loadedScene) return;

    // The document is read once, here, and not subscribed to.
    const scene = useSceneStore.getState().scene;
    let disposed = false;
    let built: PhysicsWorld | null = null;

    setPhysicsStatus('loading');
    resetSimulationTiming();

    void PhysicsWorld.create({ gravity: scene.player.gravity })
      .then((physics) => {
        if (disposed) {
          physics.dispose();
          return;
        }
        built = physics;

        // Spawn on the ground rather than at the document's y, which is usually zero and would put
        // the player's feet inside a hill. Half a metre of clearance lets the controller settle.
        const [spawnX, spawnY, spawnZ] = scene.player.spawn;
        const ground = loadedScene.terrainField?.sampleHeight(spawnX, spawnZ) ?? 0;
        const spawnPoint = new THREE.Vector3(spawnX, Math.max(spawnY, ground + 0.5), spawnZ);
        controller.current = physics.createPlayer(scene.player, spawnPoint);
        setPlayer(controller.current);

        // One runtime owns behaviours, triggers, physics and the player. The editor's job here is
        // only to start it and drive its clock — exactly what an exported project will do.
        const game = startScene({
          loader,
          loaded: loadedScene,
          scene,
          resolver,
          physics,
          player: controller.current,
          // The corrected point, not the document's: respawning at the raw spawn y would put a
          // dead player back inside whatever hill they started on top of.
          spawnPoint,
        });
        runtime.current = game;
        setGameRuntime(game);

        // Progress persists per scene. This is the same path an exported build takes (Sprint 21) —
        // writing it now means the export inherits an exercised save system rather than a blind one.
        const store = new SaveStore({ sceneId: scene.sceneId });
        saves.current = store;
        const saved = store.read();
        if (saved) game.restoreSave(saved);

        // Saving on the checkpoint rather than on a timer: a checkpoint *is* the author saying
        // "this moment is worth keeping", and a periodic autosave would second-guess them.
        game.behaviors.on('checkpointReached', () => store.write(game.captureSave()));

        // Audio binds to the bus the rest of gameplay already talks through, so nothing in the
        // engine had to grow a "play a sound here" call.
        const mixerStore = new MixerStore();
        const sound = new AudioSystem({
          config: scene.audioConfig,
          bus: game.behaviors,
          resolve: (assetId) => {
            const entry = resolver.get(assetId);
            return entry?.audioPath ? `${ASSET_BASE_URL}${entry.audioPath}` : null;
          },
          locate: (objectId) =>
            loadedScene.objects.get(objectId)?.getWorldPosition(new THREE.Vector3()) ?? null,
          listener: () => ({
            position: camera.getWorldPosition(new THREE.Vector3()),
            forward: camera.getWorldDirection(new THREE.Vector3()),
          }),
        });
        sound.setMixer(mixerStore.read());
        sound.start();
        audio.current = sound;
        setAudioSystem(sound);
        if (game.behaviors.problems.length > 0) {
          console.warn('[helaengine] behaviour problems:', game.behaviors.problems);
        }

        // Trigger outlines are editor furniture: useful while wiring a level, wrong while playing.
        for (const node of loadedScene.objects.values()) {
          if (node.userData['isTrigger']) node.visible = false;
        }

        // Start looking the way the edit camera was, so entering the mode does not spin the view.
        const forward = camera.getWorldDirection(new THREE.Vector3());
        look.current.yaw = Math.atan2(-forward.x, -forward.z);
        look.current.pitch = 0;

        setLookHandler((yaw, pitch) => {
          look.current.yaw = yaw;
          if (pitch !== undefined) {
            look.current.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
          }
        });

        rig.current = createCameraRig(scene.gameConfig.cameraMode);
        setCameraMode(scene.gameConfig.cameraMode);

        // The shell: home -> menu -> play -> pause, rendered from the document.
        const shell = new UIRenderer({
          container: domElement.parentElement ?? domElement,
          config: scene.uiConfig,
          mixer: new MixerStore().read(),
          onVolumeChange: (channel, value) => {
            const store2 = new MixerStore();
            const next = { ...store2.read(), [channel]: value };
            store2.write(next);
            audio.current?.setMixer(next);
          },
          resolveAsset: (assetId) => {
            // Uploaded UI assets first: a home screen background is something the author added,
            // not something the ingest pipeline produced.
            const uploaded = cachedUiAssetUrl(assetId);
            if (uploaded) return uploaded;

            const entry = resolver.get(assetId);
            return entry?.thumbnailPath ? `${ASSET_BASE_URL}${entry.thumbnailPath}` : null;
          },
          onScreenChange: (screen) => {
            setUiScreen(screen);
            // The cursor belongs to whoever is being shown. Leaving it locked to the canvas while
            // a menu is up makes every button in that menu unclickable — the click never reaches
            // anything, because the pointer is captured rather than pointing at something.
            const manager = input.current;
            if (!manager) return;
            manager.captureOnClick = screen === 'playing';
            if (screen !== 'playing') manager.releasePointerLock();
          },
          onAction: (action) => {
            // The renderer moved the screen; the host decides what that means for the simulation.
            if (action === 'quit') setWalking(false);
            // Respawning rather than only teleporting: health and the death countdown are as much
            // a part of "restart" as position is, and Sprint 18 will point this at a checkpoint.
            if (action === 'restartCheckpoint') runtime.current?.respawnPlayer();
            if (action === 'startGame' || action === 'resume' || action === 'restartCheckpoint') {
              input.current?.requestPointerLock();
              // Browsers refuse to start an audio context outside a user gesture. A button press
              // is the gesture; without this the first game is silent and nothing says why.
              AudioSystem.resume();
            }
          },
        });
        shell.mount();
        ui.current = shell;
        setUiScreen(shell.screen);
        setPauseHandler(() => shell.togglePause());
        elapsed.current = game.elapsedSeconds;

        // A body to look at. First person hides it, because the camera is inside it.
        const body = createPlayerAvatar(scene.player);
        body.node.visible = scene.gameConfig.cameraMode !== 'fps';
        loadedScene.threeScene.add(body.node);
        avatar.current = body;

        // Co-op, when the document asks for it. A failure here drops to single player rather than
        // refusing to start: somebody who wanted to play should be playing, even alone.
        if (scene.gameConfig.multiplayer.enabled && scene.gameConfig.multiplayer.mode === 'coop') {
          const others = new RemotePlayers(loadedScene.threeScene, scene.player);
          remotes.current = others;

          const net = new CoopClient({
            config: scene.gameConfig.multiplayer,
            transport: new ColyseusTransport(),
            sceneId: scene.sceneId,
            scene,
            name: 'Editor',
          });
          coop.current = net;
          setCoopClient(net);
          void net.connect().then((joined) => {
            if (!joined) return;
            // The server owns destruction, so a peer's kill removes the object here too.
            net.onMessage('objectDestroyed', (payload) => {
              const objectId = (payload as { objectId?: string } | undefined)?.objectId;
              if (objectId) game.destroy(objectId);
            });
          });
        }

        setPhysicsStatus('ready');
        setWorld(physics);
      })
      .catch((error: unknown) => {
        console.error('[helaengine] physics failed to start', error);
        setPhysicsStatus('error');
        // Falling back to edit mode beats a Walk button that appears to do nothing.
        setWalking(false);
      });

    return () => {
      disposed = true;
      controller.current?.dispose();
      controller.current = null;
      setPlayer(null);
      setLookHandler(null);
      rig.current = null;
      setPauseHandler(null);
      ui.current?.unmount();
      ui.current = null;
      setUiScreen(null);
      avatar.current?.dispose();
      avatar.current = null;
      setCameraMode(null);
      void coop.current?.disconnect();
      coop.current = null;
      setCoopClient(null);
      remotes.current?.dispose();
      remotes.current = null;
      audio.current?.stop();
      audio.current = null;
      setAudioSystem(null);
      runtime.current?.stop();
      runtime.current = null;
      saves.current = null;
      setGameRuntime(null);
      for (const node of loadedScene.objects.values()) {
        if (node.userData['isTrigger']) node.visible = true;
      }
      built?.dispose();
      setWorld(null);
      setPhysicsStatus(built ? 'ready' : 'idle');
      // Anything the solver moved goes back to where the document says it is.
      loadedScene.syncTransforms(useSceneStore.getState().scene);
    };
  }, [
    walking,
    loadedScene,
    resolver,
    loader,
    camera,
    setPhysicsStatus,
    setWalking,
    setCameraMode,
    setUiScreen,
    domElement,
  ]);

  // Live-edit the shell: changing the theme or the title in the inspector repaints the menu that
  // is currently on screen, which is the whole point of a schema-driven UI.
  useEffect(() => {
    ui.current?.setConfig(uiConfig);
  }, [uiConfig]);

  // The audio config is authored while the preview is running too — swapping a track or binding a
  // new sound should be audible without leaving Walk.
  useEffect(() => {
    audio.current?.setConfig(audioConfig);
  }, [audioConfig]);

  // One input layer for every source. The engine owns it, because an exported game running on a
  // phone needs the same virtual joystick and has no React to build it with.
  useEffect(() => {
    if (!walking) return;

    const manager = new InputManager({
      element: domElement,
      lookSensitivity: useSceneStore.getState().scene.gameConfig.lookSensitivity,
    });
    manager.attach();
    input.current = manager;

    return () => {
      manager.detach();
      input.current = null;
    };
  }, [walking, domElement]);

  // Restoring the edit camera is a separate effect from the world so that a physics failure, which
  // tears the world down early, cannot leave the camera stranded inside the scene.
  useEffect(() => {
    if (!walking) return;

    const position = camera.position.clone();
    const quaternion = camera.quaternion.clone();
    return () => {
      camera.position.copy(position);
      camera.quaternion.copy(quaternion);
    };
  }, [walking, camera]);

  useFrame((_state, delta) => {
    const physics = world;
    const player = controller.current;
    const manager = input.current;
    if (!physics || !player || !manager) return;

    const scene = useSceneStore.getState().scene;
    const config = scene.gameConfig;
    const shell = ui.current;

    manager.captureOnClick = !shell || shell.screen === 'playing';

    if (shell && shell.screen !== 'playing') {
      // Menu music, and the effects go quiet: a pause screen with combat still crashing away
      // behind it is the least paused a game can feel.
      audio.current?.setSuspended(true);
      audio.current?.update(delta, 'menu');
    } else {
      audio.current?.setSuspended(false);
      audio.current?.update(delta);
    }

    // A menu is not a pause button that happens to be visible — the world genuinely stops.
    if (shell && shell.screen !== 'playing') {
      if (manager.pointerLocked) manager.releasePointerLock();
      manager.update(delta);
      manager.consumeLook(lookDelta.current);
      manager.endFrame();
      return;
    }

    manager.lookSensitivity = config.lookSensitivity;
    manager.update(delta);

    // Look is accumulated by the input layer and applied here, so a mouse delta and a thumbstick
    // rate end up in the same place by the time the camera reads them.
    const delta2 = manager.consumeLook(lookDelta.current);
    look.current.yaw += delta2.x;
    look.current.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, look.current.pitch + delta2.y));

    if (config.allowModeSwitch && manager.wasPressed('switchCamera')) {
      const mode: CameraMode = nextCameraMode(rig.current?.mode ?? config.cameraMode);
      rig.current?.reset?.();
      rig.current = createCameraRig(mode);
      setCameraMode(mode);
    }

    const move = manager.move;
    const moveInput = {
      forward: move.y,
      right: move.x,
      jump: manager.isDown('jump'),
      sprint: manager.isDown('sprint'),
      crouch: manager.isDown('crouch'),
      yaw: look.current.yaw,
    };

    // Timed separately because they answer different questions: the solver's cost scales with
    // bodies and contacts, gameplay's with how many things are thinking. Conflating them would
    // hide which one a future regression came from.
    const beforePhysics = performance.now();
    physics.step(delta, (step) => player.move(moveInput, step));
    const afterPhysics = performance.now();

    // The camera is where the player is looking, so it is where the shot comes from. Third person
    // and top-down included: aiming from the character while the view is behind them is what every
    // over-the-shoulder shooter does, and aiming from the camera itself would shoot through walls
    // the character is standing behind.
    camera.getWorldPosition(shotOrigin);
    camera.getWorldDirection(shotDirection);

    // Gameplay advances after physics, so enemies read positions the solver has already settled.
    runtime.current?.update(
      delta,
      {
        fire: manager.isDown('fire'),
        firePressed: manager.wasPressed('fire'),
        reload: manager.wasPressed('reload'),
        nextWeapon: manager.wasPressed('nextWeapon'),
        origin: shotOrigin,
        direction: shotDirection,
      },
      manager.sequenceKeys,
    );
    recordSimulationTiming(afterPhysics - beforePhysics, performance.now() - afterPhysics);

    // Health is pushed into the store only when it changes: mirroring it every frame would mean a
    // React render sixty times a second to display a number that moves once a second at most.
    const current = runtime.current?.playerHealth() ?? null;
    if (current !== health.current) {
      health.current = current;
      useEditorStore.getState().setPlayerHealth(current);
    }
    elapsed.current = runtime.current?.elapsedSeconds ?? elapsed.current + delta;
    if (current !== null) {
      shell?.setHud({
        health: current,
        maxHealth: scene.player.health,
        ammo: runtime.current?.inventory.ammo ?? null,
        timer: elapsed.current,
      });
    }

    // Co-op: send this player's intent, and draw everyone else where the server says they are.
    const net = coop.current;
    if (net) {
      net.update(delta, {
        forward: moveInput.forward,
        right: moveInput.right,
        jump: moveInput.jump,
        sprint: moveInput.sprint ?? false,
        crouch: moveInput.crouch ?? false,
        yaw: moveInput.yaw,
      });
      remotes.current?.sync(net.players, net.sessionId);
    }
    remotes.current?.update(delta);

    if (avatar.current) {
      avatar.current.update(player.position, look.current.yaw, player.crouched);
      avatar.current.node.visible = rig.current?.mode !== 'fps';
    }

    rig.current?.update(
      camera as THREE.PerspectiveCamera,
      {
        position: player.position,
        eyeHeight: player.eyeHeight,
        speed: player.speed,
        grounded: player.grounded,
      },
      look.current,
      delta,
      {
        fieldOfView: config.fieldOfView,
        distance: config.thirdPersonDistance,
        height: config.topDownHeight,
        headBob: config.headBob,
        probe: (from, direction, maxDistance) =>
          physics.castDistance(from, direction, maxDistance, player.colliderHandle),
      },
    );

    manager.endFrame();
  });

  return null;
}
