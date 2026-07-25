import { describe, expect, it } from 'vitest';
import { SceneObjectSchema, type SceneObject } from '@helaengine/schema';
import {
  applyGroupDelta,
  IDENTITY_DELTA,
  normalizeAngle,
  selectionPivot,
  snapPosition,
} from './transform';

function object(id: string, position: [number, number, number]): SceneObject {
  return SceneObjectSchema.parse({ id, assetId: 'tree_pine_01', transform: { position } });
}

describe('selectionPivot', () => {
  it('is the origin for an empty selection', () => {
    expect(selectionPivot([])).toEqual([0, 0, 0]);
  });

  it('is the object itself for a single selection', () => {
    expect(selectionPivot([object('a', [3, 1, -2])])).toEqual([3, 1, -2]);
  });

  it('is the centroid for several', () => {
    const pivot = selectionPivot([object('a', [0, 0, 0]), object('b', [4, 2, -6])]);
    expect(pivot).toEqual([2, 1, -3]);
  });
});

describe('applyGroupDelta', () => {
  const group = [object('a', [-2, 0, 0]), object('b', [2, 0, 0])];
  const pivot: [number, number, number] = [0, 0, 0];

  it('changes nothing under the identity delta', () => {
    const result = applyGroupDelta(group, pivot, IDENTITY_DELTA);
    expect(result[0]!.transform.position).toEqual([-2, 0, 0]);
    expect(result[1]!.transform.position).toEqual([2, 0, 0]);
  });

  it('translates every object by the same amount', () => {
    const result = applyGroupDelta(group, pivot, { ...IDENTITY_DELTA, translation: [1, 2, 3] });
    expect(result[0]!.transform.position).toEqual([-1, 2, 3]);
    expect(result[1]!.transform.position).toEqual([3, 2, 3]);
  });

  it('rotates objects around the pivot, not in place', () => {
    // A 90-degree yaw should swing objects on the X axis round to the Z axis.
    const result = applyGroupDelta(group, pivot, { ...IDENTITY_DELTA, yaw: 90 });

    expect(result[0]!.transform.position[0]).toBeCloseTo(0, 3);
    expect(Math.abs(result[0]!.transform.position[2])).toBeCloseTo(2, 3);
    // ...and each object turns to face the same way.
    expect(result[0]!.transform.rotation[1]).toBe(90);
    expect(result[1]!.transform.rotation[1]).toBe(90);
  });

  it('scales spacing about the pivot as well as the objects themselves', () => {
    const result = applyGroupDelta(group, pivot, { ...IDENTITY_DELTA, scale: [2, 2, 2] });

    expect(result[0]!.transform.position).toEqual([-4, 0, 0]);
    expect(result[1]!.transform.position).toEqual([4, 0, 0]);
    expect(result[0]!.transform.scale).toEqual([2, 2, 2]);
  });

  it('scales about an off-origin pivot correctly', () => {
    const result = applyGroupDelta(group, [2, 0, 0], { ...IDENTITY_DELTA, scale: [2, 1, 1] });

    // The object sitting on the pivot must not move.
    expect(result[1]!.transform.position).toEqual([2, 0, 0]);
    expect(result[0]!.transform.position).toEqual([-6, 0, 0]);
  });

  it('composes rotation and translation in a predictable order', () => {
    const result = applyGroupDelta([object('a', [2, 0, 0])], pivot, {
      translation: [0, 5, 0],
      yaw: 90,
      scale: [1, 1, 1],
    });

    // Rotate about the pivot first, then translate — so height is unaffected by the yaw.
    expect(result[0]!.transform.position[1]).toBe(5);
    expect(Math.abs(result[0]!.transform.position[2])).toBeCloseTo(2, 3);
  });

  it('leaves an empty selection alone', () => {
    expect(applyGroupDelta([], pivot, { ...IDENTITY_DELTA, yaw: 45 })).toEqual([]);
  });
});

describe('normalizeAngle', () => {
  it('leaves angles inside the range alone', () => {
    expect(normalizeAngle(90)).toBe(90);
    expect(normalizeAngle(-90)).toBe(-90);
  });

  it('wraps past 180 to the negative side', () => {
    expect(normalizeAngle(270)).toBe(-90);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(450)).toBe(90);
  });

  it('handles large negative angles', () => {
    expect(normalizeAngle(-450)).toBe(-90);
  });
});

describe('snapPosition', () => {
  it('rounds X and Z but never Y', () => {
    expect(snapPosition([1.4, 2.7, -0.6], 1)).toEqual([1, 2.7, -1]);
  });

  it('honours a fractional grid', () => {
    expect(snapPosition([1.4, 0, 1.1], 0.5)).toEqual([1.5, 0, 1]);
  });

  it('falls back to 1m for a nonsense grid size', () => {
    expect(snapPosition([1.4, 0, 0], 0)).toEqual([1, 0, 0]);
  });
});
