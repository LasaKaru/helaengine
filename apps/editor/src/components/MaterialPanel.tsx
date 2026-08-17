import {
  SURFACE_HINTS,
  SURFACE_KINDS,
  SURFACE_LABELS,
  SURFACE_SCALES,
  SURFACE_SCALE_LABELS,
  SurfaceSchema,
  surfaceProblems,
  type MaterialOverride,
  type SceneObject,
  type Surface,
  type SurfaceKind,
  type SurfaceScale,
  type AssetManifest,
  type LodOverride,
  type SwayOverride,
} from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { objectHasProjectedUvs } from '../engine/liveScene';
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

export function MaterialPanel({
  object,
  manifest,
}: {
  object: SceneObject;
  manifest: AssetManifest;
}): React.JSX.Element {
  const setMaterial = useSceneStore((state) => state.setMaterial);
  const setSway = useSceneStore((state) => state.setSway);
  const setLod = useSceneStore((state) => state.setLod);
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

      <SurfaceSection
        object={object}
        manifest={manifest}
        surface={material?.surface}
        patch={patch}
      />

      <label className="param-row">
        <span>Wind</span>
        <select
          aria-label="Wind"
          value={object.sway}
          onChange={(event) => setSway(object.id, event.target.value as SwayOverride)}
        >
          <option value="auto">Automatic</option>
          <option value="none">Never moves</option>
          <option value="grass">Like grass</option>
          <option value="plants">Like a shrub</option>
          <option value="trees">Like a tree</option>
        </select>
      </label>
      <p className="panel-hint">
        Automatic decides from the model. Override it for a potted plant indoors, or for an imported
        model the rule has not heard of.
      </p>

      <label className="param-row">
        <span>Detail</span>
        <select
          aria-label="Level of detail for this object"
          value={object.lod}
          onChange={(event) => setLod(object.id, event.target.value as LodOverride)}
        >
          <option value="auto">Follow the level</option>
          <option value="never">Always full detail</option>
        </select>
      </label>
      <p className="panel-hint">
        The escape hatch, not a tuning knob. The decimator is bad at smooth silhouettes, and the one
        landmark it makes a mess of should not force the whole level back to no detail levels at
        all.
      </p>
    </section>
  );
}

/**
 * The generated PBR surface for one object.
 *
 * Its own component rather than more rows in the panel above, because it is not an override of a
 * property the model has — it is a set of maps the model never had, and the three controls only
 * mean anything once a kind is chosen.
 */
function SurfaceSection({
  object,
  manifest,
  surface,
  patch,
}: {
  object: SceneObject;
  manifest: AssetManifest;
  surface: Surface | undefined;
  patch: (changes: Partial<MaterialOverride>) => void;
}): React.JSX.Element {
  const entry = manifest.assets.find((candidate) => candidate.id === object.assetId);
  const problems = surface
    ? surfaceProblems(surface, entry?.materialMaps ?? [], objectHasProjectedUvs(object.id))
    : [];

  const update = (changes: Partial<Surface>): void => {
    if (surface) patch({ surface: { ...surface, ...changes } });
  };

  return (
    <div className="panel-section" role="group" aria-label="Surface">
      <label className="param-row">
        <span>Surface</span>
        <select
          aria-label="Surface"
          value={surface?.kind ?? 'none'}
          onChange={(event) =>
            patch({
              surface:
                event.target.value === 'none'
                  ? undefined
                  : SurfaceSchema.parse({ kind: event.target.value as SurfaceKind }),
            })
          }
        >
          <option value="none">None</option>
          {SURFACE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {SURFACE_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>

      {!surface && (
        <p className="panel-hint">
          Bricks in a wall, grain in a plank. The geometry does not change — what changes is how the
          light comes off it, which is where most of the detail in a modern game lives. The colour
          still comes from the model, or from the row above.
        </p>
      )}

      {surface && (
        <>
          <p className="panel-hint">{SURFACE_HINTS[surface.kind]}</p>

          <label className="param-row">
            <span>Size</span>
            <select
              aria-label="Surface size"
              value={surface.scale}
              onChange={(event) => update({ scale: event.target.value as SurfaceScale })}
            >
              {SURFACE_SCALES.map((scale) => (
                <option key={scale} value={scale}>
                  {SURFACE_SCALE_LABELS[scale]}
                </option>
              ))}
            </select>
          </label>

          <div className="param-row">
            <span>Depth</span>
            <NumberField
              label="Surface depth"
              value={surface.depth}
              step={0.05}
              onChange={(depth) => update({ depth: clamp(depth, 0, 2) })}
            />
          </div>

          <div className="param-row">
            <span>Shadowing</span>
            <NumberField
              label="Surface shadowing"
              value={surface.occlusion}
              step={0.05}
              onChange={(occlusion) => update({ occlusion: clamp(occlusion, 0, 1) })}
            />
          </div>

          {problems.length > 0 && (
            <div className="joint-problems" role="status" aria-label="Surface problems">
              {problems.map((problem) => (
                <p key={problem}>{problem}</p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
