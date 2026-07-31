import { useMemo, useRef, useState, useEffect } from 'react';
import { Grid, type CellComponentProps } from 'react-window';
import type { AssetManifest, AssetManifestEntry } from '@helaengine/schema';
import { ASSET_BASE_URL } from '../engine/assetLibrary';
import { useEditorStore } from '../store/editorStore';
import { SceneTree } from './SceneTree';

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
        <img src={`${ASSET_BASE_URL}${asset.thumbnailPath}`} alt="" draggable={false} />
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
    <div style={style}>
      <AssetCard asset={asset} />
    </div>
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
export function AssetLibraryPanel({ manifest }: { manifest: AssetManifest }): React.JSX.Element {
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
            <p className="panel-hint">No assets match “{search}”.</p>
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

      {/*
        The scene tree lives beside the asset library rather than under the inspector. When the two
        shared a rail, selecting an object expanded the inspector and shifted every tree row
        downward — enough to make the second click of a double-click land on the wrong row.
      */}
      <SceneTree />
    </aside>
  );
}
