import type { AssetManifest } from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';

interface PanelProps {
  children?: React.ReactNode;
  title: string;
  hint: string;
}

function Panel({ title, hint, children }: PanelProps): React.JSX.Element {
  return (
    <section className="panel" aria-label={title}>
      <h2>{title}</h2>
      {children ?? <p className="panel-hint">{hint}</p>}
    </section>
  );
}

/**
 * Left rail. The asset library proper — search, category tabs, virtualised grid, drag to place —
 * is Sprint 4. For now it reports what the manifest actually contains, which is enough to prove
 * the editor is reading the pipeline's output rather than a hardcoded list.
 */
export function AssetPanel({ manifest }: { manifest: AssetManifest }): React.JSX.Element {
  const categories = new Map<string, number>();
  for (const asset of manifest.assets) {
    categories.set(asset.category, (categories.get(asset.category) ?? 0) + 1);
  }

  return (
    <aside className="rail rail-left">
      <Panel title="Assets" hint="">
        <p className="panel-hint">
          {manifest.assets.length} assets loaded. Browsing and drag-to-place arrive in Sprint 4.
        </p>
        <ul className="category-list">
          {[...categories].map(([category, count]) => (
            <li key={category}>
              <span>{category}</span>
              <span className="count">{count}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </aside>
  );
}

/** Right rail: inspector (Sprint 5) above the scene graph tree (Sprint 6). */
export function InspectorPanel(): React.JSX.Element {
  const selectedIds = useSceneStore((state) => state.selectedIds);
  const objects = useSceneStore((state) => state.scene.objects);

  return (
    <aside className="rail rail-right">
      <Panel
        title="Inspector"
        hint={
          selectedIds.length === 0
            ? 'Nothing selected. Selection and transform gizmos arrive in Sprint 5.'
            : `${selectedIds.length} selected.`
        }
      />
      <Panel title="Scene" hint="">
        {objects.length === 0 ? (
          <p className="panel-hint">This scene is empty.</p>
        ) : (
          <ul className="object-list">
            {objects.map((object) => (
              <li key={object.id}>
                <span className="object-label">{object.metadata.label ?? object.id}</span>
                <span className="object-asset">{object.assetId}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </aside>
  );
}
