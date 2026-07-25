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
