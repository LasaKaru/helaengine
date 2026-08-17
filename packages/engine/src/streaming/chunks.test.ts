import * as THREE from 'three';
import { streamingProblems } from '@helaengine/schema';
import { describe, expect, it } from 'vitest';
import { ChunkGrid } from './ChunkGrid.js';

/**
 * The spatial partition, as arithmetic.
 *
 * What a browser has to prove instead — that a draw distance actually removes triangles from the
 * frame — is in `apps/editor/e2e/streaming.spec.ts`. A grid that partitions the level perfectly and
 * is never consulted would pass everything here.
 */

const at = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x, 0, z);

describe('ChunkGrid', () => {
  it('files objects by the cell containing their origin', () => {
    const grid = new ChunkGrid(10);
    grid.add('a', at(1, 1), 0);
    grid.add('b', at(9, 9), 0);
    grid.add('c', at(11, 1), 0);

    expect(grid.chunkCount).toBe(2);
    expect(grid.objectCount).toBe(3);
    expect([...grid.objectsIn(ChunkGrid.keyFor(10, 1, 1))].sort()).toEqual(['a', 'b']);
    expect([...grid.objectsIn(ChunkGrid.keyFor(10, 11, 1))]).toEqual(['c']);
  });

  it('puts negative coordinates in their own cells rather than folding them onto positive ones', () => {
    // `Math.floor` rather than a truncating division, which is the bug this pins: `(-1 / 10) | 0`
    // is 0, so everything in the quadrant left of the origin would share a chunk with everything
    // right of it — and half the level would light up whenever the other half was in range.
    const grid = new ChunkGrid(10);
    grid.add('left', at(-5, 5), 0);
    grid.add('right', at(5, 5), 0);
    expect(grid.chunkCount).toBe(2);
  });

  it('measures distance horizontally', () => {
    /**
     * Including the camera's height would cull the ground beneath a camera looking straight down at
     * it, which is the top-down mode this engine ships. The grid is horizontal, so the test is too.
     */
    const grid = new ChunkGrid(10);
    grid.add('a', at(5, 5), 0);
    const key = ChunkGrid.keyFor(10, 5, 5);

    expect(grid.isWithin(key, new THREE.Vector3(5, 400, 5), 20)).toBe(true);
  });

  it('keeps a chunk while any part of it is inside the distance', () => {
    /**
     * The conservative half, and the one worth getting right. A chunk's centre can be outside the
     * distance while its near corner — and a large object standing in it — is well inside. Culling
     * on the centre alone is a building that vanishes as you walk towards it, which is far more
     * noticeable than the cost of drawing a chunk at the boundary.
     */
    const grid = new ChunkGrid(20);
    grid.add('tower', at(30, 0), 8);
    const key = ChunkGrid.keyFor(20, 30, 0);

    // Centre at 30m, half-diagonal ~14m, object radius 8m: still visible from 10m away.
    expect(grid.isWithin(key, at(0, 0), 10)).toBe(true);
    expect(grid.isWithin(key, at(0, 0), 1)).toBe(false);
  });

  it('never divides by zero, whatever size it is handed', () => {
    // The engine is driven by exported documents and by tests as well as by the editor's validated
    // field. A zero size divides by zero and files every object under a chunk named `NaN,NaN`.
    const grid = new ChunkGrid(0);
    grid.add('a', at(1, 1), 0);
    grid.add('b', at(900, 900), 0);
    expect(grid.chunkCount).toBe(2);
    expect([...grid.keys()].every((key) => !key.includes('NaN'))).toBe(true);

    // And the distance test still works, which is the half a key check misses: a zero cell size
    // multiplies every chunk's centre by zero, so the whole level collapses onto the origin and
    // everything is always in range. The keys look fine while nothing is ever culled.
    expect(grid.isWithin(ChunkGrid.keyFor(0, 900, 900), at(0, 0), 5)).toBe(false);
  });
});

describe('streamingProblems', () => {
  const streaming = (distance: number, size = 32) => ({ distance, size });

  it('says nothing at all when the distance is off', () => {
    expect(streamingProblems(streaming(0), null)).toEqual([]);
  });

  it('catches a draw distance shorter than the fog', () => {
    // The artefact this exists to prevent: objects vanishing in clear air, which an author reads as
    // a bug in the engine rather than as their own number.
    expect(streamingProblems(streaming(80), 200).join(' ')).toContain('vanish in clear air');
    expect(streamingProblems(streaming(300), 200)).toEqual([]);
  });

  it('catches a distance barely wider than one chunk', () => {
    expect(streamingProblems(streaming(40, 32), 20).join(' ')).toContain('appear and disappear');
  });
});
