import * as THREE from 'three';
import { MaterialOverrideSchema } from '@helaengine/schema';
import { describe, expect, it } from 'vitest';
import { applyMaterialOverride } from './materials.js';

/**
 * Material overrides, and specifically the sharing problem underneath them.
 *
 * A model is loaded once and cloned per placement, so its materials are shared across every copy —
 * deliberately, since that is why two hundred trees cost one material. Writing a colour onto the
 * material found on a clone therefore repaints every other tree in the level. The symptom is
 * unmistakable and the cause is not, so the first two tests below are about that and nothing else.
 */

function override(fields: Record<string, unknown>) {
  return MaterialOverrideSchema.parse(fields);
}

/** A model shaped the way a cloned GLB is: two meshes sharing one material. */
function sharedMaterialModel(): { root: THREE.Object3D; shared: THREE.MeshStandardMaterial } {
  const shared = new THREE.MeshStandardMaterial({ color: '#00ff00', roughness: 0.5 });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), shared));
  root.add(new THREE.Mesh(new THREE.SphereGeometry(), shared));
  return { root, shared };
}

function materialsOf(root: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const found: THREE.MeshStandardMaterial[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) found.push(mesh.material as THREE.MeshStandardMaterial);
  });
  return found;
}

describe('applyMaterialOverride', () => {
  it('leaves the shared material untouched', () => {
    const { root, shared } = sharedMaterialModel();
    applyMaterialOverride(root, override({ color: '#ff0000' }));

    // The bug this exists to prevent: recolour one crate and the crates at the far end of the map
    // change too, because they are all drawn with this object.
    expect(shared.color.getHexString()).toBe('00ff00');
    expect(materialsOf(root).every((material) => material !== shared)).toBe(true);
  });

  it('clones one material per source, not one per mesh', () => {
    const { root } = sharedMaterialModel();
    const created = applyMaterialOverride(root, override({ color: '#ff0000' }));

    // Two meshes, one source material, one clone. Cloning per mesh would multiply a model's
    // material count by its mesh count every time somebody changed a colour.
    expect(created).toHaveLength(1);
    const [first, second] = materialsOf(root);
    expect(first).toBe(second);
  });

  it('returns exactly what it created, so the caller can free it', () => {
    const { root } = sharedMaterialModel();
    const created = applyMaterialOverride(root, override({ color: '#ff0000' }));
    // Ownership is the caller's: `SceneLoader` already keeps the per-object disposal list, and a
    // second owner would be a second answer to who frees these.
    expect(created).toEqual(materialsOf(root).slice(0, 1));
  });

  it('changes only what the override names', () => {
    const { root } = sharedMaterialModel();
    applyMaterialOverride(root, override({ color: '#ff0000' }));

    const [material] = materialsOf(root);
    expect(material?.color.getHexString()).toBe('ff0000');
    // Untouched, and that is the difference between an override and a replacement: recolouring a
    // crate should not also flatten its roughness.
    expect(material?.roughness).toBe(0.5);
  });

  it('does nothing at all for an empty override', () => {
    const { root, shared } = sharedMaterialModel();
    const created = applyMaterialOverride(root, override({}));
    // No clone means no material to free and no extra draw state. An object whose override panel
    // was opened and closed should cost exactly what it did before.
    expect(created).toHaveLength(0);
    expect(materialsOf(root)[0]).toBe(shared);
  });

  it('turns transparency on when opacity is below one, and off at full', () => {
    const { root } = sharedMaterialModel();
    applyMaterialOverride(root, override({ opacity: 0.4 }));
    const [translucent] = materialsOf(root);
    // Setting opacity on an opaque material does nothing at all, and is the commonest "why is this
    // not working" in any engine that exposes the two separately.
    expect(translucent?.transparent).toBe(true);
    expect(translucent?.opacity).toBe(0.4);
    expect(translucent?.depthWrite).toBe(false);

    const opaque = sharedMaterialModel();
    applyMaterialOverride(opaque.root, override({ opacity: 1 }));
    // A transparent material is sorted every frame; staying opaque at full opacity is free.
    expect(materialsOf(opaque.root)[0]?.transparent).toBe(false);
  });

  it('renders both sides when asked', () => {
    const { root } = sharedMaterialModel();
    applyMaterialOverride(root, override({ doubleSided: true }));
    expect(materialsOf(root)[0]?.side).toBe(THREE.DoubleSide);
  });

  it('handles a mesh with an array of materials', () => {
    const a = new THREE.MeshStandardMaterial({ color: '#111111' });
    const b = new THREE.MeshStandardMaterial({ color: '#222222' });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), [a, b]));

    const created = applyMaterialOverride(root, override({ metalness: 0.9 }));
    expect(created).toHaveLength(2);
    expect(a.metalness).not.toBe(0.9);
    expect(
      created.every((material) => (material as THREE.MeshStandardMaterial).metalness === 0.9),
    ).toBe(true);
  });
});
