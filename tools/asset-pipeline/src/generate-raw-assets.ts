/**
 * Generates the ten starter `.glb` sources in `raw-assets/`.
 *
 * These are stand-ins, not final art. Sprint 37 commissions real modelled assets; until then the
 * pipeline needs genuine GLB files to chew on, and stand-ins built in code are honest about what
 * they are and stay reproducible. They follow the same rules as hand-authored assets — metre
 * scale, +Y up, pivot at the base, flat shading, one material per colour — so nothing downstream
 * has to care where a GLB came from.
 *
 * Run with: pnpm --filter @helaengine/asset-pipeline generate-raw
 */
import './node-shims.js';

import fs from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { rawAssetsDir } from './paths.js';

type Part = { geometry: THREE.BufferGeometry; color: number };

/** Anchors a part so the asset's lowest point sits at y = 0 — the pivot rule from the conventions. */
function groundParts(parts: Part[]): void {
  const box = new THREE.Box3();
  const temp = new THREE.Box3();
  for (const part of parts) {
    part.geometry.computeBoundingBox();
    temp.copy(part.geometry.boundingBox!);
    box.union(temp);
  }
  const offsetY = -box.min.y;
  const offsetX = -(box.min.x + box.max.x) / 2;
  const offsetZ = -(box.min.z + box.max.z) / 2;
  for (const part of parts) {
    part.geometry.translate(offsetX, offsetY, offsetZ);
  }
}

function at(geometry: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  geometry.translate(x, y, z);
  return geometry;
}

const builders: Record<string, () => Part[]> = {
  tree_pine_01: () => [
    { geometry: at(new THREE.CylinderGeometry(0.16, 0.22, 1.4, 6), 0, 0.7, 0), color: 0x6b4a2f },
    { geometry: at(new THREE.ConeGeometry(1.05, 2.0, 7), 0, 2.0, 0), color: 0x2f6f3f },
    { geometry: at(new THREE.ConeGeometry(0.8, 1.7, 7), 0, 3.0, 0), color: 0x35784a },
    { geometry: at(new THREE.ConeGeometry(0.52, 1.3, 7), 0, 3.9, 0), color: 0x3d8452 },
  ],
  tree_pine_02: () => [
    { geometry: at(new THREE.CylinderGeometry(0.18, 0.26, 1.9, 6), 0, 0.95, 0), color: 0x63432b },
    { geometry: at(new THREE.ConeGeometry(1.25, 2.6, 7), 0, 2.6, 0), color: 0x27603a },
    { geometry: at(new THREE.ConeGeometry(0.92, 2.1, 7), 0, 4.0, 0), color: 0x2d6c42 },
    { geometry: at(new THREE.ConeGeometry(0.55, 1.5, 7), 0, 5.2, 0), color: 0x35784a },
  ],
  tree_oak_01: () => [
    { geometry: at(new THREE.CylinderGeometry(0.26, 0.36, 2.0, 7), 0, 1.0, 0), color: 0x71513a },
    { geometry: at(new THREE.IcosahedronGeometry(1.5, 0), 0, 3.4, 0), color: 0x4a8f45 },
    { geometry: at(new THREE.IcosahedronGeometry(1.0, 0), 0.95, 2.7, 0.5), color: 0x54994d },
    { geometry: at(new THREE.IcosahedronGeometry(0.85, 0), -0.9, 2.9, -0.4), color: 0x428240 },
  ],
  rock_boulder_01: () => {
    const base = new THREE.IcosahedronGeometry(1.0, 0);
    base.scale(1.15, 0.72, 0.95);
    return [
      { geometry: at(base, 0, 0.72, 0), color: 0x8a8880 },
      {
        geometry: at(new THREE.IcosahedronGeometry(0.42, 0), 0.75, 0.35, 0.42),
        color: 0x7d7b74,
      },
    ];
  },
  rock_shard_01: () => {
    const shard = new THREE.TetrahedronGeometry(0.55, 0);
    shard.rotateY(0.6);
    return [{ geometry: at(shard, 0, 0.4, 0), color: 0x767470 }];
  },
  building_hut_01: () => [
    { geometry: at(new THREE.BoxGeometry(4.2, 2.6, 4.2), 0, 1.3, 0), color: 0xb08a5a },
    { geometry: at(new THREE.ConeGeometry(3.6, 1.9, 4), 0, 3.55, 0), color: 0x7d5b34 },
    { geometry: at(new THREE.BoxGeometry(0.9, 1.7, 0.16), 0, 0.85, 2.12), color: 0x5e422a },
  ],
  enemy_goblin_01: () => [
    {
      geometry: at(new THREE.CylinderGeometry(0.11, 0.11, 0.62, 6), -0.16, 0.31, 0),
      color: 0x4a5a38,
    },
    {
      geometry: at(new THREE.CylinderGeometry(0.11, 0.11, 0.62, 6), 0.16, 0.31, 0),
      color: 0x4a5a38,
    },
    { geometry: at(new THREE.BoxGeometry(0.62, 0.66, 0.38), 0, 0.95, 0), color: 0xa83f3f },
    { geometry: at(new THREE.IcosahedronGeometry(0.29, 0), 0, 1.45, 0), color: 0x6f9152 },
    { geometry: at(new THREE.ConeGeometry(0.1, 0.28, 4), -0.3, 1.5, 0), color: 0x6f9152 },
    { geometry: at(new THREE.ConeGeometry(0.1, 0.28, 4), 0.3, 1.5, 0), color: 0x6f9152 },
  ],
  prop_barrel_01: () => [
    { geometry: at(new THREE.CylinderGeometry(0.42, 0.36, 0.92, 8), 0, 0.46, 0), color: 0x8a6238 },
    { geometry: at(new THREE.CylinderGeometry(0.44, 0.44, 0.1, 8), 0, 0.7, 0), color: 0x5b4a33 },
    { geometry: at(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 8), 0, 0.22, 0), color: 0x5b4a33 },
  ],
  prop_crate_01: () => [
    { geometry: at(new THREE.BoxGeometry(0.9, 0.9, 0.9), 0, 0.45, 0), color: 0x9a7845 },
    { geometry: at(new THREE.BoxGeometry(0.94, 0.12, 0.94), 0, 0.78, 0), color: 0x6f5531 },
  ],
  prop_fence_01: () => [
    { geometry: at(new THREE.BoxGeometry(0.14, 1.1, 0.14), -1.1, 0.55, 0), color: 0x6f5531 },
    { geometry: at(new THREE.BoxGeometry(0.14, 1.1, 0.14), 1.1, 0.55, 0), color: 0x6f5531 },
    { geometry: at(new THREE.BoxGeometry(2.3, 0.14, 0.08), 0, 0.85, 0), color: 0x8b6f4a },
    { geometry: at(new THREE.BoxGeometry(2.3, 0.14, 0.08), 0, 0.45, 0), color: 0x8b6f4a },
  ],
};

async function exportAsset(assetId: string, parts: Part[]): Promise<number> {
  groundParts(parts);

  const root = new THREE.Group();
  root.name = assetId;
  for (const [index, part] of parts.entries()) {
    // Flat shading is most of the low-poly look, and non-indexed geometry is what makes it flat.
    // Some primitives (IcosahedronGeometry, TetrahedronGeometry) arrive non-indexed already.
    const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry;
    geometry.computeVertexNormals();
    if (geometry !== part.geometry) part.geometry.dispose();

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: part.color,
        roughness: 0.9,
        metalness: 0,
        flatShading: true,
      }),
    );
    mesh.name = `${assetId}_part${index}`;
    root.add(mesh);
  }

  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    new GLTFExporter().parse(
      root,
      (result) => resolve(result as ArrayBuffer),
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
      { binary: true },
    );
  });

  await fs.writeFile(path.join(rawAssetsDir, `${assetId}.glb`), Buffer.from(buffer));
  return buffer.byteLength;
}

async function main(): Promise<void> {
  await fs.mkdir(rawAssetsDir, { recursive: true });

  console.log(`Generating ${Object.keys(builders).length} starter assets into ${rawAssetsDir}\n`);
  for (const [assetId, build] of Object.entries(builders)) {
    const bytes = await exportAsset(assetId, build());
    console.log(`  ${assetId.padEnd(20)} ${(bytes / 1024).toFixed(1).padStart(7)} KB`);
  }
  console.log('\nDone. Run `pnpm ingest-assets` to compress them and build the manifest.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
