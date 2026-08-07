import { z } from 'zod';
import type { Environment } from './environment.js';

/**
 * Two named starting points for how a level looks.
 *
 * ## Why this is a button and not a mode
 *
 * A stored `look: 'realistic'` field would be a second source of truth about lighting, and it would
 * lose an argument with the panel the first time somebody nudged the exposure: either the preset
 * silently stops applying, or it fights the manual edit on every reload. Neither is a thing to
 * explain to a user.
 *
 * So a look is a *set of settings that gets written into the document*, once, when the button is
 * pressed. Afterwards every field is an ordinary field with an ordinary value, editable and
 * undoable like any other. Pressing the button again re-applies it; nothing watches it.
 *
 * ## What "realistic" honestly means here
 *
 * Filmic tone mapping, a darker ambient with the fill coming from a sky-and-ground hemisphere
 * rather than a flat wash, higher-resolution shadows over a shorter distance, and a restrained
 * grade. That is a lighting-and-grade preset. It is not a different renderer, and it will not turn
 * flat-shaded low-poly models into photographs — the shipped models carry no roughness or metalness
 * maps, and no preset can invent them.
 *
 * What it does do is the thing that actually separates "a browser toy" from "a game": stop
 * everything being uniformly lit. Most of the difference in a low-poly scene comes from contrast
 * between a warm key light and a cool fill, and that is exactly what these numbers are.
 */

export const LOOKS = ['stylized', 'realistic'] as const;
export const LookSchema = z.enum(LOOKS);
export type Look = z.infer<typeof LookSchema>;

export const LOOK_LABEL: Readonly<Record<Look, string>> = {
  stylized: 'Stylised',
  realistic: 'Realistic',
};

export const LOOK_DESCRIPTION: Readonly<Record<Look, string>> = {
  stylized:
    'Flat, bright and even. Colours come out exactly as the models define them. The cheapest to draw.',
  realistic:
    'Filmic tone mapping, a warm sun against a cool sky fill, sharper shadows and a light grade. ' +
    'Costs two extra full-screen passes.',
};

/**
 * The settings a look writes.
 *
 * Returns a whole `Environment` rather than a patch, because half of what makes a look is what it
 * turns *off*: applying "stylised" over "realistic" has to clear the bloom and the vignette, and a
 * patch that only ever adds would leave a filmic grade sitting under a flat look.
 *
 * Everything not to do with lighting — background, fog, wind — is carried through untouched. Those
 * are decisions about this particular level, not about how it is lit.
 */
export function applyLook(environment: Environment, look: Look): Environment {
  if (look === 'stylized') {
    return {
      ...environment,
      toneMapping: 'none',
      exposure: 1,
      lighting: {
        ...environment.lighting,
        sun: { ...environment.lighting.sun, color: '#ffffff', intensity: 1.2 },
        ambient: 0.4,
        ambientColor: '#ffffff',
        // A flat look wants one even fill, not a directional one.
        hemisphere: null,
        shadows: { ...environment.lighting.shadows, quality: 'medium', distance: 200 },
      },
      postProcessing: {
        ...environment.postProcessing,
        enabled: false,
        bloom: { ...environment.postProcessing.bloom, enabled: false },
        vignette: { ...environment.postProcessing.vignette, enabled: false },
        colorGrade: { ...environment.postProcessing.colorGrade, enabled: false },
      },
    };
  }

  return {
    ...environment,
    // Filmic: brings highlights back into range on a curve instead of clipping them, which is what
    // stops a lit scene looking like a screenshot with the brightness turned up.
    toneMapping: 'aces',
    // ACES darkens the midtones, so the exposure comes up to compensate. Matched by eye against the
    // stylised look so pressing the button does not just dim the level.
    exposure: 1.15,
    lighting: {
      ...environment.lighting,
      // Warm key.
      // Colour and intensity only. Elevation and azimuth are the time of day, which is a decision
      // about this level rather than about how it is lit — a preset that moved the sun would swing
      // every shadow in the scene, and stylised has no business moving it back.
      sun: { ...environment.lighting.sun, color: '#fff2dc', intensity: 2.1 },
      // Low flat ambient: the fill comes from the hemisphere below instead, which is directional
      // and therefore actually shades things. A high flat ambient is what makes a scene look
      // uniformly lit, and uniformly lit is the single strongest "this is a toy" signal.
      ambient: 0.12,
      ambientColor: '#c8d8ff',
      // Cool sky above, warm bounce from the ground. The cheapest approximation of bounced light
      // there is, and at low-poly densities it does more than any amount of shadow tuning.
      hemisphere: { skyColor: '#8fb4ff', groundColor: '#6b5a3e', intensity: 0.9 },
      // Sharper, over a shorter distance. The whole map is stretched across `distance`, so halving
      // it is worth more than doubling the resolution.
      shadows: { ...environment.lighting.shadows, quality: 'high', distance: 120 },
    },
    postProcessing: {
      ...environment.postProcessing,
      enabled: true,
      // A high threshold, so only genuinely bright things glow. Low thresholds bloom the whole
      // image, which reads as fog on the lens rather than as light.
      bloom: { enabled: true, threshold: 0.9, strength: 0.35, radius: 0.4 },
      vignette: { enabled: true, strength: 0.3, offset: 0.55 },
      colorGrade: {
        enabled: true,
        brightness: 0,
        contrast: 0.12,
        // Slightly *down*: filmic tone mapping already saturates, and pushing it further is how a
        // scene ends up looking like a phone camera's beach mode.
        saturation: -0.05,
        tint: '#ffffff',
      },
    },
  };
}
