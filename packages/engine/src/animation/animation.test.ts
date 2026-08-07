import * as THREE from 'three';
import { ObjectAnimationSchema, type ObjectAnimation } from '@helaengine/schema';
import { describe, expect, it } from 'vitest';
import { Animator } from './Animator.js';
import { cloneModel, hasSkeleton } from './clone.js';

/**
 * A clip that moves one node, long enough that a test can be part-way through it.
 *
 * Real clips rather than mocks throughout this file: an `AnimationMixer` is the thing under test as
 * much as the `Animator` around it, and a fake mixer would prove only that the wrapper calls the
 * methods it was written to call.
 */
function clip(name: string, seconds: number): THREE.AnimationClip {
  const track = new THREE.VectorKeyframeTrack('.position', [0, seconds], [0, 0, 0, 0, seconds, 0]);
  return new THREE.AnimationClip(name, seconds, [track]);
}

const CLIPS = [
  clip('Idle', 1),
  clip('Walk', 1),
  clip('Gallop', 1),
  clip('Flinch', 0.4),
  clip('Down', 0.5),
];

function config(overrides: Partial<ObjectAnimation> = {}): ObjectAnimation {
  return ObjectAnimationSchema.parse({
    clips: { idle: 'Idle', walk: 'Walk', run: 'Gallop', hit: 'Flinch', die: 'Down' },
    ...overrides,
  });
}

function animator(overrides: Partial<ObjectAnimation> = {}): Animator {
  return new Animator(new THREE.Object3D(), CLIPS, config(overrides));
}

describe('Animator', () => {
  it('starts in the default state', () => {
    expect(animator().state).toBe('idle');
    expect(animator({ defaultState: 'walk' }).state).toBe('walk');
  });

  it('changes state on request', () => {
    const subject = animator();
    subject.play('run');
    expect(subject.state).toBe('run');
  });

  it('ignores a state the model has no clip for, rather than freezing', () => {
    // A half-rigged model is the normal case in a low-poly library. An enemy that stops dead
    // because its pack has no attack animation is worse than one that keeps running.
    const subject = new Animator(new THREE.Object3D(), CLIPS, config());
    subject.play('run');
    subject.play('attack');
    expect(subject.state).toBe('run');
  });

  it('returns to the looping state when an interruption finishes', () => {
    const subject = animator();
    subject.play('run');
    subject.play('hit');
    expect(subject.state).toBe('hit');

    // Past the end of the 0.4s flinch. The mixer fires `finished`, which is what hands control
    // back — without it the character would stand frozen mid-flinch for the rest of the level.
    subject.update(0.5);
    expect(subject.state).toBe('run');
    expect(subject.baseState).toBe('run');
  });

  it('remembers the looping state across an interruption even without a clip for it', () => {
    // `attack` has no clip here, so nothing visibly changes when it is requested — but it is still
    // what the object is doing, and a flinch must not hand back to the wrong thing.
    const subject = new Animator(new THREE.Object3D(), CLIPS, config());
    subject.play('walk');
    subject.play('attack');
    subject.play('hit');
    subject.update(0.5);
    expect(subject.baseState).toBe('attack');
    // The base has no clip, so handing back to it is refused — and the fallback is what was
    // visibly playing before the flinch. Without it the character stays clamped on the last frame
    // of the flinch for the rest of the level.
    expect(subject.state).toBe('walk');
  });

  it('refuses to leave the death state', () => {
    const subject = animator();
    subject.play('die');
    subject.update(1);
    subject.play('run');
    subject.play('idle');
    // A corpse that gets told to walk because a stale behaviour ticked once more stands up. It is
    // a bug seen in shipped games, and this is the line that prevents it.
    expect(subject.state).toBe('die');
  });

  it('reports clips that are bound but absent from the model', () => {
    const subject = new Animator(
      new THREE.Object3D(),
      CLIPS,
      config({ clips: { idle: 'Idle', run: 'Sprint' } }),
    );
    // Named rather than counted, because the useful message is "you asked for Sprint and this
    // model has Gallop".
    expect(subject.missing).toEqual(['Sprint']);
    expect(subject.has('run')).toBe(false);
    expect(subject.has('idle')).toBe(true);
  });

  it('plays a one-shot again the second time it is asked for', () => {
    const subject = animator();
    subject.play('hit');
    subject.update(0.5);
    expect(subject.state).toBe('idle');

    // The second flinch of an enemy's life. Without the `reset()` before fading in, the action is
    // still parked on its last frame and nothing appears to happen.
    subject.play('hit');
    expect(subject.state).toBe('hit');
    subject.update(0.5);
    expect(subject.state).toBe('idle');
  });

  it('stops driving the object once disposed', () => {
    const root = new THREE.Object3D();
    const subject = new Animator(root, CLIPS, config());
    subject.update(0.5);
    expect(root.position.y).toBeCloseTo(0.5);

    // Three restores a property to its pre-animation value when the binding is uncached, so the
    // assertion is not "it kept the last pose" — it is that nothing moves any more.
    subject.dispose();
    const settled = root.position.y;
    subject.update(0.5);
    subject.update(0.5);
    expect(root.position.y).toBe(settled);
  });
});

describe('cloneModel', () => {
  /** A minimal skinned mesh: two bones, one vertex weighted to the first. */
  function skinnedModel(): THREE.Object3D {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));

    const root = new THREE.Bone();
    const child = new THREE.Bone();
    root.add(child);

    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
    mesh.add(root);
    mesh.bind(new THREE.Skeleton([root, child]));

    const group = new THREE.Group();
    group.add(mesh);
    return group;
  }

  function skeletonOf(object: THREE.Object3D): THREE.Skeleton | null {
    let found: THREE.Skeleton | null = null;
    object.traverse((child) => {
      const mesh = child as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) found = mesh.skeleton;
    });
    return found;
  }

  it('gives each clone of a rigged model its own skeleton', () => {
    const model = skinnedModel();
    const a = cloneModel(model, true);
    const b = cloneModel(model, true);

    // The bug this exists to prevent: `Object3D.clone` shares the `Skeleton`, so every enemy in a
    // scene is driven by one set of bones and they all animate in lockstep.
    expect(skeletonOf(a)).not.toBe(skeletonOf(b));
    expect(skeletonOf(a)).not.toBe(skeletonOf(model));
    expect(skeletonOf(a)).not.toBeNull();
  });

  it('shares the skeleton when told the model is not rigged, which is the bug in miniature', () => {
    // Pinned deliberately: it documents *why* `skinned` has to be recorded in the manifest rather
    // than guessed. Passing `false` for a rigged model is exactly the wrong answer, and this shows
    // what the wrong answer produces.
    const model = skinnedModel();
    expect(skeletonOf(cloneModel(model, false))).toBe(skeletonOf(model));
  });

  it('clones an ordinary model', () => {
    const model = new THREE.Group();
    model.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    const copy = cloneModel(model, false);
    expect(copy).not.toBe(model);
    expect(copy.children).toHaveLength(1);
  });

  it('detects a skeleton, which is how the pipeline decides what to record', () => {
    expect(hasSkeleton(skinnedModel())).toBe(true);
    expect(hasSkeleton(new THREE.Mesh(new THREE.BoxGeometry()))).toBe(false);
  });
});
