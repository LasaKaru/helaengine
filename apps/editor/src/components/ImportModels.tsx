import { useRef, useState } from 'react';
import { AssetCategorySchema, type AssetCategory } from '@helaengine/schema';
import {
  deleteLocalAsset,
  importLocalAsset,
  LocalAssetError,
  MAX_LOCAL_ASSET_BYTES,
} from '../storage/localAssets';
import type { StoredLocalAsset } from '../storage/db';

/**
 * Bringing your own models in from disk.
 *
 * Separate from **My Assets**, which uploads to an account, because the two answer different
 * questions. Uploading shares a model across your projects and your machines, and needs a server.
 * This needs nothing: it is the local editor keeping the author's own art beside the author's own
 * projects, which is what somebody who just unzipped the portable build expects to be able to do.
 */

/** Categories worth offering. `logic` and `audio` are not things you import a model as. */
const CATEGORIES: AssetCategory[] = AssetCategorySchema.options.filter(
  (option): option is AssetCategory => option !== 'logic' && option !== 'audio',
);

interface Feedback {
  tone: 'ok' | 'warn' | 'error';
  lines: string[];
}

export function ImportModels({
  assets,
  onChanged,
}: {
  assets: StoredLocalAsset[];
  onChanged(): void;
}): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<AssetCategory>('props');
  const [author, setAuthor] = useState('');
  const [license, setLicense] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function take(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setBusy(true);
    setFeedback(null);

    const lines: string[] = [];
    let failed = 0;
    let warned = 0;

    // One at a time and one message at the end. Importing five models and getting five toasts that
    // replace each other means only the last one is read — and the one worth reading is usually
    // the failure in the middle.
    for (const file of Array.from(files)) {
      try {
        const result = await importLocalAsset(file, {
          category,
          ...(author.trim() ? { author: author.trim() } : {}),
          ...(license.trim() ? { license: license.trim() } : {}),
        });
        const clips = result.asset.animations.length;
        lines.push(
          `${result.asset.name}: ${result.asset.polyCount.toLocaleString()} triangles` +
            (clips > 0 ? `, ${clips} animation${clips === 1 ? '' : 's'}` : '') +
            (result.asset.skinned ? ', rigged' : ''),
        );
        for (const warning of result.warnings) {
          lines.push(`  ${warning}`);
          warned += 1;
        }
      } catch (error) {
        failed += 1;
        lines.push(
          error instanceof LocalAssetError
            ? error.message
            : `${file.name} could not be imported (${(error as Error).message}).`,
        );
      }
    }

    setBusy(false);
    setFeedback({ tone: failed > 0 ? 'error' : warned > 0 ? 'warn' : 'ok', lines });
    if (fileRef.current) fileRef.current.value = '';
    onChanged();
  }

  return (
    <section className="panel" aria-label="Import models">
      <h2>Import models</h2>

      <p className="panel-hint">
        Your own <code>.glb</code> or <code>.gltf</code> files, kept in this browser beside your
        projects. No account needed. They export with your game like any other asset.
      </p>

      <label className="param-row">
        <span>Category</span>
        <select
          aria-label="Import category"
          value={category}
          onChange={(event) => setCategory(event.target.value as AssetCategory)}
        >
          {CATEGORIES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      {/*
        Attribution is asked for at import rather than never, because an imported model is the one
        most likely to have a licence somebody has to honour — and the export's CREDITS file is
        generated from the manifest. A blank field records nothing, which is honest; a field that
        was never offered records nothing while implying there was nothing to record.
      */}
      <label className="param-row">
        <span>Author</span>
        <input
          type="text"
          aria-label="Author"
          value={author}
          placeholder="optional"
          onChange={(event) => setAuthor(event.target.value)}
        />
      </label>
      <label className="param-row">
        <span>Licence</span>
        <input
          type="text"
          aria-label="Licence"
          value={license}
          placeholder="optional, e.g. CC0-1.0"
          onChange={(event) => setLicense(event.target.value)}
        />
      </label>

      <input
        ref={fileRef}
        type="file"
        accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
        multiple
        aria-label="Choose model files"
        disabled={busy}
        onChange={(event) => void take(event.target.files)}
      />

      {busy && <p className="panel-hint">Reading…</p>}

      {feedback && (
        <div className={`panel-hint${feedback.tone === 'error' ? ' error' : ''}`} role="status">
          {feedback.lines.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
      )}

      {assets.length === 0 ? (
        <p className="panel-hint">
          Nothing imported yet. Up to {MAX_LOCAL_ASSET_BYTES / 1024 / 1024} MB per model.
        </p>
      ) : (
        <ul className="object-list">
          {assets.map((asset) => (
            <li key={asset.id}>
              <span>
                {asset.name}
                {asset.skinned && <span className="count">rigged</span>}
                {asset.animations.length > 0 && (
                  <span className="count">{asset.animations.length} clips</span>
                )}
              </span>
              <button
                type="button"
                aria-label={`Remove ${asset.name}`}
                onClick={() => {
                  void deleteLocalAsset(asset.id).then(onChanged);
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
