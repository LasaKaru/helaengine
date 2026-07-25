/**
 * Ingest pipeline: raw `.glb` sources in, compressed GLBs + thumbnails + `manifest.json` out.
 *
 *   pnpm ingest-assets [sourceDir] [outputDir]
 *
 * Idempotent — re-run it whenever sources or metadata change. Everything it writes is generated
 * output; the raw `.glb` files are what live in version control.
 */
import './node-shims.js';

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { NodeIO, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, draco, prune, weld } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import {
  AssetManifestSchema,
  type AssetManifest,
  type AssetManifestEntry,
  type Vec3,
} from '@helaengine/schema';
import { checkPolyBudget } from './budgets.js';
import { metadataFile, outputDir as defaultOutputDir, rawAssetsDir } from './paths.js';
import { readAssetMetadata, type AssetMetadata } from './metadata.js';
import { ThumbnailRenderer } from './thumbnails.js';

interface IngestedAsset {
  entry: AssetManifestEntry;
  rawBytes: number;
  compressedBytes: number;
  warnings: string[];
}

async function createIO(): Promise<NodeIO> {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });
}

/** Measures triangle count and bounding size from the document, before compression. */
function measure(document: Document): {
  polyCount: number;
  bounds: Vec3;
} {
  let polyCount = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      const position = primitive.getAttribute('POSITION');
      const vertexCount = indices ? indices.getCount() : (position?.getCount() ?? 0);
      polyCount += Math.floor(vertexCount / 3);

      if (!position) continue;
      const primitiveMin = position.getMin([0, 0, 0]);
      const primitiveMax = position.getMax([0, 0, 0]);
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis]!, primitiveMin[axis]!);
        max[axis] = Math.max(max[axis]!, primitiveMax[axis]!);
      }
    }
  }

  const size = (axis: number): number =>
    Number.isFinite(min[axis]) && Number.isFinite(max[axis])
      ? Number((max[axis]! - min[axis]!).toFixed(4))
      : 1;

  return { polyCount, bounds: [size(0), size(1), size(2)] };
}

/** Flags source files that break the conventions in ways ingest cannot silently fix. */
function auditConventions(bounds: Vec3, minY: number): string[] {
  const warnings: string[] = [];
  if (Math.abs(minY) > 0.02) {
    warnings.push(
      `pivot is ${minY.toFixed(2)}m off the base — set the origin at the object's base in Blender`,
    );
  }
  if (bounds.every((value) => value < 0.05)) {
    warnings.push('asset is smaller than 5cm on every axis — check the export unit scale');
  }
  if (bounds.some((value) => value > 200)) {
    warnings.push('asset is over 200m on an axis — check the export unit scale');
  }
  return warnings;
}

function lowestPoint(document: Document): number {
  let minY = Infinity;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (position) minY = Math.min(minY, position.getMin([0, 0, 0])[1]!);
    }
  }
  return Number.isFinite(minY) ? minY : 0;
}

async function ingestOne(
  io: NodeIO,
  sourcePath: string,
  outputDir: string,
  metadata: AssetMetadata,
  thumbnails: ThumbnailRenderer | null,
): Promise<IngestedAsset> {
  const assetId = path.basename(sourcePath, '.glb');
  const warnings: string[] = [];

  const document = await io.read(sourcePath);
  const { polyCount, bounds } = measure(document);
  warnings.push(...auditConventions(bounds, lowestPoint(document)));

  const budget = checkPolyBudget(metadata.category, polyCount);
  if (budget.level === 'fail') {
    throw new Error(
      `${assetId}: ${polyCount} triangles is more than twice the ${metadata.category} budget of ${budget.budget}. Decimate the source or raise the budget deliberately.`,
    );
  }
  if (budget.level === 'warn') {
    warnings.push(
      `${polyCount} triangles exceeds the ${metadata.category} budget of ${budget.budget}`,
    );
  }

  // Order matters: clean up duplicate/unused data before compressing, so Draco never spends bits
  // encoding vertices that were redundant to begin with.
  await document.transform(
    dedup(),
    prune(),
    weld(),
    draco({ method: 'edgebreaker', quantizePosition: 14, quantizeNormal: 10 }),
  );

  const glbRelative = `models/${assetId}.glb`;
  const thumbnailRelative = `thumbnails/${assetId}.png`;
  const glbPath = path.join(outputDir, glbRelative);

  await fs.mkdir(path.dirname(glbPath), { recursive: true });
  const compressed = await io.writeBinary(document);
  await fs.writeFile(glbPath, compressed);

  let thumbnailPath: string | undefined;
  if (thumbnails) {
    await thumbnails.render(sourcePath, path.join(outputDir, thumbnailRelative));
    thumbnailPath = thumbnailRelative;
  }

  const rawBytes = (await fs.stat(sourcePath)).size;

  return {
    entry: {
      id: assetId,
      name: metadata.name,
      category: metadata.category,
      tags: metadata.tags,
      glbPath: glbRelative,
      ...(thumbnailPath ? { thumbnailPath } : {}),
      defaultScale: metadata.defaultScale,
      colliderType: metadata.colliderType,
      polyCount,
      bounds,
      placeholderColor: metadata.placeholderColor,
    },
    rawBytes,
    compressedBytes: compressed.byteLength,
    warnings,
  };
}

/**
 * Copies three.js's Draco decoder next to the models.
 *
 * Draco-compressed GLBs are undecodable without it, so it is part of the asset payload, not a
 * build-time dependency — the exporter (Sprint 13) will copy the same files into every bundle so
 * exports keep working offline, with no CDN in the loop.
 */
async function copyDracoDecoder(outputDir: string): Promise<void> {
  const require = createRequire(import.meta.url);
  const threeEntry = require.resolve('three');
  const decoderDir = path.join(path.dirname(threeEntry), '../examples/jsm/libs/draco');
  const target = path.join(outputDir, 'draco');

  await fs.mkdir(target, { recursive: true });
  for (const file of await fs.readdir(decoderDir)) {
    const source = path.join(decoderDir, file);
    if ((await fs.stat(source)).isFile()) {
      await fs.copyFile(source, path.join(target, file));
    }
  }
}

function reportKtx2Support(): void {
  console.log(
    'note: texture compression (KTX2/Basis) is skipped — `toktx` from KHRONOS KTX-Software is not\n' +
      '      on PATH. The starter assets are untextured, so this changes nothing today, but install\n' +
      '      it before ingesting textured assets. Geometry compression (Draco) is applied either way.',
  );
}

async function main(): Promise<void> {
  const [sourceArg, outputArg] = process.argv.slice(2);
  const sourceDir = sourceArg ? path.resolve(sourceArg) : rawAssetsDir;
  const outputDir = outputArg ? path.resolve(outputArg) : defaultOutputDir;

  const sources = (await fs.readdir(sourceDir).catch(() => [] as string[]))
    .filter((file) => file.toLowerCase().endsWith('.glb'))
    .sort();

  if (sources.length === 0) {
    console.error(`No .glb files found in ${sourceDir}.`);
    console.error('Run `pnpm generate-assets` first, or drop your own exports there.');
    process.exitCode = 1;
    return;
  }

  console.log(`Ingesting ${sources.length} assets`);
  console.log(`  from ${sourceDir}`);
  console.log(`  to   ${outputDir}\n`);
  reportKtx2Support();
  console.log();

  const metadataById = await readAssetMetadata(metadataFile);
  const io = await createIO();

  const skipThumbnails = process.env['SKIP_THUMBNAILS'] === '1';
  const thumbnails = skipThumbnails ? null : new ThumbnailRenderer({ size: 256 });
  await thumbnails?.open();

  const results: IngestedAsset[] = [];
  const allWarnings: string[] = [];

  try {
    for (const file of sources) {
      const assetId = path.basename(file, '.glb');
      const metadata = metadataById.get(assetId);
      if (!metadata.declared) {
        allWarnings.push(`${assetId}: no entry in asset-metadata.json — using defaults`);
      }

      const result = await ingestOne(
        io,
        path.join(sourceDir, file),
        outputDir,
        metadata,
        thumbnails,
      );
      results.push(result);
      allWarnings.push(...result.warnings.map((warning) => `${assetId}: ${warning}`));

      const saved = 1 - result.compressedBytes / result.rawBytes;
      console.log(
        `  ${assetId.padEnd(20)} ${String(result.entry.polyCount).padStart(5)} tris  ` +
          `${(result.rawBytes / 1024).toFixed(1).padStart(7)} KB -> ` +
          `${(result.compressedBytes / 1024).toFixed(1).padStart(7)} KB  ` +
          `(${(saved * 100).toFixed(0)}% smaller)`,
      );
    }
  } finally {
    await thumbnails?.close();
  }

  const manifest: AssetManifest = AssetManifestSchema.parse({
    version: 1,
    generatedAt: new Date().toISOString(),
    assets: results.map((result) => result.entry),
  });

  await copyDracoDecoder(outputDir);

  const manifestPath = path.join(outputDir, 'manifest.json');
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const rawTotal = results.reduce((sum, result) => sum + result.rawBytes, 0);
  const compressedTotal = results.reduce((sum, result) => sum + result.compressedBytes, 0);

  console.log(
    `\n${results.length} assets, ${(rawTotal / 1024).toFixed(1)} KB -> ` +
      `${(compressedTotal / 1024).toFixed(1)} KB ` +
      `(${((1 - compressedTotal / rawTotal) * 100).toFixed(0)}% smaller)`,
  );
  console.log(`Manifest written to ${manifestPath}`);

  if (allWarnings.length > 0) {
    console.warn(`\n${allWarnings.length} warning(s):`);
    for (const warning of allWarnings) console.warn(`  ! ${warning}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\nIngest failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
