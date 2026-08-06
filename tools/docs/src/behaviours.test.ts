import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  describeConstraints,
  describeType,
  documentBehaviours,
  documentParams,
  renderMarkdown,
} from './behaviours.js';

/**
 * Sprint 38 — the behaviour reference generator.
 *
 * These exist because the generator reads Zod's `_def` internals, which are not a public API. That
 * is a deliberate trade — the alternative is a hand-written reference that goes subtly wrong the
 * third time somebody adds a parameter — but a trade taken knowingly needs a tripwire. If a Zod
 * upgrade changes the shape of `_def`, these fail loudly here rather than quietly emitting a page
 * full of `unknown`.
 */

describe('reading a type out of a schema', () => {
  it('names the primitives', () => {
    expect(describeType(z.string())).toBe('string');
    expect(describeType(z.number())).toBe('number');
    expect(describeType(z.boolean())).toBe('boolean');
  });

  it('spells out an enum, because the values are the documentation', () => {
    // `"box" | "sphere"` tells a reader what to type. `enum` does not.
    expect(describeType(z.enum(['box', 'sphere']))).toBe('"box" | "sphere"');
  });

  it('describes arrays and tuples by what they hold', () => {
    expect(describeType(z.array(z.number()))).toBe('number[]');
    expect(describeType(z.tuple([z.number(), z.number(), z.number()]))).toBe(
      '[number, number, number]',
    );
  });

  it('falls back to a name rather than throwing on something it does not know', () => {
    // Totality matters more than completeness here: an unfamiliar type should cost one vague row,
    // not the whole page.
    expect(describeType(z.map(z.string(), z.number()))).toBe('map');
  });
});

describe('reading constraints', () => {
  it('turns ranges into phrases a person reads', () => {
    expect(describeConstraints(z.number().min(1).max(200))).toEqual(['at least 1', 'at most 200']);
  });

  it('says nothing when there is nothing to say', () => {
    expect(describeConstraints(z.boolean())).toEqual([]);
  });
});

describe('documenting parameters', () => {
  it('unwraps defaults and reports them as the default rather than as a type', () => {
    const [param] = documentParams(z.object({ speed: z.number().min(0.5).default(4) }));

    expect(param).toMatchObject({
      name: 'speed',
      type: 'number',
      defaultValue: '4',
      optional: true,
      constraints: ['at least 0.5'],
    });
  });

  it('marks a parameter with no default as required', () => {
    const [param] = documentParams(z.object({ target: z.string() }));
    expect(param?.optional).toBe(false);
    expect(param?.defaultValue).toBeUndefined();
  });

  it('unwraps an optional wrapped around a default, in either order', () => {
    // Both orders occur in real schemas and they mean the same thing to a reader.
    const [a] = documentParams(z.object({ x: z.number().default(2).optional() }));
    const [b] = documentParams(z.object({ x: z.number().optional().default(2) }));

    expect(a?.type).toBe('number');
    expect(b?.type).toBe('number');
    expect(b?.defaultValue).toBe('2');
  });

  it('carries a describe() through to the notes column', () => {
    const [param] = documentParams(
      z.object({ radius: z.number().default(3).describe('How close counts as arrived.') }),
    );
    expect(param?.description).toBe('How close counts as arrived.');
  });

  it('returns nothing for a schema that is not an object, instead of throwing', () => {
    expect(documentParams(z.string())).toEqual([]);
  });
});

describe('the rendered page', () => {
  const rendered = renderMarkdown(
    documentBehaviours([
      {
        type: 'chaseOnSight',
        label: 'Chase on sight',
        description: 'Chases the player when it sees them.',
        params: z.object({
          sightRange: z.number().min(1).max(200).default(18),
          despawnOnDeath: z.boolean().default(true),
        }),
      },
      {
        type: 'aardvark',
        label: 'Aardvark',
        description: 'Sorts first, to prove the ordering.',
        params: z.object({}),
      },
    ]),
  );

  it('orders behaviours by type so the page is stable between runs', () => {
    // A generated file that reshuffles produces a diff on every run and stops being reviewable.
    expect(rendered.indexOf('## aardvark')).toBeLessThan(rendered.indexOf('## chaseOnSight'));
  });

  it('documents every parameter with its default', () => {
    expect(rendered).toContain('`sightRange`');
    expect(rendered).toContain('`18`');
    expect(rendered).toContain('at least 1; at most 200');
  });

  it('says so plainly when a behaviour takes no parameters', () => {
    expect(rendered).toContain('Takes no parameters.');
  });

  it('builds an example from the schema, so the example is always valid', () => {
    expect(rendered).toContain('"type": "chaseOnSight"');
    expect(rendered).toContain('"sightRange": 18');
  });

  it('warns against editing it by hand', () => {
    expect(rendered).toContain('Do not edit by hand');
  });
});
