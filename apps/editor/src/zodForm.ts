import { z } from 'zod';

export type FieldKind = 'number' | 'boolean' | 'string' | 'enum' | 'vec3' | 'vec3list';

export interface FieldDescriptor {
  key: string;
  label: string;
  kind: FieldKind;
  optional: boolean;
  defaultValue: unknown;
  /** For `number`. */
  min?: number;
  max?: number;
  /** For `enum`. */
  options?: string[];
}

/** `waitSeconds` -> `Wait seconds`. Sentence case, so a row of labels reads as prose. */
function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface Unwrapped {
  schema: z.ZodTypeAny;
  optional: boolean;
  defaultValue: unknown;
}

/** Peels off `.default()` and `.optional()` to reach the type underneath. */
function unwrap(schema: z.ZodTypeAny): Unwrapped {
  let current = schema;
  let optional = false;
  let defaultValue: unknown;

  for (;;) {
    if (current instanceof z.ZodDefault) {
      defaultValue = current._def.defaultValue();
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      optional = true;
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    return { schema: current, optional, defaultValue };
  }
}

function isVec3(schema: z.ZodTypeAny): boolean {
  return (
    schema instanceof z.ZodTuple &&
    schema._def.items.length === 3 &&
    schema._def.items.every((item: z.ZodTypeAny) => unwrap(item).schema instanceof z.ZodNumber)
  );
}

function numericBounds(schema: z.ZodNumber): { min?: number; max?: number } {
  const bounds: { min?: number; max?: number } = {};
  for (const check of schema._def.checks) {
    if (check.kind === 'min') bounds.min = check.value;
    if (check.kind === 'max') bounds.max = check.value;
  }
  return bounds;
}

/**
 * Turns a behaviour's Zod params schema into a list of form fields.
 *
 * This is what makes "add a behaviour, get a UI for it" true rather than aspirational: a new
 * behaviour ships a schema and the inspector renders it, with no per-type form code. The trade is
 * that only the shapes below are understood — a behaviour needing something else has to extend
 * this, and `describeParams` says so by returning nothing for that field rather than guessing.
 */
export function describeParams(schema: z.ZodTypeAny): FieldDescriptor[] {
  const { schema: root } = unwrap(schema);
  if (!(root instanceof z.ZodObject)) return [];

  const fields: FieldDescriptor[] = [];

  for (const [key, rawField] of Object.entries(root.shape as Record<string, z.ZodTypeAny>)) {
    const { schema: field, optional, defaultValue } = unwrap(rawField);
    const base = { key, label: humanize(key), optional, defaultValue };

    if (field instanceof z.ZodNumber) {
      fields.push({ ...base, kind: 'number', ...numericBounds(field) });
      continue;
    }
    if (field instanceof z.ZodBoolean) {
      fields.push({ ...base, kind: 'boolean' });
      continue;
    }
    if (field instanceof z.ZodEnum) {
      fields.push({ ...base, kind: 'enum', options: [...(field._def.values as string[])] });
      continue;
    }
    if (field instanceof z.ZodString) {
      fields.push({ ...base, kind: 'string' });
      continue;
    }
    if (isVec3(field)) {
      fields.push({ ...base, kind: 'vec3' });
      continue;
    }
    if (field instanceof z.ZodArray && isVec3(unwrap(field._def.type as z.ZodTypeAny).schema)) {
      fields.push({ ...base, kind: 'vec3list' });
      continue;
    }

    // Deliberately silent about shapes it does not handle: rendering a guessed control for an
    // unknown type is worse than rendering nothing, because it looks like it works.
  }

  return fields;
}
