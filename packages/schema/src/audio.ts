import { z } from 'zod';
import { IdSchema } from './primitives.js';
import { EventNameSchema } from './trigger.js';

/**
 * What the music is doing.
 *
 * Three states rather than a track per situation: menus, ordinary play, and a fight. That is the
 * smallest set that reads as *responsive* music, and every extra state is another transition to get
 * right. A scene that only supplies one track simply never crossfades.
 */
export const MusicStateSchema = z.enum(['menu', 'explore', 'combat']);
export type MusicState = z.infer<typeof MusicStateSchema>;

export const MusicSchema = z
  .object({
    menuTrackAssetId: IdSchema.nullable().default(null),
    exploreTrackAssetId: IdSchema.nullable().default(null),
    combatTrackAssetId: IdSchema.nullable().default(null),
    /** Seconds of overlap when the state changes. Zero cuts rather than fades. */
    crossfadeSeconds: z.number().min(0).max(10).default(1.5),
    /**
     * Seconds of quiet after the last enemy loses interest before the music leaves combat.
     *
     * Without it the track flickers between explore and combat every time an enemy blinks, which is
     * more distracting than having no combat track at all.
     */
    combatHoldSeconds: z.number().min(0).max(60).default(6),
  })
  .default({});
export type Music = z.infer<typeof MusicSchema>;

/**
 * A sound bound to something that happens.
 *
 * A list of bindings rather than a fixed `onDamage` / `onPickup` map, because the event bus is
 * already the thing everything in this engine talks through: a behaviour's `sfxEvent`, a trigger's
 * `emit` action and a weapon's `weaponFired` are all just names, and any of them should be able to
 * make a noise without the schema growing a field per case.
 *
 * It is still a closed vocabulary in the sense that matters: a binding names an event and an asset.
 * There is nothing here to evaluate.
 */
export const SfxBindingSchema = z.object({
  event: EventNameSchema,
  assetId: IdSchema,
  volume: z.number().min(0).max(1).default(1),
  /**
   * Play it in the world at the object that raised it, rather than flat in both ears.
   *
   * Only meaningful when the event's payload carries an `objectId`; otherwise it falls back to
   * non-positional, which is the honest thing to do with a sound that has no location.
   */
  positional: z.boolean().default(false),
  /** Metres beyond which it is inaudible. Positional sounds only. */
  maxDistance: z.number().min(1).max(500).default(40),
  /**
   * Ceiling on plays per second.
   *
   * Twenty enemies dying in one frame is twenty identical samples starting together, which is not
   * twenty times louder so much as one loud click.
   */
  maxPerSecond: z.number().min(1).max(60).default(8),
});
export type SfxBinding = z.infer<typeof SfxBindingSchema>;

/**
 * A looping bed of sound: wind, birds, water, the hum of a cave.
 *
 * Separate from music because it answers a different question. Music is a *state* — menu, explore,
 * combat — and exactly one plays at a time; ambience is a *place*, and several layers stack, which
 * is how a river in a forest sounds like both at once.
 *
 * Separate from sfx because those are triggered by events and these never stop. Folding either pair
 * together would mean one system with two mutually exclusive halves.
 */
export const AmbienceLayerSchema = z.object({
  assetId: IdSchema,
  volume: z.number().min(0).max(1).default(0.5),
  /**
   * Ties the volume to the wind.
   *
   * At zero the layer plays at `volume` regardless. At one it is silent in still air and reaches
   * `volume` in a gale. This is the one place the audio and the renderer share a setting, and it is
   * worth the coupling: wind you can see but not hear reads as a rendering trick, and a howling
   * gale over motionless grass reads as a broken level.
   */
  followWind: z.number().min(0).max(1).default(0),
});
export type AmbienceLayer = z.infer<typeof AmbienceLayerSchema>;

/**
 * The volume a layer should actually play at.
 *
 * `windStrength` is in metres of lean, and `WindSchema` caps it at four — so a quarter of it is the
 * fraction used here. Kept as a function rather than computed in the runtime because the editor
 * shows the same number, and two implementations of "how loud is this really" would disagree the
 * first time either changed.
 */
export function ambienceVolume(layer: AmbienceLayer, windStrength: number): number {
  if (layer.followWind <= 0) return layer.volume;
  const gale = Math.min(1, Math.max(0, windStrength / 4));
  return layer.volume * (1 - layer.followWind + layer.followWind * gale);
}

export const AudioConfigSchema = z
  .object({
    music: MusicSchema,
    sfx: z.array(SfxBindingSchema).max(48).default([]),
    /**
     * Looping beds, played together.
     *
     * Empty by default, so every scene saved before ambience existed parses unchanged and is as
     * silent as it was.
     */
    ambience: z.array(AmbienceLayerSchema).max(6).default([]),
    ambienceVolume: z.number().min(0).max(1).default(0.7),
    /** Author-set defaults. The player's own mixer settings ride on top and are not saved here. */
    masterVolume: z.number().min(0).max(1).default(1),
    musicVolume: z.number().min(0).max(1).default(0.6),
    sfxVolume: z.number().min(0).max(1).default(1),
  })
  .default({});
export type AudioConfig = z.infer<typeof AudioConfigSchema>;
/**
 * The shape an author *writes*, before defaults are filled in.
 *
 * Useful anywhere a config is constructed rather than parsed — a scene template, a fixture — where
 * spelling out `maxPerSecond` on every binding would be noise rather than clarity.
 */
export type AudioConfigInput = z.input<typeof AudioConfigSchema>;

/**
 * The player's own mixer settings.
 *
 * Kept out of the scene document on purpose: how loud somebody likes their music is a property of
 * that person, not of the level, and writing it into `scene.json` would mean one player's
 * preference travelling to everyone the project is exported to.
 */
export const MixerSettingsSchema = z.object({
  master: z.number().min(0).max(1).default(1),
  music: z.number().min(0).max(1).default(1),
  sfx: z.number().min(0).max(1).default(1),
});
export type MixerSettings = z.infer<typeof MixerSettingsSchema>;
