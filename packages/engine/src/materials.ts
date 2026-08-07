import * as THREE from 'three';
import { isEmptyOverride, type MaterialOverride } from '@helaengine/schema';

/**
 * Applies a scene document's material override to one placed object.
 *
 * **The materials are cloned first**, and that is the whole of the difficulty. A model loaded once
 * and cloned per placement shares its materials across every copy — that sharing is deliberate and
 * is why two hundred trees cost one material — so writing a colour onto the material found on a
 * clone repaints every other tree in the level. The symptom is unmistakable and the cause is not:
 * you recolour one crate, and the crates at the far end of the map change too.
 *
 * So an override means new materials for that object alone, and the caller has to free them when
 * the object goes. They are returned rather than tracked here: `SceneLoader` already owns the
 * per-object disposal list, and a second owner would be a second answer to "who frees this".
 */
export function applyMaterialOverride(
  root: THREE.Object3D,
  override: MaterialOverride,
): THREE.Material[] {
  if (isEmptyOverride(override)) return [];

  const created: THREE.Material[] = [];
  // One clone per source material, not per mesh: a model whose six meshes share one material
  // should still end up with one, or an override would multiply its material count by six.
  const clones = new Map<THREE.Material, THREE.Material>();

  const cloneOf = (source: THREE.Material): THREE.Material => {
    const existing = clones.get(source);
    if (existing) return existing;

    const clone = source.clone();
    tune(clone, override);
    clones.set(source, clone);
    created.push(clone);
    return clone;
  };

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Remembered before it is replaced, so clearing the override can put the model's own material
    // back rather than leaving a clone that merely looks like it. Stored on the mesh so it travels
    // with the node through pooling and recycling.
    mesh.userData[ORIGINAL_KEY] ??= mesh.material;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(cloneOf)
      : cloneOf(mesh.material);
  });

  return created;
}

/** Where a mesh's pre-override material is kept. */
const ORIGINAL_KEY = 'helaengineOriginalMaterial';

/**
 * Puts the model's own materials back.
 *
 * The counterpart to applying an override, and the reason the originals are remembered at all:
 * unticking a colour has to restore what the model shipped with. The clones are *not* freed here —
 * the scene owns them and frees them alongside the object, which keeps one answer to who disposes
 * what.
 */
export function restoreOriginalMaterials(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const original = mesh.userData[ORIGINAL_KEY] as THREE.Material | THREE.Material[] | undefined;
    if (!original) return;
    mesh.material = original;
    delete mesh.userData[ORIGINAL_KEY];
  });
}

/**
 * Writes the override onto one material.
 *
 * Every field is optional and an absent one is left alone — that is what makes this an override
 * rather than a replacement, and it is why recolouring a crate does not also flatten its
 * roughness.
 */
function tune(material: THREE.Material, override: MaterialOverride): void {
  const standard = material as THREE.MeshStandardMaterial;

  if (override.color !== undefined && standard.color) standard.color.set(override.color);
  if (override.roughness !== undefined) standard.roughness = override.roughness;
  if (override.metalness !== undefined) standard.metalness = override.metalness;
  if (override.emissive !== undefined && standard.emissive)
    standard.emissive.set(override.emissive);
  if (override.emissiveIntensity !== undefined) {
    standard.emissiveIntensity = override.emissiveIntensity;
  }

  if (override.opacity !== undefined) {
    material.opacity = override.opacity;
    // Switched on rather than left to the author, because an opacity below 1 on an opaque material
    // does nothing at all — the commonest "why is this not working" in any engine that exposes the
    // two separately. Left off at full opacity, since a transparent material is sorted per frame
    // and costs more than an opaque one.
    material.transparent = override.opacity < 1;
    material.depthWrite = override.opacity >= 1;
  }

  if (override.wireframe !== undefined) standard.wireframe = override.wireframe;
  if (override.doubleSided !== undefined) {
    material.side = override.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  }

  material.needsUpdate = true;
}
