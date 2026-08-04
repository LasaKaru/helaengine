import JSZip from 'jszip';
import type { ExportFile, ExportPlan } from '@helaengine/export';

/**
 * Packs an export plan into a zip, under a single top-level folder.
 *
 * The folder matters more than it looks. A zip that extracts its contents into whatever directory
 * somebody happened to be in is the archive equivalent of `rm` with a wildcard, and the convention
 * everyone expects is one folder named after the thing.
 */
export async function zipExport(plan: ExportPlan, folder: string): Promise<Blob> {
  const zip = new JSZip();
  const root = zip.folder(folder);
  if (!root) throw new Error(`could not create the "${folder}" folder in the archive`);

  for (const file of plan.files) addFile(root, file);

  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    // Level 6 rather than 9: the models are already Draco-compressed and the engine bundle is
    // minified, so the extra passes buy a percent or two for several seconds of the user's time.
    compressionOptions: { level: 6 },
  });
}

function addFile(root: JSZip, file: ExportFile): void {
  if (file.bytes) root.file(file.path, file.bytes, { binary: true });
  else root.file(file.path, file.text ?? '');
}

/** Hands the archive to the browser as a download. */
export function downloadZip(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next turn rather than immediately: some browsers have not finished reading the
  // blob when `click()` returns, and revoking early produces a zero-byte download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
