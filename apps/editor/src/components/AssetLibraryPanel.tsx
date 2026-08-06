import { useMemo, useRef, useState, useEffect } from 'react';
import { Grid, type CellComponentProps } from 'react-window';
import {
  AssetCategorySchema,
  type AssetCategory,
  type AssetManifest,
  type AssetManifestEntry,
} from '@helaengine/schema';
import { ASSET_BASE_URL } from '../engine/assetLibrary';
import type { UploadedAssets } from '../storage/useUploadedAssets';
import { useEditorStore } from '../store/editorStore';
import { SceneTree } from './SceneTree';
import { UpgradePrompt } from './UpgradePrompt';

const CARD_HEIGHT = 116;
const MIN_CARD_WIDTH = 96;

/** Tracks an element's content box, so the virtualized grid knows how many columns fit. */
function useElementSize<T extends HTMLElement>(): [React.RefObject<T>, DOMRectReadOnly | null] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<DOMRectReadOnly | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize(entry.contentRect);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref as React.RefObject<T>, size];
}

function matches(asset: AssetManifestEntry, query: string): boolean {
  if (query === '') return true;
  const needle = query.toLowerCase();
  return (
    asset.name.toLowerCase().includes(needle) ||
    asset.id.toLowerCase().includes(needle) ||
    asset.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}

/**
 * Where a thumbnail actually lives.
 *
 * Ingested assets carry a path relative to the manifest; an uploaded one carries an absolute URL at
 * the API, because it is not in the export's asset folder and never will be. Prefixing the second
 * kind would produce `./assets/http://…`, which is the same class of bug the engine's `joinUrl`
 * exists to avoid for models.
 */
function thumbnailUrl(path: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith('/')) return path;
  return `${ASSET_BASE_URL}${path}`;
}

interface AssetCardProps {
  asset: AssetManifestEntry;
}

function AssetCard({ asset }: AssetCardProps): React.JSX.Element {
  const beginDrag = useEditorStore((state) => state.beginDrag);
  const isDragging = useEditorStore((state) => state.drag?.assetId === asset.id);

  return (
    <button
      type="button"
      className={`asset-card${isDragging ? ' dragging' : ''}`}
      data-asset-id={asset.id}
      title={`${asset.name} — ${asset.polyCount ?? '?'} tris`}
      onPointerDown={(event) => {
        // Left button only, and no pointer capture: the drag is tracked on window so it keeps
        // working once the pointer leaves this card and moves over the viewport.
        if (event.button !== 0) return;
        event.preventDefault();
        beginDrag(asset.id, event.clientX, event.clientY);
      }}
    >
      {asset.thumbnailPath ? (
        <img src={thumbnailUrl(asset.thumbnailPath)} alt="" draggable={false} />
      ) : (
        // Thumbnails are generated output and may be absent (CI skips that stage). The asset's
        // own colour is a better placeholder than a broken-image icon.
        <span className="asset-swatch" style={{ background: asset.placeholderColor }} />
      )}
      <span className="asset-name">{asset.name}</span>
    </button>
  );
}

interface GridCellProps {
  assets: AssetManifestEntry[];
  columns: number;
}

function GridCell({
  columnIndex,
  rowIndex,
  style,
  assets,
  columns,
}: CellComponentProps<GridCellProps>): React.JSX.Element | null {
  const asset = assets[rowIndex * columns + columnIndex];
  if (!asset) return null;
  return (
    /**
     * `role="gridcell"` because `react-window` puts the cell inside a `role="row"`, and a row whose
     * children are plain `div`s is a broken grid — axe reports it as a *critical*
     * `aria-required-children` violation, and a screen reader reading the asset library gets a
     * table with no cells in it.
     *
     * Found by the Sprint 37 scan, not by reading this file: the markup looks entirely reasonable
     * until you know what the virtualiser wraps it in.
     */
    <div style={style} role="gridcell">
      <AssetCard asset={asset} />
    </div>
  );
}

/** Categories an upload can be filed under. Audio is not a thing you drag into the world. */
const UPLOAD_CATEGORIES = AssetCategorySchema.options.filter(
  (category) => category !== 'audio' && category !== 'logic',
);

const STATUS_TEXT: Record<'pending' | 'ready' | 'failed', string> = {
  pending: 'Processing…',
  ready: 'Ready',
  failed: 'Failed',
};

/**
 * Assets this organisation uploaded, and the way to add another.
 *
 * Separate from the grid above rather than mixed into it, even though a ready upload also appears
 * as a card there. The two answer different questions: the grid answers "what can I place", where
 * an asset's origin is irrelevant, and this answers "what did I upload and did it work", where the
 * origin is the entire point — including for the ones that are still processing or that failed,
 * which have no card at all.
 */
function MyAssets({ uploads }: { uploads: UploadedAssets }): React.JSX.Element | null {
  const [category, setCategory] = useState<AssetCategory>('props');
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Nothing to offer when nobody is signed in. A disabled drop zone with "sign in to upload" would
  // be an advertisement in the middle of a tool that works fine without an account.
  if (!uploads.available) return null;

  const mine = uploads.all.filter((asset) => asset.organizationId !== null);

  return (
    <section className="panel panel-uploads" aria-label="My assets">
      <h2>My Assets</h2>

      <div className="upload-controls">
        <label>
          Category
          <select
            value={category}
            aria-label="Upload category"
            onChange={(event) => setCategory(event.target.value as AssetCategory)}
          >
            {UPLOAD_CATEGORIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        className={`upload-drop${over ? ' over' : ''}`}
        data-testid="upload-drop"
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          if (event.dataTransfer.files.length > 0) {
            void uploads.upload(event.dataTransfer.files, category);
          }
        }}
      >
        <p>{uploads.busy ? 'Uploading…' : 'Drop a .glb here'}</p>
        <button type="button" disabled={uploads.busy} onClick={() => fileRef.current?.click()}>
          Choose a file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".glb,model/gltf-binary"
          multiple
          hidden
          aria-label="Upload a model"
          onChange={(event) => {
            const files = event.target.files;
            if (files && files.length > 0) void uploads.upload(files, category);
            // Cleared so choosing the same file twice fires a second change event. Without this,
            // re-uploading after a failure appears to do nothing.
            event.target.value = '';
          }}
        />
      </div>

      {uploads.limit !== null && (
        // The same prompt every limit produces, wherever it was hit.
        <UpgradePrompt limit={uploads.limit} onDismiss={uploads.dismissLimit} />
      )}

      {uploads.error !== null && (
        <p className="upload-error" role="alert">
          {uploads.error}{' '}
          <button type="button" onClick={uploads.dismissError}>
            Dismiss
          </button>
        </p>
      )}

      {mine.length === 0 ? (
        <p className="panel-hint">
          Nothing uploaded yet. Your models stay private to your account.
        </p>
      ) : (
        <ul className="upload-list">
          {mine.map((asset) => (
            <li key={asset.id} data-asset-id={asset.assetId} data-status={asset.status}>
              <span className="upload-name">{asset.name}</span>
              <span className={`upload-status status-${asset.status}`}>
                {STATUS_TEXT[asset.status]}
              </span>
              {/* The reason, next to the asset it is about. "Processing failed" with the cause
                  somewhere else is how a fixable file becomes a support ticket. */}
              {asset.failure !== null && <span className="upload-failure">{asset.failure}</span>}
              <button
                type="button"
                aria-label={`Delete ${asset.name}`}
                onClick={() => void uploads.remove(asset.assetId)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The asset library. Search, category filter, and a virtualized grid of draggable cards.
 *
 * The grid is virtualized at ten assets, which is obviously unnecessary today — but the library is
 * headed for hundreds (Sprint 37), and retrofitting virtualization onto a panel with scroll
 * position, drag handlers and selection already wired through it is far more disruptive than
 * starting with it.
 */
export function AssetLibraryPanel({
  manifest,
  uploads,
}: {
  manifest: AssetManifest;
  /** Absent in tests and anywhere the panel is rendered without an account behind it. */
  uploads?: UploadedAssets;
}): React.JSX.Element {
  const search = useEditorStore((state) => state.assetSearch);
  const setSearch = useEditorStore((state) => state.setAssetSearch);
  const category = useEditorStore((state) => state.assetCategory);
  const setCategory = useEditorStore((state) => state.setAssetCategory);

  const [gridRef, gridSize] = useElementSize<HTMLDivElement>();

  /**
   * Everything that can be dragged into the world.
   *
   * Audio shares the manifest — there should be one answer to "what assets does this project
   * have" — but a sound is not something you place, so it is filtered out here rather than
   * appearing as a card that does nothing when dropped. The Audio panel is where it belongs.
   */
  const placeable = useMemo(
    () => manifest.assets.filter((asset) => asset.category !== 'audio'),
    [manifest],
  );

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const asset of placeable) {
      counts.set(asset.category, (counts.get(asset.category) ?? 0) + 1);
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  }, [placeable]);

  const visible = useMemo(
    () =>
      placeable.filter(
        (asset) => (category === null || asset.category === category) && matches(asset, search),
      ),
    [placeable, category, search],
  );

  const width = gridSize?.width ?? 0;
  const height = gridSize?.height ?? 0;
  const columns = Math.max(1, Math.floor(width / MIN_CARD_WIDTH));
  const columnWidth = columns > 0 && width > 0 ? width / columns : MIN_CARD_WIDTH;
  const rows = Math.ceil(visible.length / columns);

  return (
    <aside className="rail rail-left">
      <section className="panel panel-assets" aria-label="Assets">
        <h2>Assets</h2>

        <input
          type="search"
          className="asset-search"
          value={search}
          placeholder="Search assets…"
          aria-label="Search assets"
          onChange={(event) => setSearch(event.target.value)}
        />

        <div className="category-tabs" role="group" aria-label="Asset categories">
          <button
            type="button"
            className={category === null ? 'active' : ''}
            onClick={() => setCategory(null)}
          >
            All <span className="count">{placeable.length}</span>
          </button>
          {categories.map(([name, count]) => (
            <button
              key={name}
              type="button"
              className={category === name ? 'active' : ''}
              onClick={() => setCategory(name)}
            >
              {name} <span className="count">{count}</span>
            </button>
          ))}
        </div>

        <div className="asset-grid" ref={gridRef} data-testid="asset-grid">
          {visible.length === 0 ? (
            /*
              An empty result that says why it is empty and offers the way out.
              
              "No assets match X" is true and unhelpful when a *category* filter is also on: the
              user reads it as "this product has no crates", clears the search, and still sees
              nothing. Naming both filters and giving a button that drops them is the difference
              between a dead end and a hint.
            */
            <div className="panel-hint empty-state">
              <p>
                {search === ''
                  ? `No ${category ?? 'assets'} to show.`
                  : `No ${category ? `${category} ` : ''}assets match “${search}”.`}
              </p>
              {(search !== '' || category !== null) && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    setCategory(null);
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            width > 0 &&
            height > 0 && (
              <Grid
                cellComponent={GridCell}
                cellProps={{ assets: visible, columns }}
                columnCount={columns}
                columnWidth={columnWidth}
                rowCount={rows}
                rowHeight={CARD_HEIGHT}
                defaultWidth={width}
                defaultHeight={height}
                style={{ width, height }}
              />
            )
          )}
        </div>

        <p className="asset-footer">
          {visible.length} of {placeable.length} · drag onto the terrain to place
        </p>
      </section>

      {uploads && <MyAssets uploads={uploads} />}

      {/*
        The scene tree lives beside the asset library rather than under the inspector. When the two
        shared a rail, selecting an object expanded the inspector and shifted every tree row
        downward — enough to make the second click of a double-click land on the wrong row.
      */}
      <SceneTree />
    </aside>
  );
}
