import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { pickTerrain, type LoadedScene } from '@helaengine/engine';
import { useEditorStore } from '../store/editorStore';

/**
 * Right-click the ground to start playing from there.
 *
 * The loop this removes is the whole justification: testing the far corner of a level otherwise
 * means walking there from the spawn point, every single time you change something. Unreal calls it
 * Play From Here and it is the single biggest difference between a level that gets iterated on and
 * one that gets built once and shipped.
 *
 * The point is **editor state, not document state**. Trying a spot must not move the spawn point
 * somebody has already placed — an author who tests the boss room twenty times has not decided the
 * game should start there.
 *
 * Rendered inside the canvas so it can raycast, but its menu is DOM, because a floating menu drawn
 * in WebGL is a menu that cannot be read by a screen reader or dismissed with Escape.
 */

export function PlayFromHere({ loadedScene }: { loadedScene: LoadedScene | null }): null {
  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  const walking = useEditorStore((state) => state.walking);
  // The menu lives outside the canvas, so this hands it a point through the store rather than
  // rendering it. See `PlayFromHereMenu` below.
  const setMenu = useEditorStore((state) => state.setPlayFromMenu);

  useEffect(() => {
    if (walking || !loadedScene) return;

    const toNdc = (event: PointerEvent): THREE.Vector2 => {
      const bounds = domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
    };

    const onContextMenu = (event: MouseEvent): void => {
      const pointer = event as PointerEvent;
      raycaster.setFromCamera(toNdc(pointer), camera);
      const hit = pickTerrain(raycaster, loadedScene);
      if (!hit) {
        setMenu(null);
        return;
      }

      // The browser menu would cover ours, and right-drag is not an orbit gesture here.
      event.preventDefault();
      setMenu({
        // Lifted half a metre so the capsule is not spawned intersecting the ground it was aimed
        // at — the same correction the normal spawn path makes.
        point: [hit.point.x, hit.point.y + 0.5, hit.point.z],
        clientX: pointer.clientX,
        clientY: pointer.clientY,
      });
    };

    domElement.addEventListener('contextmenu', onContextMenu);
    return () => domElement.removeEventListener('contextmenu', onContextMenu);
  }, [walking, loadedScene, camera, domElement, raycaster, setMenu]);

  return null;
}

/**
 * The menu itself, in the DOM.
 *
 * Separate component because it must not be inside the react-three-fiber canvas: r3f's reconciler
 * builds three.js objects, not elements, so a `<button>` there is not a button.
 */
export function PlayFromHereMenu(): React.JSX.Element | null {
  const menu = useEditorStore((state) => state.playFromMenu);
  const setMenu = useEditorStore((state) => state.setPlayFromMenu);
  const setPlayFrom = useEditorStore((state) => state.setPlayFrom);
  const setWalking = useEditorStore((state) => state.setWalking);

  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [menu, setMenu]);

  if (!menu) return null;

  const start = (): void => {
    // Order matters: the spawn override has to be in the store before the preview reads it, and
    // `setWalking` is what starts the run.
    setPlayFrom(menu.point);
    setMenu(null);
    setWalking(true);
  };

  return (
    <>
      {/* Swallows the next click anywhere, so the menu closes the way every menu does. */}
      <div className="play-here-backdrop" onPointerDown={() => setMenu(null)} />
      <div
        className="play-here-menu"
        role="menu"
        aria-label="Viewport actions"
        style={{ left: menu.clientX, top: menu.clientY }}
      >
        <button type="button" role="menuitem" onClick={start}>
          Play from here
        </button>
        <p className="play-here-hint">
          {menu.point.map((part) => part.toFixed(1)).join(', ')} · does not move the spawn point
        </p>
      </div>
    </>
  );
}
