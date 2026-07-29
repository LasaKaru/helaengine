import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  FirstPersonRig,
  ThirdPersonRig,
  TopDownRig,
  createCameraRig,
  lookDirection,
  nextCameraMode,
  type CameraRigContext,
  type CameraTarget,
} from './CameraRig.js';

function camera(): THREE.PerspectiveCamera {
  return new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 1000);
}

function target(overrides: Partial<CameraTarget> = {}): CameraTarget {
  return {
    position: new THREE.Vector3(0, 0, 0),
    eyeHeight: 1.65,
    speed: 0,
    grounded: true,
    ...overrides,
  };
}

const context: CameraRigContext = {
  fieldOfView: 70,
  distance: 5,
  height: 24,
  headBob: false,
};

describe('lookDirection', () => {
  it('faces -Z at yaw zero, matching an unrotated camera', () => {
    const direction = lookDirection({ yaw: 0, pitch: 0 }, new THREE.Vector3());
    expect(direction.x).toBeCloseTo(0, 6);
    expect(direction.z).toBeCloseTo(-1, 6);
  });

  it('turns right as yaw decreases', () => {
    const direction = lookDirection({ yaw: -Math.PI / 2, pitch: 0 }, new THREE.Vector3());
    expect(direction.x).toBeCloseTo(1, 6);
  });

  it('looks up as pitch increases', () => {
    const direction = lookDirection({ yaw: 0, pitch: Math.PI / 4 }, new THREE.Vector3());
    expect(direction.y).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

describe('FirstPersonRig', () => {
  it('puts the camera at eye height above the feet', () => {
    const rig = new FirstPersonRig();
    const view = camera();

    rig.update(
      view,
      target({ position: new THREE.Vector3(3, 2, -4) }),
      { yaw: 0, pitch: 0 },
      1 / 60,
      context,
    );

    expect(view.position.toArray()).toEqual([3, 3.65, -4]);
  });

  it('applies the document field of view', () => {
    const view = camera();
    new FirstPersonRig().update(view, target(), { yaw: 0, pitch: 0 }, 1 / 60, context);
    expect(view.fov).toBe(70);
  });

  it('bobs while walking and holds still when standing', () => {
    const rig = new FirstPersonRig();
    const view = camera();
    const bobbing = { ...context, headBob: true };

    const heights: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      rig.update(view, target({ speed: 5 }), { yaw: 0, pitch: 0 }, 1 / 60, bobbing);
      heights.push(view.position.y);
    }
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.01);

    rig.reset();
    const still: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      rig.update(view, target({ speed: 0 }), { yaw: 0, pitch: 0 }, 1 / 60, bobbing);
      still.push(view.position.y);
    }
    expect(Math.max(...still) - Math.min(...still)).toBe(0);
  });

  it('does not bob in mid-air — there is no footfall to bob to', () => {
    const rig = new FirstPersonRig();
    const view = camera();
    const bobbing = { ...context, headBob: true };

    const heights: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      rig.update(
        view,
        target({ speed: 6, grounded: false }),
        { yaw: 0, pitch: 0 },
        1 / 60,
        bobbing,
      );
      heights.push(view.position.y);
    }

    expect(Math.max(...heights) - Math.min(...heights)).toBe(0);
  });

  it('respects the head-bob setting being off', () => {
    const rig = new FirstPersonRig();
    const view = camera();
    const heights: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      rig.update(view, target({ speed: 6 }), { yaw: 0, pitch: 0 }, 1 / 60, context);
      heights.push(view.position.y);
    }
    expect(Math.max(...heights) - Math.min(...heights)).toBe(0);
  });
});

describe('ThirdPersonRig', () => {
  it('sits the full distance behind the character when nothing is in the way', () => {
    const rig = new ThirdPersonRig();
    const view = camera();

    rig.update(view, target(), { yaw: 0, pitch: 0 }, 1 / 60, context);

    // Facing -Z, so the camera is 5m out on +Z, at head height.
    expect(view.position.z).toBeCloseTo(5, 3);
    expect(view.position.y).toBeCloseTo(1.65, 3);
  });

  it('pulls in immediately when a wall gets between it and the character', () => {
    const rig = new ThirdPersonRig();
    const view = camera();
    const blocked: CameraRigContext = { ...context, probe: () => 2 };

    rig.update(view, target(), { yaw: 0, pitch: 0 }, 1 / 60, blocked);

    // A slow pull-in would mean a frame or two of looking at the inside of a wall.
    expect(view.position.z).toBeCloseTo(1.75, 2);
  });

  it('eases back out once the way clears, rather than snapping', () => {
    const rig = new ThirdPersonRig();
    const view = camera();
    rig.update(view, target(), { yaw: 0, pitch: 0 }, 1 / 60, { ...context, probe: () => 1.5 });
    const pulled = view.position.z;

    rig.update(view, target(), { yaw: 0, pitch: 0 }, 1 / 60, context);
    const afterOneFrame = view.position.z;

    expect(afterOneFrame).toBeGreaterThan(pulled);
    expect(afterOneFrame).toBeLessThan(5);
  });

  it('never ends up inside the character', () => {
    const rig = new ThirdPersonRig();
    const view = camera();
    rig.update(view, target(), { yaw: 0, pitch: 0 }, 1 / 60, { ...context, probe: () => 0 });

    expect(view.position.distanceTo(new THREE.Vector3(0, 1.65, 0))).toBeGreaterThanOrEqual(0.4);
  });

  it('orbits with yaw', () => {
    const rig = new ThirdPersonRig();
    const view = camera();
    rig.update(view, target(), { yaw: Math.PI / 2, pitch: 0 }, 1 / 60, context);

    expect(view.position.x).toBeCloseTo(5, 2);
    expect(Math.abs(view.position.z)).toBeLessThan(0.01);
  });
});

describe('TopDownRig', () => {
  it('looks straight down from the configured height', () => {
    const view = camera();
    new TopDownRig().update(view, target(), { yaw: 0, pitch: 0 }, 1 / 60, context);

    expect(view.position.y).toBeCloseTo(24, 3);
    expect(view.position.x).toBeCloseTo(0, 3);
  });

  it('ignores pitch, because a tilting top-down camera is not top-down', () => {
    const view = camera();
    const rig = new TopDownRig();
    rig.update(view, target(), { yaw: 0, pitch: 0 }, 1 / 60, context);
    const level = view.position.clone();

    rig.update(view, target(), { yaw: 0, pitch: 1.2 }, 1 / 60, context);

    expect(view.position.toArray()).toEqual(level.toArray());
  });
});

describe('rig selection', () => {
  it('builds the rig the document asks for', () => {
    expect(createCameraRig('fps').mode).toBe('fps');
    expect(createCameraRig('tps').mode).toBe('tps');
    expect(createCameraRig('topdown').mode).toBe('topdown');
  });

  it('cycles through every mode and comes back', () => {
    expect(nextCameraMode('fps')).toBe('tps');
    expect(nextCameraMode('tps')).toBe('topdown');
    expect(nextCameraMode('topdown')).toBe('fps');
  });
});
