import { describe, expect, it } from 'vitest';
import { checkBudget, criticalPath, type Measured } from './budget.js';
import { judgeCaching } from './headers.js';

describe('the critical path', () => {
  it('follows static imports transitively and stops at dynamic ones', () => {
    const reached = criticalPath({
      'index.html': { file: 'index.html', isEntry: true, imports: ['main.tsx'] },
      'main.tsx': { file: 'main.js', imports: ['shell.tsx'], dynamicImports: ['editor.tsx'] },
      'shell.tsx': { file: 'shell.js', imports: ['store.ts'] },
      'store.ts': { file: 'store.js' },
      // Behind a dynamic import, and so is everything only it reaches — this is the whole point of
      // the walk, and a version that followed `dynamicImports` would report the entire app.
      'editor.tsx': { file: 'editor.js', imports: ['three.ts'] },
      'three.ts': { file: 'three.js' },
    });

    expect([...reached].sort()).toEqual(['index.html', 'main.tsx', 'shell.tsx', 'store.ts']);
  });

  it('does not loop forever on a cycle', () => {
    // Circular imports are legal and rollup emits them. A naive walk hangs the build rather than
    // failing it, which is the worst way for a CI step to break.
    const reached = criticalPath({
      a: { file: 'a.js', isEntry: true, imports: ['b'] },
      b: { file: 'b.js', imports: ['a'] },
    });

    expect([...reached].sort()).toEqual(['a', 'b']);
  });
});

describe('the budget verdict', () => {
  const measured: Measured = {
    initialJs: 300 * 1024,
    initialCss: 5 * 1024,
    largestLazyChunk: 800 * 1024,
    chunks: [],
  };
  const budget = { initialJs: 400 * 1024, initialCss: 30 * 1024, largestLazyChunk: 900 * 1024 };

  it('passes when everything is under', () => {
    expect(checkBudget(measured, budget).over).toEqual([]);
  });

  it('names every budget that was exceeded, not only the first', () => {
    const over = checkBudget(
      { ...measured, initialJs: 500 * 1024, initialCss: 40 * 1024 },
      budget,
    ).over;
    // Reporting one at a time turns a single fix into three round trips through CI.
    expect(over).toHaveLength(2);
    expect(over[0]).toContain('initial JS');
    expect(over[1]).toContain('initial CSS');
  });
});

describe('cache policies', () => {
  it('accepts the real headers the API sends', () => {
    expect(judgeCaching('immutable', 'public, max-age=31536000, immutable')).toBeNull();
    expect(judgeCaching('no-store', 'no-store')).toBeNull();
    expect(judgeCaching('shared-short', 'public, max-age=300')).toBeNull();
  });

  it('tolerates additions that only improve the header', () => {
    // A directive nobody has added yet must not fail the check, or the check gets deleted the
    // first time somebody improves the header.
    expect(
      judgeCaching('immutable', 'public, max-age=31536000, immutable, stale-while-revalidate=60'),
    ).toBeNull();
  });

  it('rejects no-cache standing in for no-store', () => {
    // `no-cache` still writes the body to disk and only requires revalidation before reuse. For an
    // expiring download that is the difference between a copy existing and not existing.
    expect(judgeCaching('no-store', 'no-cache')).toContain('expected no-store');
  });

  it('rejects a shortened max-age on content-addressed bytes', () => {
    expect(judgeCaching('immutable', 'public, max-age=3600, immutable')).toContain('a year');
  });

  it('rejects a missing header rather than treating it as permissive', () => {
    expect(judgeCaching('immutable', null)).toContain('no cache-control header');
  });
});
