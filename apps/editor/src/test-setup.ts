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
