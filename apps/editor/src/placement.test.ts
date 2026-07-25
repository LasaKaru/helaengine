import { describe, expect, it } from 'vitest';
import { computePlacement, DEFAULT_PLACEMENT } from './placement';

const FLAT = { x: 0, y: 1, z: 0 };

describe('computePlacement', () => {
  it('uses the hit point verbatim when snapping is off', () => {
    const result = computePlacement({ x: 3.37, y: 0, z: -1.82 }, FLAT);
    expect(result.position).toEqual([3.37, 0, -1.82]);
    expect(result.rotation).toEqual([0, 0, 0]);
  });

  it('snaps X and Z to the grid', () => {
    const result = computePlacement({ x: 3.37, y: 0, z: -1.82 }, FLAT, {
      ...DEFAULT_PLACEMENT,
      snapToGrid: true,
      gridSize: 1,
    });
    expect(result.position).toEqual([3, 0, -2]);
  });

  it('honours a half-metre grid', () => {
    const result = computePlacement({ x: 3.37, y: 0, z: -1.82 }, FLAT, {
      ...DEFAULT_PLACEMENT,
      snapToGrid: true,
      gridSize: 0.5,
    });
    expect(result.position).toEqual([3.5, 0, -2]);
  });

  it('never snaps Y, so props stay on the ground they were dropped on', () => {
    // Snapping height would float objects above a hill or sink them into it.
    const result = computePlacement({ x: 0, y: 2.63, z: 0 }, FLAT, {
      ...DEFAULT_PLACEMENT,
      snapToGrid: true,
      gridSize: 1,
    });
    expect(result.position[1]).toBe(2.63);
  });

  it('falls back to a 1m grid if given a nonsense grid size', () => {
    const result = computePlacement({ x: 3.37, y: 0, z: 0 }, FLAT, {
      ...DEFAULT_PLACEMENT,
      snapToGrid: true,
      gridSize: 0,
    });
    expect(result.position[0]).toBe(3);
  });

  it('applies a random yaw when asked, and only yaw', () => {
    const result = computePlacement({ x: 0, y: 0, z: 0 }, FLAT, {
      ...DEFAULT_PLACEMENT,
      randomRotation: true,
      random: () => 0.25,
    });
    expect(result.rotation).toEqual([0, 90, 0]);
  });

  it('leaves rotation at zero when random rotation is off', () => {
    const result = computePlacement({ x: 0, y: 0, z: 0 }, FLAT, {
      ...DEFAULT_PLACEMENT,
      random: () => 0.9,
    });
    expect(result.rotation).toEqual([0, 0, 0]);
  });

  it('stays upright on a slope unless surface alignment is on', () => {
    const slope = { x: 0.5, y: 0.866, z: 0 };
    expect(computePlacement({ x: 0, y: 0, z: 0 }, slope).rotation).toEqual([0, 0, 0]);
  });

  it('tilts to match the surface when alignment is on', () => {
    // A normal 30 degrees off vertical, leaning towards +X.
    const slope = { x: 0.5, y: 0.866, z: 0 };
    const result = computePlacement({ x: 0, y: 0, z: 0 }, slope, {
      ...DEFAULT_PLACEMENT,
      alignToNormal: true,
    });

    expect(Math.hypot(result.rotation[0], result.rotation[2])).toBeCloseTo(30, 1);
    expect(result.rotation[1]).toBe(0);
  });

  it('does not tilt on flat ground even with alignment on', () => {
    const result = computePlacement({ x: 0, y: 0, z: 0 }, FLAT, {
      ...DEFAULT_PLACEMENT,
      alignToNormal: true,
    });
    expect(result.rotation[0]).toBeCloseTo(0, 6);
    expect(result.rotation[2]).toBeCloseTo(0, 6);
  });

  it('tolerates an unnormalised normal', () => {
    const result = computePlacement(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 7, z: 0 },
      {
        ...DEFAULT_PLACEMENT,
        alignToNormal: true,
      },
    );
    expect(result.rotation[0]).toBeCloseTo(0, 6);
  });

  it('rounds coordinates so saved documents stay readable', () => {
    const result = computePlacement({ x: 1 / 3, y: 2 / 3, z: 0 }, FLAT);
    expect(result.position).toEqual([0.3333, 0.6667, 0]);
  });
});
