import * as THREE from 'three';
import { MaterialOverrideSchema } from '@helaengine/schema';
import { describe, expect, it } from 'vitest';
import { applyMaterialOverride, hasProjectedUvs } from './materials.js';
import { SurfaceTextures } from './render/surfaces.js';

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

/** The scene's generated surface maps. Empty until an override actually asks for a surface. */
const surfaces = new SurfaceTextures();

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
    applyMaterialOverride(root, override({ color: '#ff0000' }), surfaces);

    // The bug this exists to prevent: recolour one crate and the crates at the far end of the map
    // change too, because they are all drawn with this object.
    expect(shared.color.getHexString()).toBe('00ff00');
    expect(materialsOf(root).every((material) => material !== shared)).toBe(true);
  });

  it('clones one material per source, not one per mesh', () => {
    const { root } = sharedMaterialModel();
    const created = applyMaterialOverride(root, override({ color: '#ff0000' }), surfaces);

    // Two meshes, one source material, one clone. Cloning per mesh would multiply a model's
    // material count by its mesh count every time somebody changed a colour.
    expect(created).toHaveLength(1);
    const [first, second] = materialsOf(root);
    expect(first).toBe(second);
  });

  it('returns exactly what it created, so the caller can free it', () => {
    const { root } = sharedMaterialModel();
    const created = applyMaterialOverride(root, override({ color: '#ff0000' }), surfaces);
    // Ownership is the caller's: `SceneLoader` already keeps the per-object disposal list, and a
    // second owner would be a second answer to who frees these.
    expect(created).toEqual(materialsOf(root).slice(0, 1));
  });

  it('changes only what the override names', () => {
    const { root } = sharedMaterialModel();
    applyMaterialOverride(root, override({ color: '#ff0000' }), surfaces);

    const [material] = materialsOf(root);
    expect(material?.color.getHexString()).toBe('ff0000');
    // Untouched, and that is the difference between an override and a replacement: recolouring a
    // crate should not also flatten its roughness.
    expect(material?.roughness).toBe(0.5);
  });

  it('does nothing at all for an empty override', () => {
    const { root, shared } = sharedMaterialModel();
    const created = applyMaterialOverride(root, override({}), surfaces);
    // No clone means no material to free and no extra draw state. An object whose override panel
    // was opened and closed should cost exactly what it did before.
    expect(created).toHaveLength(0);
    expect(materialsOf(root)[0]).toBe(shared);
  });

  it('turns transparency on when opacity is below one, and off at full', () => {
    const { root } = sharedMaterialModel();
    applyMaterialOverride(root, override({ opacity: 0.4 }), surfaces);
    const [translucent] = materialsOf(root);
    // Setting opacity on an opaque material does nothing at all, and is the commonest "why is this
    // not working" in any engine that exposes the two separately.
    expect(translucent?.transparent).toBe(true);
    expect(translucent?.opacity).toBe(0.4);
    expect(translucent?.depthWrite).toBe(false);

    const opaque = sharedMaterialModel();
    applyMaterialOverride(opaque.root, override({ opacity: 1 }), surfaces);
    // A transparent material is sorted every frame; staying opaque at full opacity is free.
    expect(materialsOf(opaque.root)[0]?.transparent).toBe(false);
  });

  it('renders both sides when asked', () => {
    const { root } = sharedMaterialModel();
    applyMaterialOverride(root, override({ doubleSided: true }), surfaces);
    expect(materialsOf(root)[0]?.side).toBe(THREE.DoubleSide);
  });

  it('binds a surface as normal, roughness, metalness and occlusion maps', () => {
    const { root } = sharedMaterialModel();
    applyMaterialOverride(root, override({ surface: { kind: 'brick' } }), surfaces);

    const [material] = materialsOf(root);
    expect(material?.normalMap).not.toBeNull();
    expect(material?.aoMap).not.toBeNull();
    // One texture serving three channels: occlusion in red, roughness in green, metalness in blue.
    // Binding three separate maps would be three uploads and three sampler fetches for one pattern.
    expect(material?.roughnessMap).toBe(material?.metalnessMap);
    expect(material?.aoMap).toBe(material?.roughnessMap);
  });

  it('leaves the scalars at one so the maps are not cancelled', () => {
    // Three *multiplies* the map by the scalar. The starter models ship `roughness: 0`, so a surface
    // that left the scalar alone would bind four correct maps onto a material that shades as a
    // mirror — every byte right, nothing visible.
    const mirror = new THREE.MeshStandardMaterial({ roughness: 0, metalness: 0 });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), mirror));

    applyMaterialOverride(root, override({ surface: { kind: 'stone' } }), surfaces);
    expect(materialsOf(root)[0]?.roughness).toBe(1);
    expect(materialsOf(root)[0]?.metalness).toBe(1);
  });

  it('lets an explicit roughness win over the surface preset', () => {
    // A surface says what brick is normally like; a number says what *this* brick is like. The other
    // order would make the roughness field silently stop working the moment a surface was ticked.
    const { root } = sharedMaterialModel();
    applyMaterialOverride(
      root,
      override({ surface: { kind: 'metal' }, roughness: 0.11 }),
      surfaces,
    );
    expect(materialsOf(root)[0]?.roughness).toBe(0.11);
  });

  it('scales the normal map by the depth, and flattens it at zero', () => {
    const { root } = sharedMaterialModel();
    applyMaterialOverride(root, override({ surface: { kind: 'tile', depth: 0 } }), surfaces);
    // Still bound — the roughness pattern is the point of a glazed tile — but the light comes off it
    // as though the surface were smooth.
    expect(materialsOf(root)[0]?.normalMap).not.toBeNull();
    expect(materialsOf(root)[0]?.normalScale.x).toBe(0);
  });

  it('gives the geometry the second UV set the occlusion map reads', () => {
    /**
     * Three reads `aoMap` from `uv1`, not `uv`. A model out of Blender almost never has one, so
     * without this the map binds successfully, samples an attribute that does not exist and
     * contributes nothing at all — no warning, the creases simply are not dark.
     */
    const { root } = sharedMaterialModel();
    const geometry = (root.children[0] as THREE.Mesh).geometry;
    expect(geometry.getAttribute('uv1')).toBeUndefined();

    applyMaterialOverride(root, override({ surface: { kind: 'plank' } }), surfaces);
    expect(geometry.getAttribute('uv1')).toBe(geometry.getAttribute('uv'));
  });

  it('projects texture coordinates onto a model that has none', () => {
    /**
     * Found in a browser, and it is the reason the browser test exists. A material with maps and no
     * `uv` attribute does not fail — every fragment samples texel zero, and the wall comes out
     * uniformly tinted by one arbitrary pixel of a brick. It looks like the surface working, until
     * changing the scale from fine to coarse renders a byte-identical frame.
     */
    const bare = new THREE.BoxGeometry(2, 2, 2);
    bare.deleteAttribute('uv');
    const root = new THREE.Group();
    root.add(new THREE.Mesh(bare, new THREE.MeshStandardMaterial()));

    applyMaterialOverride(root, override({ surface: { kind: 'brick' } }), surfaces);

    const uv = bare.getAttribute('uv');
    expect(uv).toBeDefined();
    // Metres of the geometry's own space, so a brick is the same size on a small crate and a large
    // one: a 2m box spans two units of UV, not one.
    let span = 0;
    for (let vertex = 0; vertex < uv!.count; vertex += 1) span = Math.max(span, uv!.getX(vertex));
    expect(span).toBeCloseTo(1, 5);
    expect(hasProjectedUvs(root)).toBe(true);
  });

  it('leaves a model with its own texture coordinates alone', () => {
    // The control. Overwriting an artist's unwrap with a box projection would be a far worse bug
    // than the one the projection fixes.
    const { root } = sharedMaterialModel();
    const geometry = (root.children[0] as THREE.Mesh).geometry;
    const authored = geometry.getAttribute('uv');

    applyMaterialOverride(root, override({ surface: { kind: 'brick' } }), surfaces);
    expect(geometry.getAttribute('uv')).toBe(authored);
    expect(hasProjectedUvs(root)).toBe(false);
  });

  it('leaves a non-standard material alone', () => {
    // A trigger volume's basic material has no PBR shading at all, so binding maps to it would cost
    // four samplers to change nothing.
    const basic = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), basic));

    const created = applyMaterialOverride(root, override({ surface: { kind: 'brick' } }), surfaces);
    expect((created[0] as THREE.MeshStandardMaterial).normalMap).toBeUndefined();
  });

  it('handles a mesh with an array of materials', () => {
    const a = new THREE.MeshStandardMaterial({ color: '#111111' });
    const b = new THREE.MeshStandardMaterial({ color: '#222222' });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), [a, b]));

    const created = applyMaterialOverride(root, override({ metalness: 0.9 }), surfaces);
    expect(created).toHaveLength(2);
    expect(a.metalness).not.toBe(0.9);
    expect(
      created.every((material) => (material as THREE.MeshStandardMaterial).metalness === 0.9),
    ).toBe(true);
  });
});
