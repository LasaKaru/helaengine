/**
 * Three's `GLTFExporter` targets browsers, and its binary path uses `FileReader` to turn the
 * assembled `Blob` into an `ArrayBuffer`. Node has `Blob` but not `FileReader`, so this supplies
 * exactly the sliver of the API the exporter touches — `readAsArrayBuffer` plus `onloadend`.
 *
 * Import for side effects before importing GLTFExporter.
 */
interface MinimalFileReader {
  result: ArrayBuffer | null;
  onloadend: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  readAsArrayBuffer(blob: Blob): void;
}

if (typeof (globalThis as { FileReader?: unknown }).FileReader === 'undefined') {
  class NodeFileReader implements MinimalFileReader {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;

    readAsArrayBuffer(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((buffer) => {
          this.result = buffer;
          this.onloadend?.();
        })
        .catch((error: unknown) => {
          if (this.onerror) this.onerror(error);
          else throw error;
        });
    }
  }

  (globalThis as { FileReader?: unknown }).FileReader = NodeFileReader;
}

export {};
