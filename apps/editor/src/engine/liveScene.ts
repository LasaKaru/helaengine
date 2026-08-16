import type { LoadedScene } from '@helaengine/engine';

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
