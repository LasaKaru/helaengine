import { z } from 'zod';

/**
 * How the player sees the world.
 *
 * Three modes rather than a free-form camera description: a rig is code, and the document's job is
 * to pick one, not to describe one. Adding a fourth is a registered rig plus an entry here.
 */
export const CameraModeSchema = z.enum(['fps', 'tps', 'topdown']);
export type CameraMode = z.infer<typeof CameraModeSchema>;

export const MultiplayerConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxPlayers: z.number().int().min(2).max(64).default(4),
    /**
     * `coop` is the only mode the runtime implements (Sprint 20). The others are recorded so a
     * document can express the intent before the runtime catches up, and so the editor can show
     * them as coming rather than pretending they do not exist.
     */
    mode: z.enum(['coop', 'deathmatch', 'none']).default('none'),
  })
  .default({});
export type MultiplayerConfig = z.infer<typeof MultiplayerConfigSchema>;

/**
 * How the scene plays, as opposed to what is in it.
 *
 * Everything here is a property of the *game*, not of any object: which camera, how sensitive the
 * look is, whether the player may switch rigs at runtime. Separate from `player` because that
 * describes the character's body — height, speed, health — and these two answer different
 * questions even though they meet in the same controller.
 */
export const GameConfigSchema = z
  .object({
    cameraMode: CameraModeSchema.default('fps'),
    /** Whether the player may switch camera mode in-game. Authors of a fixed-perspective game say no. */
    allowModeSwitch: z.boolean().default(true),
    /** Vertical field of view in degrees. */
    fieldOfView: z.number().min(30).max(120).default(70),
    /** Look sensitivity multiplier. 1 is the engine default; the settings menu scales this. */
    lookSensitivity: z.number().min(0.05).max(10).default(1),
    /** Camera sway while walking in first person. Off for anyone prone to motion sickness. */
    headBob: z.boolean().default(true),
    /** Third-person camera distance behind the character, in metres. */
    thirdPersonDistance: z.number().min(1).max(30).default(5),
    /** Height of the top-down camera above the character, in metres. */
    topDownHeight: z.number().min(3).max(120).default(24),
    multiplayer: MultiplayerConfigSchema,
  })
  .default({});
export type GameConfig = z.infer<typeof GameConfigSchema>;
