import type { UnlockKey, UnlockMethod } from '@helaengine/schema';

/**
 * Whatever watches for one secret being discovered.
 *
 * Three narrow hooks rather than one general one: a sequence watches keys, a trigger watches the
 * bus, and a collection counter watches the bus and keeps a tally. Each returns true on the frame
 * the condition is met, and the runtime — not the detector — decides what that means.
 */
export interface UnlockDetector {
  /** Named buttons pressed this frame. Returns true when they complete the condition. */
  onKeys?(keys: readonly UnlockKey[], elapsed: number): boolean;
  /** A bus event. Returns true when it completes the condition. */
  onEvent?(event: string, payload: unknown): boolean;
  /** Forgets any progress, so a re-arming secret starts from nothing. */
  reset(): void;
}

/**
 * A Konami-style code.
 *
 * Matched against a rolling window rather than by tracking one index, because index tracking gets
 * the overlapping case wrong: entering `Up Up Down` against the sequence `Up Down` should succeed on
 * the third key, and a naive index resets to zero on the second `Up` and never matches.
 */
class InputSequenceDetector implements UnlockDetector {
  readonly #sequence: readonly UnlockKey[];
  readonly #withinSeconds: number;
  readonly #recent: Array<{ key: UnlockKey; at: number }> = [];

  constructor(sequence: readonly UnlockKey[], withinSeconds: number) {
    this.#sequence = sequence;
    this.#withinSeconds = withinSeconds;
  }

  onKeys(keys: readonly UnlockKey[], elapsed: number): boolean {
    for (const key of keys) {
      this.#recent.push({ key, at: elapsed });
      // The window is between consecutive presses, so a lapsed gap drops everything before it
      // rather than the whole buffer: the key just pressed may well be the start of a new attempt.
      while (this.#recent.length > 1) {
        const [first, second] = this.#recent;
        if (second!.at - first!.at <= this.#withinSeconds) break;
        this.#recent.shift();
      }
      if (this.#recent.length > this.#sequence.length) this.#recent.shift();

      if (this.#recent.length !== this.#sequence.length) continue;
      if (this.#recent.every((entry, index) => entry.key === this.#sequence[index])) {
        this.#recent.length = 0;
        return true;
      }
    }
    return false;
  }

  reset(): void {
    this.#recent.length = 0;
  }
}

/** Fires when a named event reaches the bus, optionally only for one trigger volume. */
class EventDetector implements UnlockDetector {
  readonly #event: string;
  readonly #triggerId: string | null;

  constructor(event: string, triggerId: string | null = null) {
    this.#event = event;
    this.#triggerId = triggerId;
  }

  onEvent(event: string, payload: unknown): boolean {
    if (event !== this.#event) return false;
    if (this.#triggerId === null) return true;

    const id = (payload as { triggerId?: unknown } | undefined)?.triggerId;
    return id === this.#triggerId;
  }

  reset(): void {}
}

/** Fires once enough pickups of one kind have been collected. */
class ItemCountDetector implements UnlockDetector {
  readonly #kind: string;
  readonly #count: number;
  #collected = 0;

  constructor(kind: string, count: number) {
    this.#kind = kind;
    this.#count = count;
  }

  onEvent(event: string, payload: unknown): boolean {
    if (event !== 'itemPickedUp') return false;
    if ((payload as { kind?: unknown } | undefined)?.kind !== this.#kind) return false;

    this.#collected += 1;
    return this.#collected >= this.#count;
  }

  reset(): void {
    this.#collected = 0;
  }
}

/** The event `TriggerRuntime` raises whenever anything enters a volume. */
export const TRIGGER_ENTERED = 'triggerEntered';

/**
 * Turns a document's unlock method into something that watches for it.
 *
 * An exhaustive switch, and that exhaustiveness is the point: TypeScript will not compile this file
 * if a method type is added to the schema without a detector for it, so the vocabulary cannot drift
 * open the way a string-keyed registry silently can.
 */
export function createDetector(method: UnlockMethod): UnlockDetector {
  switch (method.type) {
    case 'inputSequence':
      return new InputSequenceDetector(method.sequence, method.withinSeconds);
    case 'triggerVolume':
      return new EventDetector(TRIGGER_ENTERED, method.triggerId);
    case 'event':
      return new EventDetector(method.event);
    case 'itemCount':
      return new ItemCountDetector(method.kind, method.count);
  }
}
