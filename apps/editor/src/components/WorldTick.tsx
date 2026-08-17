import { useFrame } from '@react-three/fiber';
import type { LoadedScene } from '@helaengine/engine';
import { setParticleCount } from '../devApi';

/**
 * Advances the loaded scene's own clocks each frame.
 *
 * The engine ticks these inside `Viewport`, which is its own render loop and is what an exported
 * game runs. The editor does not use `Viewport` — it renders through react-three-fiber — so nothing
 * here was calling them at all. A swaying plant stood still while you built the level around it and
 * only came alive in the export, which is the worst way to find out a feature works.
 *
 * Deliberately not inside `EngineBridge`: that component is effects over the document and has no
 * frame loop, and giving it one would mean it re-rendered sixty times a second.
 *
 * This does not double up with `BehaviorPreview`. That ticks the *game runtime* — behaviours, AI,
 * triggers — which is a different clock; the runtime never advances animation or wind itself, for
 * exactly the reason above.
 */
export function WorldTick({ loaded }: { loaded: LoadedScene | null }): null {
  useFrame((state, delta) => {
    if (!loaded) return;
    // Each is a no-op when the scene has nothing that needs it, so a level with no rigs, no wind
    // and no particles pays three null checks a frame.
    loaded.updateAnimations(delta);
    // After the clips, never before: the mixer would overwrite a placed foot on the same frame.
    loaded.updateFootPlacement(delta);
    loaded.updateWind(delta);
    // The camera goes in because weather is a box that follows it: a finite number of drops looks
    // infinite only because the player carries their own weather around.
    loaded.updateParticles(delta, state.camera);
    setParticleCount(loaded.particleCount);
  });

  return null;
}
