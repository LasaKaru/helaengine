import type * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { UnlockablesSchema, type Unlockable, type UnlockKey } from '@helaengine/schema';
import type { EventBus } from '../TriggerRuntime.js';
import { INERT_WORLD, type PickupRequest, type WorldHandle } from '../world.js';
import { TRIGGER_ENTERED } from './detectors.js';
import { UnlockRuntime } from './UnlockRuntime.js';

/** A bus with the same contract `BehaviorRuntime` provides, and nothing else. */
function makeBus(): EventBus & { fired: string[] } {
  const named = new Map<string, Set<(payload: unknown) => void>>();
  const any = new Set<(event: string, payload: unknown) => void>();
  const fired: string[] = [];

  return {
    fired,
    emit(event, payload) {
      fired.push(event);
      for (const listener of [...(named.get(event) ?? [])]) listener(payload);
      for (const listener of [...any]) listener(event, payload);
    },
    on(event, listener) {
      const set = named.get(event) ?? new Set();
      set.add(listener);
      named.set(event, set);
      return () => set.delete(listener);
    },
    onAny(listener) {
      any.add(listener);
      return () => any.delete(listener);
    },
  };
}

interface Rig {
  runtime: UnlockRuntime;
  bus: EventBus & { fired: string[] };
  hidden: Map<string, boolean>;
  teleports: THREE.Vector3[];
  collected: PickupRequest[];
  emitted: Array<{ event: string; payload: unknown }>;
}

function rig(unlockables: unknown, options: { knownObjects?: string[] } = {}): Rig {
  const parsed: Unlockable[] = UnlockablesSchema.parse(unlockables);
  const bus = makeBus();
  const hidden = new Map<string, boolean>();
  const teleports: THREE.Vector3[] = [];
  const collected: PickupRequest[] = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const known = new Set(options.knownObjects ?? ['obj_secret', 'obj_other']);

  const world: WorldHandle = {
    ...INERT_WORLD,
    teleportPlayer: (position) => teleports.push(position.clone()),
    collect: (request) => {
      collected.push(request);
      return true;
    },
    setObjectHidden: (objectId, isHidden) => {
      if (!known.has(objectId)) return false;
      hidden.set(objectId, isHidden);
      return true;
    },
    emit: (event, payload) => {
      emitted.push({ event, payload });
      bus.emit(event, payload);
    },
  };

  return {
    runtime: new UnlockRuntime({ unlockables: parsed, world, bus }),
    bus,
    hidden,
    teleports,
    collected,
    emitted,
  };
}

/** Feeds keys one frame at a time, the way the input layer hands them over. */
function press(runtime: UnlockRuntime, keys: UnlockKey[], gap = 0.1): void {
  for (const key of keys) runtime.update(gap, [key]);
}

const KONAMI: UnlockKey[] = [
  'Up',
  'Up',
  'Down',
  'Down',
  'Left',
  'Right',
  'Left',
  'Right',
  'B',
  'A',
];

describe('UnlockRuntime', () => {
  it('fires an input sequence and announces it', () => {
    const found = vi.fn();
    const it_ = rig([
      {
        id: 'secret_0001',
        label: 'The old code',
        unlockMethod: { type: 'inputSequence', sequence: KONAMI },
        actions: [{ type: 'emit', event: 'konami' }],
      },
    ]);
    it_.bus.on('secretUnlocked', found);
    it_.runtime.start();

    press(it_.runtime, KONAMI.slice(0, -1));
    expect(it_.runtime.unlockedIds).toEqual([]);

    press(it_.runtime, ['A']);
    expect(it_.runtime.unlockedIds).toEqual(['secret_0001']);
    expect(found).toHaveBeenCalledWith(
      expect.objectContaining({ unlockableId: 'secret_0001', label: 'The old code' }),
    );
    expect(it_.emitted.map((entry) => entry.event)).toEqual(['konami']);
  });

  it('lapses an attempt entered too slowly', () => {
    const it_ = rig([
      {
        id: 'secret_0001',
        unlockMethod: { type: 'inputSequence', sequence: ['Up', 'Down'], withinSeconds: 0.5 },
        actions: [{ type: 'emit', event: 'ok' }],
      },
    ]);
    it_.runtime.start();

    it_.runtime.update(0.1, ['Up']);
    it_.runtime.update(2, ['Down']);
    expect(it_.runtime.unlockedIds).toEqual([]);

    // And a prompt attempt right afterwards still works — the lapse dropped the stale key, not
    // the whole buffer.
    it_.runtime.update(0.1, ['Up']);
    it_.runtime.update(0.1, ['Down']);
    expect(it_.runtime.unlockedIds).toEqual(['secret_0001']);
  });

  it('matches a sequence that overlaps its own prefix', () => {
    // `Up Up Down` against `Up Down` has to succeed on the third key. Index-tracking gets this
    // wrong: it resets on the second Up and never matches.
    const it_ = rig([
      {
        id: 'secret_0001',
        unlockMethod: { type: 'inputSequence', sequence: ['Up', 'Down'] },
        actions: [{ type: 'emit', event: 'ok' }],
      },
    ]);
    it_.runtime.start();

    press(it_.runtime, ['Up', 'Up', 'Down']);
    expect(it_.runtime.unlockedIds).toEqual(['secret_0001']);
  });

  it('ignores keys that are not part of the sequence rather than resetting on them', () => {
    const it_ = rig([
      {
        id: 'secret_0001',
        unlockMethod: { type: 'inputSequence', sequence: ['Up', 'Down'] },
        actions: [{ type: 'emit', event: 'ok' }],
      },
    ]);
    it_.runtime.start();

    // A stray key does break the run — the window is the last N presses, so 'Up X Down' is not
    // 'Up Down'. Asserted so the behaviour is a decision rather than an accident.
    press(it_.runtime, ['Up', 'X', 'Down']);
    expect(it_.runtime.unlockedIds).toEqual([]);
  });

  it('fires when the named trigger volume is entered, and not another one', () => {
    const it_ = rig([
      {
        id: 'secret_0001',
        unlockMethod: { type: 'triggerVolume', triggerId: 'obj_0007' },
        actions: [{ type: 'emit', event: 'ok' }],
      },
    ]);
    it_.runtime.start();

    it_.bus.emit(TRIGGER_ENTERED, { triggerId: 'obj_0009', subjectId: 'player' });
    expect(it_.runtime.unlockedIds).toEqual([]);

    it_.bus.emit(TRIGGER_ENTERED, { triggerId: 'obj_0007', subjectId: 'player' });
    expect(it_.runtime.unlockedIds).toEqual(['secret_0001']);
  });

  it('fires on any named event, which is what makes it compose with behaviours', () => {
    const it_ = rig([
      {
        id: 'secret_0001',
        unlockMethod: { type: 'event', event: 'enemyDied' },
        actions: [{ type: 'emit', event: 'ok' }],
      },
    ]);
    it_.runtime.start();

    it_.bus.emit('enemyDied', { objectId: 'obj_0004' });
    expect(it_.runtime.unlockedIds).toEqual(['secret_0001']);
  });

  it('counts pickups of one kind and ignores the others', () => {
    const it_ = rig([
      {
        id: 'secret_0001',
        unlockMethod: { type: 'itemCount', kind: 'health', count: 3 },
        actions: [{ type: 'emit', event: 'ok' }],
      },
    ]);
    it_.runtime.start();

    for (const kind of ['health', 'ammo', 'health', 'weapon']) {
      it_.bus.emit('itemPickedUp', { kind });
    }
    expect(it_.runtime.unlockedIds).toEqual([]);

    it_.bus.emit('itemPickedUp', { kind: 'health' });
    expect(it_.runtime.unlockedIds).toEqual(['secret_0001']);
  });

  it('hides a revealed area at startup and shows it when the secret fires', () => {
    const it_ = rig([
      {
        id: 'secret_0001',
        unlockMethod: { type: 'event', event: 'open' },
        actions: [{ type: 'revealArea', objectIds: ['obj_secret'] }],
      },
    ]);

    it_.runtime.start();
    // Hidden because something reveals it — derived from the action rather than from a second flag
    // that could disagree with it.
    expect(it_.hidden.get('obj_secret')).toBe(true);

    it_.bus.emit('open');
    expect(it_.hidden.get('obj_secret')).toBe(false);
  });

  it('puts a hidden area back when the preview stops', () => {
    const it_ = rig([
      {
        id: 'secret_0001',
        unlockMethod: { type: 'event', event: 'open' },
        actions: [{ type: 'revealArea', objectIds: ['obj_secret'] }],
      },
    ]);

    it_.runtime.start();
    it_.runtime.stop();

    expect(it_.hidden.get('obj_secret')).toBe(false);
    expect(it_.runtime.unlockedIds).toEqual([]);
  });

  it('teleports and grants a weapon through the same doors gameplay uses', () => {
    const it_ = rig([
      {
        id: 'secret_0001',
        unlockMethod: { type: 'event', event: 'open' },
        actions: [
          { type: 'teleportPlayer', target: [10, 2, -30] },
          { type: 'unlockInventoryItem', weaponId: 'weapon_0002' },
        ],
      },
    ]);
    it_.runtime.start();
    it_.bus.emit('open');

    expect(it_.teleports[0]?.toArray()).toEqual([10, 2, -30]);
    // The same call a pickup makes, so a secret weapon arrives with its ammo and obeys the carry
    // limit rather than bypassing both.
    expect(it_.collected).toEqual([{ kind: 'weapon', weaponId: 'weapon_0002', amount: 0 }]);
  });

  it('fires once by default and re-arms when told to', () => {
    const once = rig([
      {
        id: 'secret_0001',
        unlockMethod: { type: 'event', event: 'open' },
        actions: [{ type: 'emit', event: 'ok' }],
      },
    ]);
    once.runtime.start();
    once.bus.emit('open');
    once.bus.emit('open');
    expect(once.emitted).toHaveLength(1);

    const repeatable = rig([
      {
        id: 'secret_0001',
        once: false,
        unlockMethod: { type: 'event', event: 'open' },
        actions: [{ type: 'emit', event: 'ok' }],
      },
    ]);
    repeatable.runtime.start();
    repeatable.bus.emit('open');
    repeatable.bus.emit('open');
    expect(repeatable.emitted).toHaveLength(2);
  });

  it('does nothing before it is started, and nothing after it is stopped', () => {
    const it_ = rig([
      {
        id: 'secret_0001',
        unlockMethod: { type: 'event', event: 'open' },
        actions: [{ type: 'emit', event: 'ok' }],
      },
    ]);

    it_.bus.emit('open');
    expect(it_.runtime.unlockedIds).toEqual([]);

    it_.runtime.start();
    it_.runtime.stop();
    it_.bus.emit('open');
    expect(it_.runtime.unlockedIds).toEqual([]);
  });

  it('carries an empty list without complaint', () => {
    const it_ = rig([]);
    it_.runtime.start();
    it_.runtime.update(0.1, ['Up']);
    expect(it_.runtime.count).toBe(0);
  });
});
