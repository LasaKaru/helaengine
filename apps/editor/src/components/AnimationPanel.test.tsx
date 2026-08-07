import { describe, expect, it } from 'vitest';
import { guessBindings } from './AnimationPanel';

/**
 * The clip-name guess, against the vocabularies people actually meet.
 *
 * Worth testing rather than eyeballing because it is allowed to be wrong: every binding it produces
 * is a dropdown somebody can change, so the failure mode is mild and therefore easy to leave
 * broken. These pin the cases that matter — the three packs a user is most likely to import — so a
 * later tweak to the word lists cannot silently stop matching Mixamo.
 */

describe('guessBindings', () => {
  it('matches a Mixamo character', () => {
    expect(
      guessBindings(['Idle', 'Walking', 'Running', 'Punching', 'Hit Reaction', 'Death']),
    ).toEqual({
      idle: 'Idle',
      walk: 'Walking',
      run: 'Running',
      attack: 'Punching',
      hit: 'Hit Reaction',
      die: 'Death',
    });
  });

  it('matches the Khronos fox, whose run is called Gallop', () => {
    // The reason `run` carries `gallop` in its word list at all: an animal rig names its gaits
    // after the animal, and this is the sample model everybody tries first.
    expect(guessBindings(['Survey', 'Walk', 'Run'])).toEqual({
      idle: 'Survey',
      walk: 'Walk',
      run: 'Run',
    });
    expect(guessBindings(['Survey', 'Walk', 'Gallop'])).toEqual({
      idle: 'Survey',
      walk: 'Walk',
      run: 'Gallop',
    });
  });

  it('never binds one clip to two states', () => {
    // `Run` contains no other keyword, but `Death Run` would match both `die` and `run`. Whichever
    // wins, the other must go without rather than doubling up — two states sharing a clip crossfade
    // to themselves and appear frozen.
    const bindings = guessBindings(['Death Run', 'Idle']);
    const used = Object.values(bindings);
    expect(new Set(used).size).toBe(used.length);
  });

  it('prefers the more specific word when two could match', () => {
    // `die` is checked before `run`, so a clip that reads as a death is a death.
    expect(guessBindings(['Death Run'])['die']).toBe('Death Run');
    expect(guessBindings(['Death Run'])['run']).toBeUndefined();
  });

  it('falls back to the first clip for idle when nothing is recognisable', () => {
    // Standing in a rest pose is the one state a character must not be missing, so an unhelpfully
    // named rig still gets something rather than nothing.
    expect(guessBindings(['Take 001'])).toEqual({ idle: 'Take 001' });
  });

  it('binds nothing at all for an empty model', () => {
    expect(guessBindings([])).toEqual({});
  });

  it('is case-insensitive, because pack authors are not consistent', () => {
    expect(guessBindings(['IDLE_LOOP', 'walk_fwd', 'RUN_Fast'])).toEqual({
      idle: 'IDLE_LOOP',
      walk: 'walk_fwd',
      run: 'RUN_Fast',
    });
  });
});
