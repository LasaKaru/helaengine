import { describe, expect, it } from 'vitest';
import {
  DestructibleSchema,
  destructibleProblems,
  impactDamage,
  type Destructible,
} from '@helaengine/schema';
import { DestructibleSystem, type FragmentRequest } from './DestructibleSystem.js';

/**
 * Things that break.
 *
 * The claims worth pinning are all about what happens *around* the break: that one shotgun blast
 * does not break the same crate twice, that fragments do not appear at the origin, and that a level
 * where the player breaks a hundred crates is not left simulating five hundred pieces of wood.
 */

const settings = (input: Record<string, unknown> = {}): Destructible =>
  DestructibleSchema.parse(input);

/**
 * A world that records what was asked of it, so a test can read the whole story afterwards.
 *
 * `positionOf` stops answering once something is destroyed, because that is what the real runtime
 * does — the node leaves `loaded.objects`. A harness that kept answering would let the system read
 * a position *after* removing the object and still pass, which is exactly the bug worth catching.
 */
function harness(options: { positions?: Record<string, [number, number, number]> } = {}): {
  system: DestructibleSystem;
  destroyed: string[];
  debris: FragmentRequest[];
  events: Array<{ event: string; payload: unknown }>;
} {
  const destroyed: string[] = [];
  const debris: FragmentRequest[] = [];
  const events: Array<{ event: string; payload: unknown }> = [];
  const gone = new Set<string>();
  let counter = 0;

  const system = new DestructibleSystem({
    positionOf: (objectId) =>
      gone.has(objectId) ? null : (options.positions?.[objectId] ?? [0, 0, 0]),
    destroy: (objectId) => {
      destroyed.push(objectId);
      gone.add(objectId);
    },
    spawnDebris: (request) => {
      debris.push(request);
      counter += 1;
      return `debris_${counter}`;
    },
    emit: (event, payload) => events.push({ event, payload }),
    // Fixed, so a fragment burst is the same every run and a failure is reproducible.
    random: () => 0.5,
  });

  return { system, destroyed, debris, events };
}

describe('taking damage', () => {
  it('takes several hits before it goes', () => {
    const { system, destroyed } = harness();
    system.register('crate', settings({ hitPoints: 30 }));

    expect(system.damage('crate', 10)).toBe(false);
    expect(system.remaining('crate')).toBe(20);
    expect(destroyed).toEqual([]);

    expect(system.damage('crate', 25)).toBe(true);
    expect(destroyed).toEqual(['crate']);
  });

  it('ignores damage to something that is not breakable', () => {
    // Most of a level is not breakable, and a weapon that had to ask first would have to know about
    // every object in the world.
    const { system, destroyed } = harness();
    expect(system.damage('a_wall', 9999)).toBe(false);
    expect(destroyed).toEqual([]);
  });

  it('breaks once under a shotgun', () => {
    /**
     * The bug this exists for.
     *
     * A shotgun fires several pellets in one frame and every one reports a hit. Without the broken
     * set, the second pellet breaks an object that has already gone — spawning a second burst of
     * fragments from a position the crate no longer occupies.
     */
    const { system, destroyed, debris } = harness();
    system.register(
      'crate',
      settings({ hitPoints: 5, effect: 'fragments', debrisAssetId: 'plank', fragmentCount: 3 }),
    );

    expect(system.damage('crate', 10)).toBe(true);
    expect(system.damage('crate', 10)).toBe(false);
    expect(system.damage('crate', 10)).toBe(false);

    expect(destroyed).toEqual(['crate']);
    expect(debris).toHaveLength(3);
  });

  it('does not break twice when a break handler damages it again', () => {
    /**
     * The re-entrancy the `broken` set actually guards.
     *
     * Deleting from `tracked` happens *after* `destroy`, and both `destroy` and `spawnDebris` run
     * arbitrary runtime code that can emit. A listener that damages this same object — a chain
     * reaction, an area-of-effect explosion — would otherwise re-enter mid-break and produce a
     * second set of fragments from an object that is already gone.
     */
    const destroyed: string[] = [];
    const debris: FragmentRequest[] = [];
    // Referenced inside a hook that only runs later, so the const is initialised long before
    // anything reads it. The whole point is a callback that damages the system it was called from.
    const system: DestructibleSystem = new DestructibleSystem({
      positionOf: () => [0, 0, 0],
      destroy: (objectId) => {
        destroyed.push(objectId);
        // The explosion, arriving in the middle of the break it was caused by.
        system.damage('barrel', 100);
      },
      spawnDebris: (request) => {
        debris.push(request);
        return 'debris';
      },
      emit: () => undefined,
      random: () => 0.5,
    });

    system.register(
      'barrel',
      settings({ hitPoints: 5, effect: 'fragments', debrisAssetId: 'shard', fragmentCount: 2 }),
    );
    system.damage('barrel', 10);

    expect(destroyed).toEqual(['barrel']);
    expect(debris).toHaveLength(2);
  });

  it('refuses a source the author did not tick', () => {
    const { system } = harness();
    system.register('crate', settings({ hitPoints: 5, damagedBy: ['impact'] }));

    // A bridge railing that breaks when driven into and shrugs off bullets is a set piece; one that
    // does both is a hazard. Getting it wrong disassembles a level while the player walks past.
    expect(system.damage('crate', 100)).toBe(false);
    expect(system.impact('crate', 50)).toBe(true);
  });
});

describe('impact', () => {
  it('does nothing below the threshold', () => {
    const destructible = settings({ damagedBy: ['impact'], impactThreshold: 4 });
    expect(impactDamage(destructible, 3.9)).toBe(0);
    expect(impactDamage(destructible, 10)).toBeCloseTo(12, 5);
  });

  it('a resting object is not ground down by its own weight', () => {
    /**
     * Why the threshold is not optional.
     *
     * Resting contact registers as a continuous stream of tiny impacts. Without a floor, anything
     * standing on anything else destroys itself within seconds — and it reads as a bug in the
     * physics rather than as a number somebody chose.
     */
    const { system, destroyed } = harness();
    system.register('crate', settings({ hitPoints: 10, damagedBy: ['impact'] }));

    for (let frame = 0; frame < 600; frame += 1) system.impact('crate', 0.2);
    expect(destroyed).toEqual([]);
  });
});

describe('what is left behind', () => {
  it('vanishes with nothing in its place', () => {
    const { system, destroyed, debris } = harness();
    system.register('glass', settings({ hitPoints: 1 }));
    system.damage('glass', 5);

    expect(destroyed).toEqual(['glass']);
    expect(debris).toEqual([]);
  });

  it('swaps for another model in the same place', () => {
    const { system, debris } = harness({ positions: { wall: [12, 3, -4] } });
    system.register(
      'wall',
      settings({ hitPoints: 1, effect: 'swap', debrisAssetId: 'wall_broken' }),
    );
    system.damage('wall', 5);

    expect(debris).toHaveLength(1);
    expect(debris[0]!.assetId).toBe('wall_broken');
    // Read before the object is destroyed. A destroyed object has no position, and debris spawned
    // from the origin appears in the middle of the level rather than where the wall was.
    expect(debris[0]!.position).toEqual([12, 3, -4]);
  });

  it('throws fragments outward and upward from where the thing was', () => {
    const { system, debris } = harness({ positions: { crate: [10, 2, 10] } });
    system.register(
      'crate',
      settings({
        hitPoints: 1,
        effect: 'fragments',
        debrisAssetId: 'plank',
        fragmentCount: 6,
        fragmentSpeed: 4,
      }),
    );
    system.damage('crate', 5);

    expect(debris).toHaveLength(6);
    for (const fragment of debris) {
      // Near the crate, not at the origin.
      expect(Math.hypot(fragment.position[0] - 10, fragment.position[2] - 10)).toBeLessThan(2);
      // A purely horizontal burst slides along the floor and reads as a puddle rather than a break.
      expect(fragment.velocity[1]).toBeGreaterThan(0);
    }

    // Not all in one direction: fragments that all fly the same way look like a shove, not a break.
    const angles = new Set(
      debris.map((fragment) => Math.round(Math.atan2(fragment.velocity[2], fragment.velocity[0]))),
    );
    expect(angles.size).toBeGreaterThan(2);
  });

  it('leaves nothing behind when the debris asset was never chosen', () => {
    // Empty is legal to store — it is what a half-configured object looks like — and doing nothing
    // is better than spawning an object with an empty asset id and warning about it every frame.
    const { system, destroyed, debris } = harness();
    system.register('crate', settings({ hitPoints: 1, effect: 'fragments', debrisAssetId: '' }));
    system.damage('crate', 5);

    expect(destroyed).toEqual(['crate']);
    expect(debris).toEqual([]);
  });
});

describe('cleaning up', () => {
  it('ages fragments out', () => {
    const { system, destroyed } = harness();
    system.register(
      'crate',
      settings({
        hitPoints: 1,
        effect: 'fragments',
        debrisAssetId: 'plank',
        fragmentCount: 4,
        fragmentLifetime: 2,
      }),
    );
    system.damage('crate', 5);
    expect(system.pendingFragments).toBe(4);

    system.update(1);
    expect(destroyed).toEqual(['crate']);

    system.update(1.5);
    // A level where the player shoots a hundred crates would otherwise be left simulating five
    // hundred pieces of wood nobody can see.
    expect(system.pendingFragments).toBe(0);
    expect(destroyed).toHaveLength(5);
  });

  it('keeps fragments forever when the lifetime is zero', () => {
    const { system, destroyed } = harness();
    system.register(
      'crate',
      settings({
        hitPoints: 1,
        effect: 'fragments',
        debrisAssetId: 'plank',
        fragmentCount: 2,
        fragmentLifetime: 0,
      }),
    );
    system.damage('crate', 5);

    system.update(600);
    expect(destroyed).toEqual(['crate']);
  });

  it('drops every fragment when the scene is torn down', () => {
    const { system, destroyed } = harness();
    system.register(
      'crate',
      settings({ hitPoints: 1, effect: 'fragments', debrisAssetId: 'plank', fragmentCount: 3 }),
    );
    system.damage('crate', 5);

    system.clear();
    // Stopping a preview must put the world back as it found it, debris included.
    expect(destroyed).toHaveLength(4);
    expect(system.trackedCount).toBe(0);
  });
});

describe('talking to the rest of the game', () => {
  it('raises the author’s event and the general one', () => {
    const { system, events } = harness({ positions: { crate: [1, 2, 3] } });
    system.register('crate', settings({ hitPoints: 1, breakEvent: 'crateOpened' }));
    system.damage('crate', 5);

    const names = events.map((entry) => entry.event);
    // The author's own event first, so a graph listening for it runs before anything generic.
    expect(names).toEqual(['crateOpened', 'destructibleBroken']);
    expect(events[0]!.payload).toMatchObject({ objectId: 'crate', position: [1, 2, 3] });
  });

  it('reports a hit that did not break it', () => {
    const { system, events } = harness();
    system.register('crate', settings({ hitPoints: 30 }));
    system.damage('crate', 10);

    // So a health bar over a breakable, or a hit sound, has something to listen for.
    expect(events[0]).toMatchObject({
      event: 'destructibleDamaged',
      payload: { remaining: 20 },
    });
  });

  it('says nothing when it was never damaged', () => {
    const { system, events } = harness();
    system.register('crate', settings({ hitPoints: 30 }));
    system.damage('crate', 0);
    expect(events).toEqual([]);
  });
});

describe('destructibleProblems', () => {
  const assets = new Set(['plank', 'break_sound']);

  it('catches an effect with nothing to show for it', () => {
    expect(
      destructibleProblems(settings({ effect: 'fragments', debrisAssetId: '' }), assets).join('\n'),
    ).toContain('no asset chosen');
  });

  it('catches an asset this project does not have', () => {
    expect(
      destructibleProblems(settings({ effect: 'swap', debrisAssetId: 'ghost' }), assets).join('\n'),
    ).toContain('ghost');
  });

  it('catches a destructible nothing can damage', () => {
    expect(destructibleProblems(settings({ damagedBy: [] }), assets).join('\n')).toContain(
      'nothing can damage',
    );
  });

  it('catches an impact threshold of zero', () => {
    expect(
      destructibleProblems(settings({ damagedBy: ['impact'], impactThreshold: 0 }), assets).join(
        '\n',
      ),
    ).toContain('resting on the ground');
  });

  it('says nothing about one that is set up', () => {
    expect(
      destructibleProblems(
        settings({ effect: 'swap', debrisAssetId: 'plank', sfxAssetId: 'break_sound' }),
        assets,
      ),
    ).toEqual([]);
  });
});
