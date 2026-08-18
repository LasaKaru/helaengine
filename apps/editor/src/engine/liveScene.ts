import { hasProjectedUvs, type LoadedScene } from '@helaengine/engine';

/**
 * The scene the viewport has actually built, for panels that need to ask it something.
 *
 * Almost every panel edits the *document* and needs nothing else — the document is the truth, and a
 * panel reading the viewport would be reading a copy. The exception is a question the document
 * genuinely cannot answer: "what are the bones inside this model called". That lives in the `.glb`,
 * and the only place it has been read is the loader.
 *
 * Deliberately not `window.helaengine`. That is a debugging surface, and a shipped feature reaching
 * through it would make the editor depend on its own test harness — the same reasoning that put
 * `livePlayerPosition` in app code rather than leaving panels to call the dev API.
 */

let current: LoadedScene | null = null;

export function setLiveScene(loaded: LoadedScene | null): void {
  current = loaded;
}

/**
 * Bone names inside one placed object's model, or an empty list when it has no rig.
 *
 * Read from the scene graph rather than from the manifest, because the manifest does not carry them
 * — and adding them would mean re-ingesting every asset to answer a question the browser already
 * has the answer to.
 */
export function boneNamesFor(objectId: string): string[] {
  const node = current?.objects.get(objectId);
  if (!node) return [];

  const names: string[] = [];
  node.traverse((child) => {
    if ((child as { isBone?: boolean }).isBone) names.push(child.name);
  });
  return names;
}

/**
 * Whether a placed object's texture coordinates were invented by the engine's box projection.
 *
 * The same kind of question as the bone names: it lives in the geometry, and nothing in the document
 * or the manifest records it. It matters because a projected pattern stretches with a non-uniform
 * placement scale — an author who stretched a crate into a wall should be told why the bricks came
 * out oblong, rather than concluding the feature is broken.
 *
 * False for an object the viewport has not built, and for one with no surface: the projection only
 * runs when a surface is applied, so before that there is nothing to report.
 */
export function objectHasProjectedUvs(objectId: string): boolean {
  const node = current?.objects.get(objectId);
  if (!node) return false;
  return hasProjectedUvs(node);
}

/**
 * How much height this level's terrain has, in metres between its lowest and highest point.
 *
 * Another question the document cannot answer cheaply: the heightmap is a base64 blob in the
 * document and a decoded field in the viewport, and the viewport already has it. It decides whether
 * the panel says the occlusion test has nothing to hide anything behind — a flat field runs the
 * whole test, finds nothing, and looks exactly like a broken feature.
 */
export function liveTerrainRelief(): number {
  return current?.terrainRelief ?? 0;
}

/**
 * The lowest and highest ground in the level, or null where the viewport has built no terrain.
 *
 * Water's warnings need the absolute heights rather than the span: a surface under all the ground
 * shows nothing at all, and one over all of it drowns the level. Both read to an author as the
 * feature being broken rather than as their own number, which is exactly the case worth catching in
 * the panel rather than in the viewport.
 */
export function liveTerrainRange(): { lowest: number; highest: number } | null {
  return current?.terrainRange ?? null;
}
