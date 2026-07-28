import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  buildScenePhysics,
  PhysicsWorld,
  type AssetResolver,
  type LoadedScene,
  type PlayerController,
} from '@helaengine/engine';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';
import { setLookHandler, setPlayer } from '../devApi';

/** Keys the preview reads, and what each one means. Deliberately WASD-only — this is a test walk. */
const KEY_BINDINGS: Record<string, keyof HeldKeys> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
};

interface HeldKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
}

const LOOK_SPEED = 0.0022;
/** Just short of straight up/down, so the view never flips through the pole. */
const MAX_PITCH = Math.PI / 2 - 0.05;

interface PhysicsPreviewProps {
  loadedScene: LoadedScene | null;
  resolver: AssetResolver;
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
export function PhysicsPreview({ loadedScene, resolver }: PhysicsPreviewProps): null {
  const walking = useEditorStore((state) => state.walking);
  const setWalking = useEditorStore((state) => state.setWalking);
  const setPhysicsStatus = useEditorStore((state) => state.setPhysicsStatus);

  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);

  const [world, setWorld] = useState<PhysicsWorld | null>(null);
  const controller = useRef<PlayerController | null>(null);
  const held = useRef<HeldKeys>({
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
  });
  const look = useRef({ yaw: 0, pitch: 0 });

  useEffect(() => {
    if (!walking || !loadedScene) return;

    // The document is read once, here, and not subscribed to.
    const scene = useSceneStore.getState().scene;
    let disposed = false;
    let built: PhysicsWorld | null = null;

    setPhysicsStatus('loading');

    void PhysicsWorld.create({ gravity: scene.player.gravity })
      .then((physics) => {
        if (disposed) {
          physics.dispose();
          return;
        }
        built = physics;

        const report = buildScenePhysics({ world: physics, scene, loaded: loadedScene, resolver });
        if (report.skipped.length > 0) {
          console.warn('[helaengine] objects without colliders:', report.skipped);
        }

        // Spawn on the ground rather than at the document's y, which is usually zero and would put
        // the player's feet inside a hill. Half a metre of clearance lets the controller settle.
        const [spawnX, spawnY, spawnZ] = scene.player.spawn;
        const ground = loadedScene.terrainField?.sampleHeight(spawnX, spawnZ) ?? 0;
        controller.current = physics.createPlayer(
          scene.player,
          new THREE.Vector3(spawnX, Math.max(spawnY, ground + 0.5), spawnZ),
        );
        setPlayer(controller.current);

        // Start looking the way the edit camera was, so entering the mode does not spin the view.
        const forward = camera.getWorldDirection(new THREE.Vector3());
        look.current.yaw = Math.atan2(-forward.x, -forward.z);
        look.current.pitch = 0;

        setLookHandler((yaw) => {
          look.current.yaw = yaw;
        });

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
      built?.dispose();
      setWorld(null);
      setPhysicsStatus(built ? 'ready' : 'idle');
      // Anything the solver moved goes back to where the document says it is.
      loadedScene.syncTransforms(useSceneStore.getState().scene);
    };
  }, [walking, loadedScene, resolver, camera, setPhysicsStatus, setWalking]);

  // Keyboard. Held state rather than events-per-frame: physics wants "is W down right now".
  useEffect(() => {
    if (!walking) return;

    const press =
      (down: boolean) =>
      (event: KeyboardEvent): void => {
        const binding = KEY_BINDINGS[event.code];
        if (!binding) return;
        // Space scrolls the page and arrows scroll the panels; neither is wanted mid-walk.
        event.preventDefault();
        held.current[binding] = down;
      };

    const keydown = press(true);
    const keyup = press(false);
    const blur = (): void => {
      // A tab switch mid-stride otherwise leaves the player walking forever.
      held.current = { forward: false, back: false, left: false, right: false, jump: false };
    };

    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
      blur();
    };
  }, [walking]);

  // Mouse look, through the pointer lock every first-person control scheme uses.
  useEffect(() => {
    if (!walking) return;

    const requestLock = (): void => {
      if (document.pointerLockElement !== domElement) void domElement.requestPointerLock?.();
    };
    const move = (event: MouseEvent): void => {
      if (document.pointerLockElement !== domElement) return;
      look.current.yaw -= event.movementX * LOOK_SPEED;
      look.current.pitch = Math.max(
        -MAX_PITCH,
        Math.min(MAX_PITCH, look.current.pitch - event.movementY * LOOK_SPEED),
      );
    };

    domElement.addEventListener('click', requestLock);
    document.addEventListener('mousemove', move);
    return () => {
      domElement.removeEventListener('click', requestLock);
      document.removeEventListener('mousemove', move);
      if (document.pointerLockElement === domElement) document.exitPointerLock();
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
    if (!physics || !player) return;

    const keys = held.current;
    const input = {
      forward: (keys.forward ? 1 : 0) - (keys.back ? 1 : 0),
      right: (keys.right ? 1 : 0) - (keys.left ? 1 : 0),
      jump: keys.jump,
      yaw: look.current.yaw,
    };

    physics.step(delta, (step) => player.move(input, step));

    camera.position.set(player.position.x, player.position.y + player.eyeHeight, player.position.z);
    camera.quaternion.setFromEuler(new THREE.Euler(look.current.pitch, look.current.yaw, 0, 'YXZ'));
  });

  return null;
}
