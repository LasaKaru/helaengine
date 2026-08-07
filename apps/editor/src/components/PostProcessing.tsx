import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { PostStack, applyToneMapping, wantsPostProcessing } from '@helaengine/engine';
import { useSceneStore } from '../store/sceneStore';
import { setPostProcessingActive } from '../devApi';

/**
 * Runs the engine's post-processing stack inside the editor's viewport.
 *
 * The editor draws through react-three-fiber and an export draws through the engine's own
 * `Viewport`, so wiring effects into only one of them would mean **authoring a look you cannot
 * see** — bloom in the game and none in the editor, which is the editor/export divergence the
 * visual-regression suite exists to catch and the last thing to introduce deliberately.
 *
 * So it is the same `PostStack`: same passes, same shader, same order. r3f is asked to stop
 * rendering and this takes over, which is what a priority above zero means to `useFrame`. The
 * alternative — `@react-three/postprocessing` here and Three's passes in the export — would be two
 * implementations of the same feature that have to be kept in step by hand, and they would drift
 * on the third change.
 */
export function PostProcessing(): null {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const setFrameloop = useThree((state) => state.setFrameloop);

  const environment = useSceneStore((state) => state.scene.environment);
  const stack = useRef<PostStack | null>(null);

  // Tone mapping and exposure are the renderer's, not a pass's: Three applies them while shading a
  // material, so doing it afterwards would work on colours already clipped to the display range —
  // which is the thing tone mapping exists to avoid.
  useEffect(() => {
    applyToneMapping(gl, environment);
  }, [gl, environment]);

  useEffect(() => {
    if (!wantsPostProcessing(environment.postProcessing)) {
      stack.current?.dispose();
      stack.current = null;
      setPostProcessingActive(false);
      return;
    }

    stack.current?.dispose();
    stack.current = new PostStack(gl, scene, camera, environment.postProcessing, {
      width: size.width,
      height: size.height,
    });
    setPostProcessingActive(true);

    return () => {
      stack.current?.dispose();
      stack.current = null;
      setPostProcessingActive(false);
    };
    // `size` deliberately absent: a resize is handled below without rebuilding the whole chain,
    // and rebuilding it on every pixel of a window drag would allocate a render target per frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, environment.postProcessing, setFrameloop]);

  useEffect(() => {
    stack.current?.setSize(size.width, size.height);
  }, [size.width, size.height]);

  // Priority 1 takes rendering away from r3f. Without it both draw, and the plain render lands on
  // the canvas after the composed one — so the effects appear to do nothing at all.
  useFrame((_state, delta) => {
    if (stack.current) stack.current.render(delta);
    else gl.render(scene, camera);
  }, 1);

  return null;
}
