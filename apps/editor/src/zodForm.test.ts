import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PatrolParamsSchema } from '@helaengine/engine';
import { describeParams } from './zodForm';

describe('describeParams', () => {
  it('derives a full form from the patrol schema', () => {
    // The point of the sprint: a behaviour ships a schema and gets a UI, with no per-type code.
    const fields = describeParams(PatrolParamsSchema);

    expect(fields.map((field) => [field.key, field.kind])).toEqual([
      ['waypoints', 'vec3list'],
      ['speed', 'number'],
      ['mode', 'enum'],
      ['faceDirection', 'boolean'],
      ['waitSeconds', 'number'],
    ]);
  });

  it('carries numeric bounds through, so the UI can clamp', () => {
    const speed = describeParams(PatrolParamsSchema).find((field) => field.key === 'speed');
    expect(speed).toMatchObject({ min: 0, max: 50 });
  });

  it('carries enum options through', () => {
    const mode = describeParams(PatrolParamsSchema).find((field) => field.key === 'mode');
    expect(mode?.options).toEqual(['loop', 'pingPong']);
  });

  it('reports each default, so adding a behaviour starts from sensible values', () => {
    const fields = describeParams(PatrolParamsSchema);
    expect(fields.find((field) => field.key === 'speed')?.defaultValue).toBe(2);
    expect(fields.find((field) => field.key === 'faceDirection')?.defaultValue).toBe(true);
  });

  it('turns camelCase keys into readable labels', () => {
    const field = describeParams(PatrolParamsSchema).find((item) => item.key === 'waitSeconds');
    expect(field?.label).toBe('Wait seconds');
  });

  it('marks optional fields', () => {
    const fields = describeParams(z.object({ note: z.string().optional() }));
    expect(fields[0]).toMatchObject({ key: 'note', kind: 'string', optional: true });
  });

  it('recognises a single vec3', () => {
    const fields = describeParams(
      z.object({ target: z.tuple([z.number(), z.number(), z.number()]) }),
    );
    expect(fields[0]?.kind).toBe('vec3');
  });

  it('skips shapes it does not understand rather than guessing a control', () => {
    // A rendered-but-wrong control is worse than none: it looks like it works.
    const fields = describeParams(
      z.object({
        good: z.number(),
        weird: z.map(z.string(), z.number()),
        alsoWeird: z.union([z.number(), z.string()]),
      }),
    );
    expect(fields.map((field) => field.key)).toEqual(['good']);
  });

  it('returns nothing for a schema that is not an object', () => {
    expect(describeParams(z.string())).toEqual([]);
  });
});
