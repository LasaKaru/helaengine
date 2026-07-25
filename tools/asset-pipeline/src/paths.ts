import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, '../../..');
export const pipelineRoot = path.resolve(here, '..');

/** Hand-authored `.glb` sources. These are the artefacts under version control. */
export const rawAssetsDir = path.join(repoRoot, 'raw-assets');

/**
 * Generated output. Not committed, and shared by every app that needs assets — the demo and the
 * editor both serve it through the same dev-server plugin rather than keeping private copies.
 */
export const outputDir = path.join(repoRoot, 'generated/assets');

export const metadataFile = path.join(here, 'asset-metadata.json');
