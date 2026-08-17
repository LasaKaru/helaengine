import * as THREE from 'three';
import { isEmptyOverride, type MaterialOverride } from '@helaengine/schema';
import type { SurfaceTextures } from './render/surfaces.js';

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
  /**
   * The scene's generated surface maps. Required rather than optional, because an optional one is a
   * caller that forgets it and a surface that silently does nothing — the failure this codebase has
   * been bitten by more than any other.
   */
  textures: SurfaceTextures,
): THREE.Material[] {
  if (isEmptyOverride(override)) return [];

  if (override.surface) ensureSurfaceUvs(root);

  const created: THREE.Material[] = [];
  // One clone per source material, not per mesh: a model whose six meshes share one material
  // should still end up with one, or an override would multiply its material count by six.
  const clones = new Map<THREE.Material, THREE.Material>();

  const cloneOf = (source: THREE.Material): THREE.Material => {
    const existing = clones.get(source);
    if (existing) return existing;

    const clone = source.clone();
    // Surface first, then the explicit fields. An author who has set a roughness has said what
    // *this* object is like; a surface says what brick is normally like. The other order would make
    // the roughness field silently stop working the moment somebody ticked a surface, which is the
    // exact shape of bug this codebase keeps being bitten by: the document is right and the pixels
    // ignore it.
    if (override.surface) applySurface(clone, override.surface, textures);
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

/**
 * Binds a generated surface's maps onto one material.
 *
 * The maps themselves are shared across every object asking for the same kind and scale — nothing
 * here writes to a texture, only to the material that samples it — so the clone this is called on
 * is the only thing that ends up owned per object.
 */
function applySurface(
  material: THREE.Material,
  surface: NonNullable<MaterialOverride['surface']>,
  textures: SurfaceTextures,
): void {
  const standard = material as THREE.MeshStandardMaterial;
  // A material with no `roughness` property is not a standard material — a `MeshBasicMaterial` on a
  // trigger volume, say — and binding PBR maps to it would do nothing while costing the samplers.
  if (standard.roughness === undefined) return;

  const maps = textures.get(surface.kind, surface.scale);

  standard.normalMap = maps.normalMap;
  // The map is generated at one strength and scaled here, so `depth` is free to change: no texture
  // is regenerated and nothing is re-uploaded, which is what makes the slider usable at all.
  standard.normalScale = new THREE.Vector2(surface.depth, surface.depth);

  standard.roughnessMap = maps.ormMap;
  standard.metalnessMap = maps.ormMap;
  standard.aoMap = maps.ormMap;
  standard.aoMapIntensity = surface.occlusion;

  // Three *multiplies* the map by the scalar. A model that shipped with `roughness: 0` — which the
  // generated starter assets do — would cancel the map entirely and shade as a mirror with a brick
  // pattern that does nothing, so the scalars go to 1 and the map becomes the value. The kind's own
  // roughness and metalness are already baked into the map's green and blue channels.
  standard.roughness = 1;
  standard.metalness = 1;
}

/**
 * Makes sure every mesh under the root can sample a surface's maps.
 *
 * Two problems, and both were found by a browser rather than by reasoning.
 *
 * **No texture coordinates at all.** The generated starter models — and plenty of hand-made
 * low-poly props — carry no `uv` attribute, because nothing had ever textured them. A material with
 * a normal map and no UVs does not fail: the attribute defaults to zero, every fragment samples the
 * same texel, and the wall comes out uniformly tinted by one arbitrary pixel of a brick. It looked
 * like the surface was working, right up until changing the scale from fine to coarse produced a
 * byte-identical frame. So a projection is generated where one is missing.
 *
 * **No second UV set.** Three reads `aoMap` from `uv1`, a glTF convention inherited from when
 * lightmaps had their own unwrap. A model out of Blender almost never has one, so without this the
 * occlusion map binds successfully, samples nothing and contributes nothing — no warning, the
 * creases simply are not dark.
 *
 * Both are written to the *shared* geometry rather than a copy, deliberately: each is a pure
 * function of that geometry, so every clone would compute the same values, and a per-object copy of
 * every vertex buffer is a far worse trade than one extra attribute.
 */
function ensureSurfaceUvs(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    if (!geometry.getAttribute('uv')) boxProject(geometry);
    if (!geometry.getAttribute('uv1')) {
      const uv = geometry.getAttribute('uv');
      if (uv) geometry.setAttribute('uv1', uv);
    }
  });
}

/** Marks a geometry whose UVs this engine invented, so the editor can say so. */
const PROJECTED_KEY = 'helaengineProjectedUvs';

/**
 * Generates texture coordinates by projecting each face down its dominant axis.
 *
 * A box projection rather than a real unwrap, and the choice is not close. A seam-minimising unwrap
 * is a research problem; a box projection is nine lines, has no seams *within* a face, and is
 * exactly right for the shapes this engine is full of — walls, crates, floors, kerbs. On a sphere it
 * is visibly wrong, which is why the panel says when it has been used.
 *
 * The units are metres of the geometry's own space, so a brick is the same size on a small crate and
 * a large one. What it cannot know about is the placement's scale: a wall stretched to six metres
 * wide stretches its bricks with it, because the geometry is shared with every other placement and
 * cannot carry one placement's transform.
 */
function boxProject(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position');
  if (!position) return;
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const normal = geometry.getAttribute('normal');
  if (!normal) return;

  const uv = new Float32Array(position.count * 2);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const nx = Math.abs(normal.getX(vertex));
    const ny = Math.abs(normal.getY(vertex));
    const nz = Math.abs(normal.getZ(vertex));
    const x = position.getX(vertex);
    const y = position.getY(vertex);
    const z = position.getZ(vertex);

    // The dominant axis is the one the face most faces; projecting down it is the only choice that
    // does not squash the face to a line.
    if (nx >= ny && nx >= nz) {
      uv[vertex * 2] = z;
      uv[vertex * 2 + 1] = y;
    } else if (ny >= nx && ny >= nz) {
      uv[vertex * 2] = x;
      uv[vertex * 2 + 1] = z;
    } else {
      uv[vertex * 2] = x;
      uv[vertex * 2 + 1] = y;
    }
  }

  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.userData[PROJECTED_KEY] = true;
}

/**
 * Whether this object's texture coordinates were invented by the projection above.
 *
 * Reported to the editor rather than inferred, because the consequence is real and specific: a
 * projected pattern stretches with a non-uniform placement scale, and an author who stretched a
 * crate into a wall deserves to be told why the bricks came out oblong.
 */
export function hasProjectedUvs(root: THREE.Object3D): boolean {
  let projected = false;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry.userData[PROJECTED_KEY] === true) projected = true;
  });
  return projected;
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
