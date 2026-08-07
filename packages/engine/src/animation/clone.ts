import type * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * Clones a model, correctly, whether or not it has a skeleton.
 *
 * `Object3D.clone(true)` copies the graph but **shares the `Skeleton`**, so every instance of a
 * rigged asset ends up driven by one set of bones. The symptom is unmistakable once you know it and
 * baffling before: place three enemies, and all three play whatever the last one was told to play,
 * usually at the position of the first. `SkeletonUtils.clone` rebuilds the bone graph and re-binds
 * each `SkinnedMesh` to its own copy.
 *
 * It is not used unconditionally, because it is materially more work than a plain clone and the
 * overwhelming majority of assets in a low-poly library are rocks. A scene with 200 trees should
 * not pay for a bone-remapping pass 200 times.
 *
 * Whether an asset is skinned is recorded in the manifest at ingest rather than detected here: the
 * loader has to know before it decides how to place the object, and traversing a model to find out
 * is work repeated per instance for an answer that cannot change.
 */
export function cloneModel(model: THREE.Object3D, skinned: boolean): THREE.Object3D {
  return skinned ? cloneSkinned(model) : model.clone(true);
}

/** Whether a loaded model actually contains a skinned mesh. Used at ingest, not per placement. */
export function hasSkeleton(model: THREE.Object3D): boolean {
  let found = false;
  model.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) found = true;
  });
  return found;
}
