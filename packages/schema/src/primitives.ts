import { z } from 'zod';

/** A finite 3-component vector. Rejects NaN/Infinity so bad math never reaches the renderer. */
export const Vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

export const HexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be a hex colour like #a0c8ff');
export type HexColor = z.infer<typeof HexColorSchema>;

/**
 * Object transform. Rotation is in DEGREES (XYZ euler order) — the editor's inspector shows
 * degrees, so the schema stores degrees and the engine converts once at instantiation.
 */
export const TransformSchema = z.object({
  position: Vec3Schema.default([0, 0, 0]),
  rotation: Vec3Schema.default([0, 0, 0]),
  scale: Vec3Schema.default([1, 1, 1]),
});
export type Transform = z.infer<typeof TransformSchema>;

/** Stable id shape shared by objects/assets — url-safe, human-readable in diffs. */
export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'ids may only contain letters, numbers and _ . : -');
export type Id = z.infer<typeof IdSchema>;

/**
 * An id, or the empty string meaning "not chosen yet".
 *
 * Authoring is a sequence of half-built states — a Destroy node exists for a moment before it is
 * told what to destroy, and on a fresh project there is nothing to point it at. Refusing the empty
 * string at the parse boundary would mean the editor could not save a scene mid-thought, so the
 * gap is legal to *store* and reported by `validateGraph` as an error that stops the graph running.
 * That is the same trade the rest of the document format makes: parse what the author can express,
 * refuse to run what cannot work.
 */
export const UnsetIdSchema = z.union([z.literal(''), IdSchema]);
