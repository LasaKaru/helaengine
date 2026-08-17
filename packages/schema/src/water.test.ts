import { describe, expect, it } from 'vitest';
import { EnvironmentSchema } from './environment.js';
import {
  WATER_PRESETS,
  WaterSchema,
  defaultWater,
  waterColor,
  waterDepthAt,
  waterProblems,
} from './water.js';

/**
 * The water vocabulary.
 *
 * The surface shader and the buoyancy are proved elsewhere — in a browser, against a control, as
 * with weather and surfaces. What is asserted here is the part that decides whether an existing
 * level changes: the default.
 */

describe('water', () => {
  it('is absent from a level that never asked for it', () => {
    // The whole point of nullable-and-null. A default object would mean every scene ever saved
    // suddenly has a surface at height zero, which for a level built on flat ground at zero is the
    // entire map underwater.
    expect(EnvironmentSchema.parse({}).water).toBeNull();
  });

  it('takes its look from the kind until somebody overrides it', () => {
    const sea = defaultWater('sea');
    expect(waterColor(sea)).toBe(WATER_PRESETS.sea.color);
    // A sea you can see the bottom of is a swimming pool. Clarity is what separates the kinds.
    expect(sea.clarity).toBeLessThan(defaultWater('pond').clarity);
    expect(sea.waveHeight).toBeGreaterThan(defaultWater('pond').waveHeight);

    expect(waterColor(WaterSchema.parse({ kind: 'sea', color: '#ff0000' }))).toBe('#ff0000');
  });

  it('reports depth as a signed number rather than clamping it', () => {
    /**
     * Negative means dry land, and callers want that. The shoreline fade needs to know how far the
     * bank has risen *above* the water; clamped to zero, every point on land looks identical to the
     * waterline and the shore becomes a hard edge again.
     */
    const water = WaterSchema.parse({ height: 2 });
    expect(waterDepthAt(water, 0)).toBe(2);
    expect(waterDepthAt(water, 2)).toBe(0);
    expect(waterDepthAt(water, 5)).toBe(-3);
  });

  it('says when the surface is under the whole level', () => {
    // The failure that reads as a broken feature: the plane is built, the shader runs, and there is
    // nothing to see, because it is beneath every piece of ground.
    const sunk = waterProblems(WaterSchema.parse({ height: -20 }), { lowest: 0, highest: 30 });
    expect(sunk.join(' ')).toContain('under all of it');

    // The control: a surface inside the terrain's range is not complained about.
    expect(waterProblems(WaterSchema.parse({ height: 5 }), { lowest: 0, highest: 30 })).toEqual([]);
  });

  it('says when the level is entirely submerged', () => {
    const drowned = waterProblems(WaterSchema.parse({ height: 40 }), { lowest: 0, highest: 30 });
    expect(drowned.join(' ')).toContain('whole level is underwater');
  });

  it('says when things will float forever', () => {
    const bobbing = waterProblems(WaterSchema.parse({ height: 5, buoyancy: true, drag: 0 }), {
      lowest: 0,
      highest: 30,
    });
    expect(bobbing.join(' ')).toContain('bob forever');

    // And not when drag is doing its job — a warning list that fires on a correct setting is one
    // people stop reading.
    expect(
      waterProblems(WaterSchema.parse({ height: 5, buoyancy: true, drag: 3 }), {
        lowest: 0,
        highest: 30,
      }),
    ).toEqual([]);
  });

  it('keeps the look and the physics independent', () => {
    // A decorative moat the player never enters wants the surface and none of the cost. Buoyancy
    // off by default means adding water to an existing scene cannot change how it plays.
    expect(defaultWater().buoyancy).toBe(false);
  });
});
