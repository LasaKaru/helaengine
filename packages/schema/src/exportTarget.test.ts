import { describe, expect, it } from 'vitest';
import {
  DESKTOP_PLATFORMS,
  DesktopOptionsSchema,
  ExportJobSchema,
  STAGE_PROGRESS,
  desktopWarnings,
  estimatedDownloadMb,
} from './exportJob.js';

/**
 * The desktop export target.
 *
 * Mostly about the default, which is the part that has to be right: a job recorded before this
 * existed has no `target` field at all, and it must read back as the web export it was rather than
 * as a desktop build nobody asked for.
 */

const job = (overrides: Record<string, unknown> = {}) =>
  ExportJobSchema.parse({
    id: 'job_1',
    projectId: 'p1',
    organizationId: 'o1',
    sceneVersion: 3,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    attempts: 0,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  });

describe('export target', () => {
  it('reads a job written before the field existed as a web export', () => {
    // The whole point of the default. A stored row with no `target` is every export ever made
    // before today, and reading them as desktop builds would be a migration disguised as a schema.
    const parsed = job();
    expect(parsed.target).toBe('web');
    expect(parsed.desktop).toBeNull();
  });

  it('carries desktop options only when asked for', () => {
    const parsed = job({ target: 'desktop', desktop: { platform: 'linux-x64' } });
    expect(parsed.target).toBe('desktop');
    expect(parsed.desktop?.platform).toBe('linux-x64');
    // Filled in rather than left undefined, so the worker never has to decide what a missing
    // version means halfway through a build.
    expect(parsed.desktop?.version).toBe('1.0.0');
    expect(parsed.desktop?.fullscreen).toBe(false);
  });

  it('refuses a platform it cannot build', () => {
    // macOS is the one people ask for. A `.app` that will not open without Apple notarisation is
    // worse than no `.app`, so the vocabulary excludes it rather than the builder failing later.
    expect(DesktopOptionsSchema.safeParse({ platform: 'darwin-arm64' }).success).toBe(false);
    expect(DESKTOP_PLATFORMS).not.toContain('darwin-arm64');
  });

  it('refuses a version that is not three numbers', () => {
    expect(DesktopOptionsSchema.safeParse({ version: 'v2' }).success).toBe(false);
    expect(DesktopOptionsSchema.safeParse({ version: '2.0.1' }).success).toBe(true);
  });

  it('leaves a web export walking the same progress it always did', () => {
    /**
     * The two desktop stages sit between building and compressing, so nothing a web export reports
     * changed. A bar that suddenly stalled at 40% on every existing export would be this feature
     * making unrelated jobs look broken.
     */
    expect(STAGE_PROGRESS.building).toBe(40);
    expect(STAGE_PROGRESS.compressing).toBe(75);
    expect(STAGE_PROGRESS['fetching-runtime']).toBeGreaterThan(STAGE_PROGRESS.building);
    expect(STAGE_PROGRESS.packaging).toBeLessThan(STAGE_PROGRESS.compressing);
  });

  it('says what a Windows player will actually see', () => {
    // The thing authors find out from a player otherwise, which is the worst way to find it out.
    const warnings = desktopWarnings(DesktopOptionsSchema.parse({ platform: 'win32-x64' }));
    expect(warnings.join(' ')).toContain('Windows protected your PC');
    expect(warnings.join(' ')).toContain('Run anyway');
  });

  it('does not warn about SmartScreen on a Linux build', () => {
    // The control. A warnings list that says everything says nothing, and an author who is shown
    // Windows advice on a Linux build stops reading the list.
    const warnings = desktopWarnings(DesktopOptionsSchema.parse({ platform: 'linux-x64' }));
    expect(warnings.join(' ')).not.toContain('Windows protected your PC');
  });

  it('states the size before anybody waits for the build', () => {
    expect(estimatedDownloadMb('desktop')).toBeGreaterThan(estimatedDownloadMb('web') * 10);
    expect(
      desktopWarnings(DesktopOptionsSchema.parse({})).some((line) => line.includes('MB')),
    ).toBe(true);
  });
});
