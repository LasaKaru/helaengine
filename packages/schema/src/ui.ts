import { z } from 'zod';
import { HexColorSchema, IdSchema } from './primitives.js';

/**
 * What a menu button can do.
 *
 * A closed vocabulary, for the third time in this codebase and for the same reason: a document
 * describes which of a fixed set of things happens, never how it happens. A button whose action
 * were a snippet of script would be a hole in the export guarantee drilled straight through the
 * friendliest-looking part of the product.
 */
export const UiActionSchema = z.enum([
  'startGame',
  'resume',
  'restartCheckpoint',
  'openSettings',
  'closeSettings',
  'mainMenu',
  'quit',
]);
export type UiAction = z.infer<typeof UiActionSchema>;

export const UiButtonSchema = z.object({
  label: z.string().min(1).max(64),
  action: UiActionSchema,
});
export type UiButton = z.infer<typeof UiButtonSchema>;

/**
 * The look of every menu at once.
 *
 * A preset plus two overrides rather than per-element styling: the point of a theme is that
 * changing it restyles everything, and a system where each button carries its own colours is not a
 * theme, it is a stylesheet with extra steps.
 */
export const UiThemeSchema = z
  .object({
    preset: z.enum(['midnight', 'parchment', 'neon', 'mono']).default('midnight'),
    /** Overrides the preset's accent. Buttons, focus rings and the health bar follow it. */
    primaryColor: HexColorSchema.optional(),
    /** CSS font stack. Left off, the preset picks one. */
    fontFamily: z.string().max(200).optional(),
    panelStyle: z.enum(['solid', 'glass', 'outline']).default('glass'),
  })
  .default({});
export type UiTheme = z.infer<typeof UiThemeSchema>;

export const HomeScreenSchema = z
  .object({
    title: z.string().max(120).default('My Game'),
    subtitle: z.string().max(200).default(''),
    playButtonText: z.string().min(1).max(40).default('Play'),
    backgroundImageAssetId: IdSchema.nullable().default(null),
    /** Plays once before the menu appears. Muted at first, per browser autoplay policy. */
    introVideoAssetId: IdSchema.nullable().default(null),
    /** Whether the intro can be skipped. Almost always yes; nobody watches it twice. */
    introSkippable: z.boolean().default(true),
  })
  .default({});
export type HomeScreen = z.infer<typeof HomeScreenSchema>;

/**
 * A text or image the author pinned to the HUD.
 *
 * `bind` names a runtime value rather than an expression — the same rule as everywhere else. The
 * set is small on purpose and grows by adding a name here, not by letting documents compute.
 */
export const HudElementSchema = z.object({
  id: IdSchema,
  kind: z.enum(['text', 'image']),
  /** Literal text, or the asset id of an image. */
  value: z.string().max(200).default(''),
  /** Runtime value to show instead of `value`, for text elements. */
  bind: z.enum(['none', 'health', 'ammo', 'score', 'timer']).default('none'),
  anchor: z
    .enum(['topLeft', 'topCenter', 'topRight', 'bottomLeft', 'bottomCenter', 'bottomRight'])
    .default('topLeft'),
  /** Offset from the anchor, in pixels. */
  offset: z.tuple([z.number(), z.number()]).default([16, 16]),
  fontSize: z.number().min(8).max(96).default(16),
});
export type HudElement = z.infer<typeof HudElementSchema>;

export const HudSchema = z
  .object({
    showHealthBar: z.boolean().default(true),
    showAmmoCounter: z.boolean().default(false),
    showCrosshair: z.boolean().default(true),
    /** Not implemented yet — Sprint 15 builds it. Recorded so a document can already say so. */
    showMinimap: z.boolean().default(false),
    customElements: z.array(HudElementSchema).max(24).default([]),
  })
  .default({});
export type Hud = z.infer<typeof HudSchema>;

const MenuSchema = z.object({ buttons: z.array(UiButtonSchema).max(12) });

/**
 * The game's shell: everything the player sees that is not the world.
 *
 * Data, not code, and rendered by a `UIRenderer` that stands in the same relation to `uiConfig` as
 * `SceneLoader` does to the scene. That symmetry is deliberate — it is what lets an exported build
 * ship a complete game rather than a viewport.
 */
export const UiConfigSchema = z
  .object({
    /** Whether the shell appears at all. Off means the preview drops straight into the world. */
    enabled: z.boolean().default(true),
    homeScreen: HomeScreenSchema,
    mainMenu: MenuSchema.default({
      buttons: [
        { label: 'Play', action: 'startGame' },
        { label: 'Settings', action: 'openSettings' },
      ],
    }),
    pauseMenu: MenuSchema.default({
      buttons: [
        { label: 'Resume', action: 'resume' },
        { label: 'Restart from checkpoint', action: 'restartCheckpoint' },
        // Settings belongs here as well as on the home screen: a player who wants the volume down
        // mid-game should not have to abandon their run to reach it.
        { label: 'Settings', action: 'openSettings' },
        { label: 'Main menu', action: 'mainMenu' },
        { label: 'Quit', action: 'quit' },
      ],
    }),
    hud: HudSchema,
    theme: UiThemeSchema,
  })
  .default({});
export type UiConfig = z.infer<typeof UiConfigSchema>;
