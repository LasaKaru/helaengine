import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only auto-registers cleanup when Vitest runs with `globals: true`. This project
// keeps globals off, so unmounting between tests is wired up explicitly — without it renders
// stack up and every `getByRole` starts failing with "found multiple elements".
afterEach(cleanup);
