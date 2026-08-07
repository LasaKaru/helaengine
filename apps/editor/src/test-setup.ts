import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only auto-registers cleanup when Vitest runs with `globals: true`. This project
// keeps globals off, so unmounting between tests is wired up explicitly — without it renders
// stack up and every `getByRole` starts failing with "found multiple elements".
afterEach(cleanup);

// jsdom implements no layout engine and therefore no ResizeObserver. Components that size
// themselves — the virtualized asset grid — only need it to exist and stay quiet; the sizes it
// would report are zero in jsdom regardless, so real layout behaviour is covered by the e2e suite.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

/**
 * `Blob.arrayBuffer` and `Blob.text`, which jsdom does not implement.
 *
 * Every browser has had both since 2019, and code that stores a `File` in IndexedDB and reads it
 * back — importing a model, saving a `.hela` — uses them as a matter of course. Without this a
 * test of that code fails with "file.arrayBuffer is not a function", which reads like a bug in the
 * code and is a gap in the environment.
 *
 * Built on `FileReader`, which jsdom *does* implement, so the bytes make a real round trip through
 * jsdom's own Blob rather than being handed back from a variable the shim closed over.
 */
if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  const read = (blob: Blob, as: 'buffer' | 'text'): Promise<ArrayBuffer | string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer | string);
      reader.onerror = () => reject(reader.error ?? new Error('could not read blob'));
      if (as === 'buffer') reader.readAsArrayBuffer(blob);
      else reader.readAsText(blob);
    });

  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return read(this, 'buffer') as Promise<ArrayBuffer>;
  };
  Blob.prototype.text = function text(this: Blob): Promise<string> {
    return read(this, 'text') as Promise<string>;
  };
}

/**
 * `URL.createObjectURL` / `revokeObjectURL`, which jsdom also does not implement.
 *
 * Anything that shows a user's own file — an imported model, a UI background — hands the engine or
 * an `<img>` an object URL. The identity is what matters to the code under test (is it stable? is
 * it revoked?), not that the URL resolves, so a counter is enough and pretending otherwise would
 * be inventing a fetchable URL that nothing can fetch.
 */
if (typeof URL.createObjectURL !== 'function') {
  let next = 0;
  const live = new Set<string>();
  URL.createObjectURL = () => {
    const url = `blob:helaengine-test/${(next += 1)}`;
    live.add(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    live.delete(url);
  };
}
