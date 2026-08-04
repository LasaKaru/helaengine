import { z } from 'zod';
import { SmokeReportSchema } from './smoke.js';

/**
 * Sharing a build as a link rather than a zip.
 *
 * The contract is here, with everything else the editor, the engine and the services agree on, so
 * the share service validates uploads with the same schema the editor validated them against —
 * one definition, checked at both ends of the wire.
 */

/**
 * Who can reach a shared build.
 *
 * Three levels rather than a boolean, because "share" means three different things to people and
 * conflating them is how something private ends up indexed:
 *
 * - `public` — listed. Anyone can find it.
 * - `unlisted` — reachable only by its id, which is random and long. Not listed anywhere, not
 *   returned by any listing endpoint. This is the default, because the safe answer to "who should
 *   see this" is "whoever you send it to".
 * - `org` — reachable only with a shared token. A placeholder for real accounts, and named as one:
 *   Sprint 28 replaces it with actual organisation membership.
 */
export const VisibilitySchema = z.enum(['public', 'unlisted', 'org']);
export type Visibility = z.infer<typeof VisibilitySchema>;

/** One file of an uploaded build. Text or base64, never both. */
export const SharedFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(200)
      // No absolute paths and no traversal. Checked here rather than only at write time, because a
      // rule enforced in one place is a rule that stops being enforced when a second caller appears.
      .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), {
        message: 'a file path must be relative and must not contain ".."',
      }),
    text: z.string().optional(),
    base64: z.string().optional(),
  })
  .refine((file) => (file.text === undefined) !== (file.base64 === undefined), {
    message: 'a file is either text or base64, not both and not neither',
  });
export type SharedFile = z.infer<typeof SharedFileSchema>;

/**
 * What the editor sends to publish a build.
 *
 * The smoke report is **required**, and the service checks it rather than trusting it. That is the
 * gate reaching one step further: Sprint 26 stopped an unvalidated build being downloaded, and this
 * stops one being *hosted*, which is the more consequential of the two — a bad download is one
 * person's afternoon, a bad link is everyone they sent it to.
 */
export const PublishRequestSchema = z.object({
  sceneName: z.string().min(1).max(120),
  visibility: VisibilitySchema.default('unlisted'),
  report: SmokeReportSchema,
  files: z.array(SharedFileSchema).min(1).max(2_000),
});
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

/** What a shared build looks like once it exists. */
export const SharedBuildSchema = z.object({
  id: z.string().min(8),
  sceneName: z.string(),
  visibility: VisibilitySchema,
  createdAt: z.string(),
  sizeBytes: z.number().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  /** How many times the page has been opened. */
  plays: z.number().int().nonnegative().default(0),
  lastPlayedAt: z.string().nullable().default(null),
});
export type SharedBuild = z.infer<typeof SharedBuildSchema>;

export const PublishResponseSchema = z.object({
  build: SharedBuildSchema,
  /** Where to send somebody. Absolute, because it is going into a message. */
  url: z.string(),
});
export type PublishResponse = z.infer<typeof PublishResponseSchema>;

export function parsePublishRequest(value: unknown): PublishRequest {
  return PublishRequestSchema.parse(value);
}
