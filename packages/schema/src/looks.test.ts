import { describe, expect, it } from 'vitest';
import { EnvironmentSchema, applyLook, type Environment } from './index.js';

/**
 * The look presets.
 *
 * The interesting property is not what each one sets — that is a table of numbers, and pinning
 * every one of them would make the file unchangeable. It is that applying one is *complete*: half
 * of what a look does is turn things off, so switching between them cannot leave a filmic grade
 * sitting under a flat look.
 */

const base = (parts: Partial<Environment> = {}): Environment =>
  EnvironmentSchema.parse({}) && ({ ...EnvironmentSchema.parse({}), ...parts } as Environment);

describe('applyLook', () => {
  it('leaves what is not about lighting alone', () => {
    // Background, fog and wind are decisions about this level, not about how it is lit. A preset
    // that reset them would make trying one out destructive.
    const environment = base({
      background: '#101820',
      fog: { color: '#101820', near: 5, far: 60 },
      wind: { strength: 2, direction: 90, speed: 1, gustiness: 0.5, affects: ['grass'] },
    });

    for (const look of ['stylized', 'realistic'] as const) {
      const next = applyLook(environment, look);
      expect(next.background).toBe('#101820');
      expect(next.fog).toEqual(environment.fog);
      expect(next.wind).toEqual(environment.wind);
    }
  });

  it('undoes itself: realistic then stylised leaves nothing behind', () => {
    /**
     * The whole reason `applyLook` returns a full environment rather than a patch.
     *
     * A patch that only ever adds would leave bloom, a vignette and a filmic curve switched on
     * underneath a look whose entire point is to be flat — and the author would have to find and
     * clear four settings by hand to get back where they started.
     */
    const flat = applyLook(base(), 'stylized');
    const round = applyLook(applyLook(base(), 'realistic'), 'stylized');

    expect(round.toneMapping).toBe('none');
    expect(round.postProcessing.enabled).toBe(false);
    expect(round.postProcessing.bloom.enabled).toBe(false);
    expect(round.postProcessing.vignette.enabled).toBe(false);
    expect(round.postProcessing.colorGrade.enabled).toBe(false);
    expect(round.lighting.hemisphere).toBeNull();
    expect(round.lighting).toEqual(flat.lighting);
    expect(round.exposure).toBe(flat.exposure);

    /**
     * The parameters of a *disabled* effect are deliberately not compared.
     *
     * A switched-off vignette with realistic's radius left in it renders exactly like a switched-off
     * vignette with the default one — nothing. Demanding they match would pin numbers that cannot
     * be seen, and would make the round trip lose something worth keeping: turn bloom back on by
     * hand afterwards and you get the values that looked right, not the schema's defaults.
     */
  });

  it('does not move the sun', () => {
    // Elevation and azimuth are the time of day — a decision about this level, not about how it is
    // lit. Moving them would swing every shadow in the scene, and the flat look has no business
    // moving them back. `realistic` set elevation before this test existed, and `stylized` did not
    // restore it, so switching back and forth walked the sun down the sky.
    const noon = base();
    noon.lighting.sun.elevation = 72;
    noon.lighting.sun.azimuth = 200;

    for (const look of ['stylized', 'realistic'] as const) {
      const next = applyLook(noon, look);
      expect(next.lighting.sun.elevation).toBe(72);
      expect(next.lighting.sun.azimuth).toBe(200);
    }
  });

  it('is idempotent', () => {
    // Pressing the button twice is something people do. It must not compound.
    const once = applyLook(base(), 'realistic');
    expect(applyLook(once, 'realistic')).toEqual(once);
  });

  it('produces a document the schema still accepts', () => {
    // Every number here is inside a bounded range, and a preset that wrote an out-of-range value
    // would fail on save rather than on apply — long after the button that caused it.
    for (const look of ['stylized', 'realistic'] as const) {
      expect(() => EnvironmentSchema.parse(applyLook(base(), look))).not.toThrow();
    }
  });

  it('makes the realistic look actually directional', () => {
    const realistic = applyLook(base(), 'realistic');
    const stylized = applyLook(base(), 'stylized');

    // The one claim worth pinning about the numbers: a high flat ambient is what makes a scene look
    // uniformly lit, and uniformly lit is the strongest "this is a toy" signal there is. The fill
    // has to come from somewhere directional instead.
    expect(realistic.lighting.ambient).toBeLessThan(stylized.lighting.ambient);
    expect(realistic.lighting.hemisphere).not.toBeNull();
    expect(realistic.lighting.sun.intensity).toBeGreaterThan(stylized.lighting.sun.intensity);
  });
});
