import {
  PublishResponseSchema,
  type PublishRequest,
  type PublishResponse,
  type SmokeReport,
  type Visibility,
} from '@helaengine/schema';
import type { ExportPlan } from '@helaengine/export';

/**
 * Uploads an already-validated build to the share service.
 *
 * The same `ExportPlan` the zip is built from, sent as JSON instead of compressed. That is the
 * point of `buildExport` being a pure function from a scene to a list of files: "download it" and
 * "host it" are two things to do with one plan, not two pipelines that have to be kept in step.
 *
 * The report travels with it and the service re-checks it. The editor has already refused to share
 * a build that did not pass, but a rule enforced only in a browser tab is not enforced.
 */

/** Where the share service lives. Configurable, because it is a separate deployable. */
export const SHARE_ORIGIN = import.meta.env['VITE_SHARE_ORIGIN'] ?? 'http://localhost:4000';

export class ShareFailed extends Error {}

export async function publishBuild(input: {
  plan: ExportPlan;
  sceneName: string;
  report: SmokeReport;
  visibility: Visibility;
  origin?: string;
}): Promise<PublishResponse> {
  const origin = input.origin ?? SHARE_ORIGIN;

  const request: PublishRequest = {
    sceneName: input.sceneName,
    visibility: input.visibility,
    report: input.report,
    files: input.plan.files.map((file) =>
      file.bytes === undefined
        ? { path: file.path, text: file.text ?? '' }
        : { path: file.path, base64: toBase64(file.bytes) },
    ),
  };

  let response: Response;
  try {
    response = await fetch(`${origin}/api/builds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    // `fetch` rejects identically for "nothing is listening" and "the browser blocked it", so the
    // message names both. An earlier version asserted the service was down, and said so confidently
    // while it was running perfectly and answering everything except a CORS preflight.
    throw new ShareFailed(
      `Could not reach the share service at ${origin} — it may not be running, or it may not be ` +
        `allowing requests from this editor. Start it with ` +
        `\`pnpm --filter @helaengine/share start\`, or set VITE_SHARE_ORIGIN to where it is running.`,
    );
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ShareFailed(
      body.error ?? `The share service refused this build (${response.status}).`,
    );
  }

  return PublishResponseSchema.parse(await response.json());
}

/**
 * Bytes to base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a 3 MB engine bundle blows the argument limit and throws
 * `RangeError: Maximum call stack size exceeded` — which reads like a bug in the exporter rather
 * than in the encoding, and cost an afternoon somewhere else once.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}
