import { THREE, hasSkeleton } from '@helaengine/engine';
import type { AssetManifestEntry } from '@helaengine/schema';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { ASSET_BASE_URL } from '../engine/assetLibrary';

/**
 * Measures a model the author just handed us.
 *
 * The ingest pipeline does this in Node for the shipped library; this is the same job in the
 * browser, for a file that never goes near a server. It matters that it is done **at import** and
 * kept: the editor needs the polygon count, the bounds, the clip names and whether the model is
 * skinned *before* it loads the model — for the placeholder box, the batching decision, the budget
 * warning and the inspector's animation dropdowns. Deriving them on demand would mean decoding
 * every custom model on every page load.
 *
 * It is also the honest gate. A file that cannot be parsed here cannot be drawn later, and finding
 * that out at import — with the filename in the message — is much kinder than a grey box in a level
 * three days later.
 */

export interface ModelReport {
  polyCount: number;
  bounds: [number, number, number];
  /** Distance from the model's origin to its lowest point. Negative means the pivot floats. */
  baseOffset: number;
  animations: string[];
  skinned: boolean;
  /**
   * Which PBR maps the file's own materials carry.
   *
   * Measured here for the same reason everything else is: the editor has to warn before a generated
   * surface replaces a normal map the author made, and decoding every custom model on every page
   * load to find out is not a trade worth making.
   */
  materialMaps: AssetManifestEntry['materialMaps'];
  /**
   * A suggested uniform scale, or null when the model is already in metres.
   *
   * Models exported from Blender in centimetres — which is every Mixamo character — arrive a
   * hundred times too big, and the first thing somebody places is a skyscraper. Rather than
   * silently rescaling, this reports a suggestion the import dialog can offer.
   */
  suggestedScale: number | null;
}

export class ModelInspectionError extends Error {}

/** Above this, in any axis, a model is almost certainly authored in centimetres. */
const CENTIMETRE_THRESHOLD = 40;

/**
 * The decoder for Draco-compressed input.
 *
 * Shared and created lazily: it spins up a worker, and doing that once per imported file would
 * leak one per import. A user's own export from Blender is usually uncompressed, but "usually" is
 * not "always" — and a model that failed to parse because the decoder was absent would look
 * exactly like a corrupt file.
 */
let dracoLoader: DRACOLoader | null = null;

function loader(): GLTFLoader {
  dracoLoader ??= new DRACOLoader().setDecoderPath(`${ASSET_BASE_URL}draco/`);
  return new GLTFLoader().setDRACOLoader(dracoLoader);
}

export async function inspectModel(bytes: ArrayBuffer, filename: string): Promise<ModelReport> {
  let gltf;
  try {
    gltf = await loader().parseAsync(bytes, '');
  } catch (error) {
    throw new ModelInspectionError(
      `${filename} could not be read as a glTF model (${(error as Error).message}). ` +
        'It must be a .glb or .gltf file — exporting from Blender as "glTF 2.0 (.glb)" produces one.',
    );
  }

  const model = gltf.scene;
  let polyCount = 0;
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const index = mesh.geometry.getIndex();
    const position = mesh.geometry.getAttribute('position');
    // Indexed geometry counts its index buffer; a non-indexed one counts its vertices. Reading
    // only `position` would report three times too many triangles for the indexed case, which is
    // most of them.
    polyCount += Math.floor((index ? index.count : (position?.count ?? 0)) / 3);
  });

  if (polyCount === 0) {
    throw new ModelInspectionError(
      `${filename} contains no geometry. It parsed as a glTF file, but there is nothing in it to draw.`,
    );
  }

  // Three has already turned the glTF's texture references into material properties by this point,
  // so this is read from the materials rather than from the file — the same measurement the Node
  // ingest makes from the document, arrived at from the other end.
  const found = new Set<AssetManifestEntry['materialMaps'][number]>();
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const standard = material as THREE.MeshStandardMaterial;
      if (standard.map) found.add('baseColor');
      if (standard.normalMap) found.add('normal');
      // glTF packs roughness and metalness into one texture, so either property means the file
      // carried the one map that feeds both.
      if (standard.roughnessMap ?? standard.metalnessMap) found.add('metallicRoughness');
      if (standard.aoMap) found.add('occlusion');
      if (standard.emissiveMap) found.add('emissive');
    }
  });

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const bounds: [number, number, number] = [
    Number(size.x.toFixed(4)),
    Number(size.y.toFixed(4)),
    Number(size.z.toFixed(4)),
  ];

  const largest = Math.max(size.x, size.y, size.z);
  const suggestedScale = largest > CENTIMETRE_THRESHOLD ? 0.01 : null;

  return {
    polyCount,
    bounds,
    baseOffset: Number(box.min.y.toFixed(4)),
    animations: gltf.animations.map((clip) => clip.name).filter((name) => name.length > 0),
    skinned: hasSkeleton(model),
    // Sorted so two imports of the same file produce the same row.
    materialMaps: [...found].sort(),
    suggestedScale,
  };
}

/** Frees the shared Draco worker. Called when the editor tears down. */
export function disposeModelInspector(): void {
  dracoLoader?.dispose();
  dracoLoader = null;
}
