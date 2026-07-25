import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, '../../..');
export const pipelineRoot = path.resolve(here, '..');

/** Hand-authored `.glb` sources. These are the artefacts under version control. */
export const rawAssetsDir = path.join(repoRoot, 'raw-assets');

/** Generated output, served by the demo app. Not committed. */
export const outputDir = path.join(repoRoot, 'apps/demo/public/assets');

export const metadataFile = path.join(here, 'asset-metadata.json');
