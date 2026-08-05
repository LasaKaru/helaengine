import {
  AssetCategorySchema,
  type AssetCategory,
  type AssetManifestEntry,
} from '@helaengine/schema';
import { NotSignedIn, type CloudSession } from './cloudProjects';

/**
 * Assets a customer uploaded, over the API.
 *
 * The library panel does not want to know that some of its cards came from the curated manifest and
 * some from an organisation's own uploads — an asset is an asset, and the only difference a user
 * should feel is that they can delete one of them. So this ends at `toManifestEntry`, which turns a
 * row from the API into exactly the shape the manifest already holds — after which merging the two
 * is a map keyed on id, with the upload winning.
 *
 * The upload is two requests on purpose. The first asks the API for permission and gets back a
 * short-lived signed URL; the second sends the bytes to that URL and never touches the API's
 * authenticated path. That is the shape S3 and R2 presigned uploads have, which is what makes the
 * eventual move to one a change on the server rather than here.
 */

export interface CloudAsset {
  id: string;
  assetId: string;
  name: string;
  category: string;
  status: 'pending' | 'ready' | 'failed';
  failure: string | null;
  glbPath: string | null;
  thumbnailPath: string | null;
  polyCount: number | null;
  sizeBytes: number | null;
  /** Null for the curated library, which belongs to the product rather than to a customer. */
  organizationId: string | null;
  createdAt: string;
}

export class CloudAssets {
  readonly #session: CloudSession;

  constructor(session: CloudSession) {
    this.#session = session;
  }

  async list(): Promise<CloudAsset[]> {
    const body = await this.#call<{ assets: CloudAsset[] }>(
      'GET',
      `/orgs/${this.#session.organizationId}/assets`,
    );
    return body.assets;
  }

  /**
   * Uploads a `.glb` and returns the row it became.
   *
   * Returns rather than throws on a rejected file. A file the pipeline refused is not an error in
   * the editor — it is a fact about the file that the panel has to show next to it, and turning it
   * into an exception would mean the row and the reason arrive by different routes.
   */
  async upload(
    file: File,
    options: { assetId: string; name: string; category: AssetCategory },
  ): Promise<CloudAsset> {
    const granted = await this.#call<{
      asset: CloudAsset;
      upload: { url: string; maxBytes: number };
    }>('POST', `/orgs/${this.#session.organizationId}/assets`, {
      assetId: options.assetId,
      name: options.name,
      category: options.category,
    });

    if (file.size > granted.upload.maxBytes) {
      // Checked before the bytes are sent rather than after: the server would refuse it too, but
      // sending 30 MB to be told so wastes the upload the user is watching a bar for.
      throw new Error(
        `"${file.name}" is larger than ${Math.round(granted.upload.maxBytes / 1024 / 1024)} MB.`,
      );
    }

    const sent = await fetch(`${this.#session.origin}${granted.upload.url}`, {
      method: 'PUT',
      // No authorization header. The signature in the URL is the authorisation, which is the whole
      // point of a presigned upload.
      headers: { 'content-type': 'model/gltf-binary' },
      body: file,
    });

    const text = await sent.text();
    const parsed = (text ? JSON.parse(text) : {}) as { asset?: CloudAsset; error?: string };
    if (parsed.asset) return parsed.asset;
    throw new Error(parsed.error ?? `The upload failed (${sent.status}).`);
  }

  /**
   * The absolute URL a stored path is served from.
   *
   * One definition, used both to build manifest entries and to fetch bytes back when a project is
   * written to a `.hela` file. Two call sites concatenating the same strings is how one of them
   * ends up with a double slash nobody notices until a model fails to load.
   */
  assetUrl(storedPath: string): string {
    return `${this.#session.origin}/assets/${storedPath}`;
  }

  async remove(assetId: string): Promise<void> {
    await this.#call('DELETE', `/orgs/${this.#session.organizationId}/assets/${assetId}`);
  }

  /**
   * A row from the API, as a manifest entry.
   *
   * `glbPath` becomes absolute against the API origin, because the loader resolves a relative path
   * against the *export's* asset folder — where an uploaded asset does not live. The engine's
   * `joinUrl` passes an absolute URL through untouched, so this needs no loader change.
   */
  toManifestEntry(asset: CloudAsset): AssetManifestEntry | null {
    // A pending or failed asset has no bytes to draw, and a card that cannot be dropped is worse
    // than no card. The panel lists those separately, with their status.
    if (asset.status !== 'ready' || !asset.glbPath) return null;

    const category = AssetCategorySchema.safeParse(asset.category);
    return {
      id: asset.assetId,
      name: asset.name,
      // The server parses this too. Falling back rather than dropping the asset means a category
      // added on the server before it is added here degrades to "props" instead of vanishing.
      category: category.success ? category.data : 'props',
      tags: ['uploaded'],
      glbPath: this.assetUrl(asset.glbPath),
      ...(asset.thumbnailPath ? { thumbnailPath: this.assetUrl(asset.thumbnailPath) } : {}),
      defaultScale: [1, 1, 1],
      colliderType: 'box',
      ...(asset.polyCount === null ? {} : { polyCount: asset.polyCount }),
      bounds: [1, 1, 1],
      placeholderColor: '#7c8fa8',
    };
  }

  async #call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.#session.origin}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#session.token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`Could not reach the API at ${this.#session.origin}.`);
    }

    if (response.status === 401) throw new NotSignedIn();

    const text = await response.text();
    const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        String(parsed['error'] ?? `The API refused this request (${response.status}).`),
      );
    }
    return parsed as T;
  }
}

/**
 * An asset id from a filename.
 *
 * The id ends up in a storage key and in every scene that places the asset, so it is held to the
 * curated library's shape rather than to whatever the file was called. "Stone Statue (final v2).glb"
 * becomes `stone_statue_final_v2`; a name that survives none of that gets a generated suffix rather
 * than a rejection the user cannot act on.
 */
export function assetIdFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);

  if (slug.length >= 3) return slug;
  return `asset_${Math.random().toString(36).slice(2, 10)}`;
}
