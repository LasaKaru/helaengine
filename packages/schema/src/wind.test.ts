import { describe, expect, it } from 'vitest';
import {
  NO_WIND,
  SWAY_AMPLITUDE,
  WindSchema,
  resolveSway,
  swayGroupFor,
  windIsActive,
  windVector,
  type Wind,
} from './wind.js';

const breeze = (parts: Partial<Wind> = {}): Wind =>
  WindSchema.parse({ strength: 1, ...parts }) as Wind;

describe('windIsActive', () => {
  it('is false at zero strength, which is what every old scene says', () => {
    // Not "a wind blowing nothing" — the absence of one. The engine allocates no uniforms and
    // patches no materials, so a level saved before wind existed renders exactly as it did.
    expect(windIsActive(NO_WIND)).toBe(false);
    expect(windIsActive(WindSchema.parse({}))).toBe(false);
  });

  it('is false when nothing is affected, however strong', () => {
    expect(windIsActive(breeze({ strength: 4, affects: [] }))).toBe(false);
  });
});

describe('windVector', () => {
  it('reads compass degrees, not radians off an axis', () => {
    // North is -z, which is where a default camera looks. An author saying "the wind blows north"
    // should not have to know that.
    const [northX, northZ] = windVector(breeze({ direction: 0 }));
    expect(northX).toBeCloseTo(0, 6);
    expect(northZ).toBeCloseTo(-1, 6);

    const [eastX, eastZ] = windVector(breeze({ direction: 90 }));
    expect(eastX).toBeCloseTo(1, 6);
    expect(eastZ).toBeCloseTo(0, 6);
  });

  it('is a unit vector at every angle, so strength is the only scale', () => {
    for (const direction of [0, 37, 90, 180, 271, 360]) {
      const [x, z] = windVector(breeze({ direction }));
      expect(Math.hypot(x, z)).toBeCloseTo(1, 6);
    }
  });
});

describe('swayGroupFor', () => {
  it('puts felled wood in no group at all', () => {
    // These ship under `trees` and must stand perfectly still. A waving log is the single most
    // obviously wrong thing this system can do, and `tree_trunk` contains both `trunk` and `tree`,
    // so the rule's order is what decides it.
    for (const id of ['log', 'tree_log', 'tree_trunk', 'stump_round', 'resource_planks']) {
      expect(swayGroupFor(id, 'trees')).toBeNull();
    }
  });

  it('sorts real vegetation into groups', () => {
    expect(swayGroupFor('grass_large', 'trees')).toBe('grass');
    expect(swayGroupFor('flower_red_a', 'trees')).toBe('grass');
    expect(swayGroupFor('crops_wheat_stage_a', 'trees')).toBe('grass');
    expect(swayGroupFor('plant_bush', 'trees')).toBe('plants');
    expect(swayGroupFor('mushroom_red', 'trees')).toBe('plants');
    expect(swayGroupFor('cactus_tall', 'trees')).toBe('plants');
    expect(swayGroupFor('tree_oak', 'trees')).toBe('trees');
    expect(swayGroupFor('tree_pine_tall_a', 'trees')).toBe('trees');
  });

  it('never moves anything outside a vegetation category', () => {
    // A barrel is `props`, and the id `barrel` contains no vegetation word — but the category check
    // is what stops an imported model called `grass_barrel` from waving.
    expect(swayGroupFor('barrel', 'props')).toBeNull();
    expect(swayGroupFor('grass_barrel', 'props')).toBeNull();
    expect(swayGroupFor('wall_stone', 'buildings')).toBeNull();
    expect(swayGroupFor('enemy_goblin_01', 'enemies')).toBeNull();
  });

  it('gives grass a bigger amplitude than trees', () => {
    // One wind setting has to look right on a blade and on an oak. Equal amplitudes make either the
    // grass look frozen or the trees look like rubber.
    expect(SWAY_AMPLITUDE.grass).toBeGreaterThan(SWAY_AMPLITUDE.plants);
    expect(SWAY_AMPLITUDE.plants).toBeGreaterThan(SWAY_AMPLITUDE.trees);
  });
});

describe('resolveSway', () => {
  it('follows the rule when the object says auto', () => {
    expect(resolveSway(breeze(), 'auto', 'tree_oak', 'trees')).toBe('trees');
  });

  it('lets an object opt out of a wind that is blowing', () => {
    // The potted plant indoors.
    expect(resolveSway(breeze(), 'none', 'plant_bush', 'trees')).toBeNull();
  });

  it('lets an object opt in against the rule', () => {
    // The imported model the rule has never heard of. Category is checked by the rule, not by the
    // override, so naming a group is the escape hatch that always works.
    expect(resolveSway(breeze(), 'grass', 'decor_042', 'props')).toBe('grass');
  });

  it('respects the affected groups, override or not', () => {
    const treesOnly = breeze({ affects: ['trees'] });
    expect(resolveSway(treesOnly, 'auto', 'tree_oak', 'trees')).toBe('trees');
    expect(resolveSway(treesOnly, 'auto', 'grass_large', 'trees')).toBeNull();
    // An override picks the group; it does not overrule the level's decision to leave grass still.
    expect(resolveSway(treesOnly, 'grass', 'decor_042', 'props')).toBeNull();
  });

  it('moves nothing when there is no wind, whatever an object asks for', () => {
    expect(resolveSway(NO_WIND, 'grass', 'grass_large', 'trees')).toBeNull();
  });
});
