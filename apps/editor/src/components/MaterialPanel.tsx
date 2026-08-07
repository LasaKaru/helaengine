import type { MaterialOverride, SceneObject } from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

/**
 * Per-object material overrides.
 *
 * Every field is genuinely optional, and the panel has to preserve that rather than filling in
 * defaults the moment it is opened: an absent field means "keep whatever the model shipped with",
 * and a panel that wrote `roughness: 0.5` on open would flatten every model somebody clicked on.
 *
 * So each row has its own checkbox. Ticking it starts overriding that one property; clearing it
 * hands the property back to the model.
 */

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Sensible starting points, used only when a row is switched on. */
const DEFAULTS = {
  color: '#ffffff',
  roughness: 0.8,
  metalness: 0,
  emissive: '#000000',
  emissiveIntensity: 1,
  opacity: 1,
} as const;

export function MaterialPanel({ object }: { object: SceneObject }): React.JSX.Element {
  const setMaterial = useSceneStore((state) => state.setMaterial);
  const material = object.material;

  const patch = (changes: Partial<MaterialOverride>): void => {
    const next = { ...(material ?? {}), ...changes };
    // An override with nothing left in it becomes null, so the object stops paying for a material
    // clone the moment the last row is cleared.
    const remaining = Object.values(next).filter((value) => value !== undefined);
    setMaterial(object.id, remaining.length === 0 ? null : next);
  };

  const row = (
    key: keyof typeof DEFAULTS,
    label: string,
    control: React.ReactNode,
  ): React.JSX.Element => (
    <div className="param-row" key={key}>
      <label className="param-check">
        <input
          type="checkbox"
          checked={material?.[key] !== undefined}
          aria-label={`Override ${label.toLowerCase()}`}
          onChange={(event) => patch({ [key]: event.target.checked ? DEFAULTS[key] : undefined })}
        />
        {label}
      </label>
      {material?.[key] !== undefined && control}
    </div>
  );

  return (
    <section className="panel" aria-label="Material">
      <h2>Material</h2>

      <p className="panel-hint">
        Applies to this object only. Anything left unticked keeps whatever the model came with.
      </p>

      {row(
        'color',
        'Colour',
        <input
          type="color"
          aria-label="Colour"
          value={material?.color ?? DEFAULTS.color}
          onChange={(event) => patch({ color: event.target.value })}
        />,
      )}

      {row(
        'roughness',
        'Roughness',
        <NumberField
          label="Roughness"
          value={material?.roughness ?? DEFAULTS.roughness}
          step={0.02}
          onChange={(roughness) => patch({ roughness: clamp(roughness, 0, 1) })}
        />,
      )}

      {row(
        'metalness',
        'Metalness',
        <NumberField
          label="Metalness"
          value={material?.metalness ?? DEFAULTS.metalness}
          step={0.02}
          onChange={(metalness) => patch({ metalness: clamp(metalness, 0, 1) })}
        />,
      )}

      {row(
        'emissive',
        'Glow colour',
        <input
          type="color"
          aria-label="Glow colour"
          value={material?.emissive ?? DEFAULTS.emissive}
          onChange={(event) => patch({ emissive: event.target.value })}
        />,
      )}

      {row(
        'emissiveIntensity',
        'Glow strength',
        <NumberField
          label="Glow strength"
          value={material?.emissiveIntensity ?? DEFAULTS.emissiveIntensity}
          step={0.05}
          onChange={(emissiveIntensity) =>
            patch({ emissiveIntensity: clamp(emissiveIntensity, 0, 10) })
          }
        />,
      )}

      {row(
        'opacity',
        'Opacity',
        <NumberField
          label="Opacity"
          value={material?.opacity ?? DEFAULTS.opacity}
          step={0.02}
          onChange={(opacity) => patch({ opacity: clamp(opacity, 0, 1) })}
        />,
      )}

      <label className="param-check">
        <input
          type="checkbox"
          checked={material?.wireframe === true}
          onChange={(event) => patch({ wireframe: event.target.checked || undefined })}
        />
        Wireframe
      </label>

      {/*
        The fix for a model that vanishes when you walk into it — a room built from an inverted
        box, a skydome, a cave. Nothing else addresses it and it is one property.
      */}
      <label className="param-check">
        <input
          type="checkbox"
          checked={material?.doubleSided === true}
          onChange={(event) => patch({ doubleSided: event.target.checked || undefined })}
        />
        Render both sides
      </label>

      {material?.opacity !== undefined && material.opacity < 1 && (
        <p className="panel-hint">
          Transparency is switched on automatically, and costs a per-frame sort. Leave opacity at 1
          for anything that does not need it.
        </p>
      )}
    </section>
  );
}
