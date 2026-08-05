import { HELA_EXTENSION, HELA_MIME, suggestedFilename } from '@helaengine/hela-file';

/**
 * Putting a `.hela` on the user's own disk, and getting one back.
 *
 * Two paths, because the browsers disagree. Chromium has the **File System Access API**, which
 * hands back a *handle* — so "Save" after the first "Save As" writes to the same file the user
 * chose, exactly as a desktop application does. Firefox and Safari have neither, so they get a
 * download and a file input: still a real file on disk, just without the editor remembering where
 * it went.
 *
 * That difference is worth carrying rather than levelling down to the lowest common denominator.
 * A tool that re-downloads `MyLevel (3).hela` every time you press Ctrl+S is a tool people stop
 * using the file feature of, and the handle is what makes a `.hela` in a Drive folder or a git
 * working copy actually workable — you save over the same path, and Drive syncs or git sees a diff.
 */

/**
 * The subset of the File System Access API this uses.
 *
 * Declared rather than pulled from a DOM lib, because the ambient types are still not in every
 * TypeScript DOM release and a feature this optional should not gate the build on one.
 */
interface FileSystemWritable {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
}

export interface HelaFileHandle {
  readonly name: string;
  createWritable(): Promise<FileSystemWritable>;
  getFile(): Promise<File>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface FilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<HelaFileHandle>;
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<HelaFileHandle[]>;
}

const PICKER_TYPES = [
  { description: 'HelaEngine project', accept: { [HELA_MIME]: [HELA_EXTENSION] } },
];

function picker(): FilePickerWindow {
  return window as unknown as FilePickerWindow;
}

/** Whether this browser can remember where a file was saved. */
export function supportsFileHandles(): boolean {
  return typeof picker().showSaveFilePicker === 'function';
}

/** Raised when the user closes the file dialog. Not an error to report — they changed their mind. */
export class PickerCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'PickerCancelled';
  }
}

function rethrow(error: unknown): never {
  // `AbortError` is what every browser throws when a picker is dismissed. Treating it as a failure
  // would put an error banner on screen every time somebody pressed Escape.
  if (error instanceof DOMException && error.name === 'AbortError') throw new PickerCancelled();
  throw error;
}

/**
 * Asks the user where to put a project, and writes it.
 *
 * Returns the handle when the browser gives one, so the caller can write to the same file next
 * time without asking again. Returns null when it fell back to a download — there is nothing to
 * remember, and saying so is better than handing back a fake handle that silently does nothing.
 */
export async function saveAs(bytes: Uint8Array, sceneName: string): Promise<HelaFileHandle | null> {
  const show = picker().showSaveFilePicker;

  if (show) {
    let handle: HelaFileHandle;
    try {
      handle = await show({ suggestedName: suggestedFilename(sceneName), types: PICKER_TYPES });
    } catch (error) {
      rethrow(error);
    }
    await writeTo(handle, bytes);
    return handle;
  }

  downloadFile(bytes, suggestedFilename(sceneName));
  return null;
}

/** Writes to a file the user already chose. The whole point of holding a handle. */
export async function writeTo(handle: HelaFileHandle, bytes: Uint8Array): Promise<void> {
  // Re-checked rather than assumed: a handle survives a reload through IndexedDB, and the
  // permission granted with it does not — the browser asks again, and writing without asking
  // throws.
  if (handle.queryPermission && handle.requestPermission) {
    const state = await handle.queryPermission({ mode: 'readwrite' });
    if (state !== 'granted') {
      const asked = await handle.requestPermission({ mode: 'readwrite' });
      if (asked !== 'granted') throw new PickerCancelled();
    }
  }

  const writable = await handle.createWritable();
  // A `Blob` rather than the array: writing a `Uint8Array` view works in Chromium but a Blob is
  // what the spec is written against, and it costs nothing.
  await writable.write(new Blob([bytes as BlobPart], { type: HELA_MIME }));
  await writable.close();
}

/** Asks the user for a project file and reads it. */
export async function openFile(): Promise<{ bytes: Uint8Array; handle: HelaFileHandle | null }> {
  const show = picker().showOpenFilePicker;

  if (show) {
    let handles: HelaFileHandle[];
    try {
      handles = await show({ multiple: false, types: PICKER_TYPES });
    } catch (error) {
      rethrow(error);
    }
    const handle = handles[0];
    if (!handle) throw new PickerCancelled();

    const file = await handle.getFile();
    return { bytes: new Uint8Array(await file.arrayBuffer()), handle };
  }

  const file = await promptForFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), handle: null };
}

/**
 * A hidden file input, for browsers with no picker API.
 *
 * Rejects on nothing chosen — but a cancelled file input fires no event at all in most browsers, so
 * this resolves only when a file arrives. The promise being left pending is the correct outcome for
 * a dialog the user dismissed; the alternative is a timeout that guesses.
 */
function promptForFile(): Promise<File> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${HELA_EXTENSION},${HELA_MIME}`;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (file) resolve(file);
    });
    document.body.append(input);
    input.click();
  });
}

/** The fallback save: a download, with all the "(3)" that implies. */
function downloadFile(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: HELA_MIME }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick rather than immediately: revoking synchronously after `click()` races
  // the browser's own fetch of the blob in some versions, and the download silently produces
  // nothing.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Whether a dropped file looks like a project, by name. Contents are checked when it is read. */
export function isHelaFilename(name: string): boolean {
  return name.toLowerCase().endsWith(HELA_EXTENSION);
}
