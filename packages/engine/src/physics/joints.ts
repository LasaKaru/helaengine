import type { Joint } from '@helaengine/schema';
import type { RapierModule } from './rapier.js';

type JointData = ReturnType<RapierModule['JointData']['fixed']>;

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** A local anchor as Rapier wants it. */
function vec(value: readonly [number, number, number]): { x: number; y: number; z: number } {
  return { x: value[0], y: value[1], z: value[2] };
}

/**
 * A unit axis, falling back to Y when the document says zero.
 *
 * A zero axis is a legal `Vec3` and a meaningless hinge: Rapier normalises it, gets NaN, and the
 * two joined bodies leave the level at speed on the first step. Substituting Y keeps a mis-authored
 * joint boring rather than explosive, and the editor warns separately.
 */
function axis(value: readonly [number, number, number]): { x: number; y: number; z: number } {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length < 1e-6) return { x: 0, y: 1, z: 0 };
  return { x: value[0] / length, y: value[1] / length, z: value[2] / length };
}

/**
 * Turns a document joint into Rapier's description of one.
 *
 * Split out from `PhysicsWorld` so it can be tested without a world, and so the mapping from
 * vocabulary to solver lives in exactly one place — the alternative is a switch inside a method
 * that also does body lookup and bookkeeping, where a wrong axis argument is much harder to see.
 */
export function jointDataFor(rapier: RapierModule, joint: Joint): JointData {
  switch (joint.type) {
    case 'fixed':
      // Identity frames: the two bodies are welded in whatever relative pose they are already in,
      // which is what somebody who placed them by eye means by "weld these".
      return rapier.JointData.fixed(vec(joint.anchorA), IDENTITY, vec(joint.anchorB), IDENTITY);

    case 'hinge':
      return rapier.JointData.revolute(vec(joint.anchorA), vec(joint.anchorB), axis(joint.axis));

    case 'ball':
      return rapier.JointData.spherical(vec(joint.anchorA), vec(joint.anchorB));

    case 'slider':
      return rapier.JointData.prismatic(vec(joint.anchorA), vec(joint.anchorB), axis(joint.axis));

    case 'spring':
      return rapier.JointData.spring(
        joint.restLength,
        joint.stiffness,
        joint.damping,
        vec(joint.anchorA),
        vec(joint.anchorB),
      );

    case 'rope':
      return rapier.JointData.rope(joint.length, vec(joint.anchorA), vec(joint.anchorB));

    default: {
      // Without this arm a new joint type compiles clean and silently creates nothing — a feature
      // absent from every level built with it, found by a user rather than by the compiler.
      const unreachable: never = joint;
      void unreachable;
      throw new Error('unreachable joint type');
    }
  }
}

/** Whether a joint type carries a limit and a motor the runtime should apply after creation. */
export function jointIsDriveable(
  joint: Joint,
): joint is Extract<Joint, { type: 'hinge' | 'slider' }> {
  return joint.type === 'hinge' || joint.type === 'slider';
}

export type { JointData };
