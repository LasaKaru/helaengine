import { useMemo } from 'react';
import {
  isCapped,
  plannedCount,
  scatterProblems,
  swayGroupFor,
  type AssetManifest,
  type ScatterLayer,
} from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

/**
 * Vegetation placed by rule.
 *
 * The panel's job beyond editing fields is to say what the numbers *mean*. Density is per hundred
 * square metres, which is the right unit to author in and the wrong one to reason about: "forty"
 * tells you nothing, and "about six thousand plants" tells you whether the level will still open.
 * So the count is computed and shown, and the cap says so when it is the thing deciding.
 */

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

interface LayerCardProps {
  layer: ScatterLayer;
  area: number;
  assets: AssetManifest['assets'];
  onChange(patch: Partial<ScatterLayer>): void;
  onRemove(): void;
}

function LayerCard({ layer, area, assets, onChange, onRemove }: LayerCardProps): React.JSX.Element {
  const count = plannedCount(layer, area);
  const capped = isCapped(layer, area);
  const problems = scatterProblems(layer);
  const sways = swayGroupFor(
    layer.assetId,
    assets.find((a) => a.id === layer.assetId)?.category ?? '',
  );

  return (
    <div className="scatter-layer">
      <div className="behavior-head">
        <input
          type="text"
          aria-label={`${layer.name} name`}
          className="scatter-name"
          value={layer.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <button type="button" aria-label={`Remove ${layer.name}`} onClick={onRemove}>
          Remove
        </button>
      </div>

      <label className="param-check">
        <input
          type="checkbox"
          aria-label={`${layer.name} enabled`}
          checked={layer.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
        />
        Grow it
      </label>

      <label className="param-row">
        <span>Model</span>
        <select
          aria-label={`${layer.name} model`}
          value={layer.assetId}
          onChange={(event) => onChange({ assetId: event.target.value })}
        >
          {assets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.name}
            </option>
          ))}
        </select>
      </label>

      <NumberField
        label={`${layer.name} density`}
        scrubLabel="Density"
        value={layer.density}
        step={1}
        onChange={(density) => onChange({ density: clamp(density, 0, 400) })}
      />
      <p className="panel-hint">
        {count.toLocaleString()} before slope and paint cut it down
        {capped && ' — capped, raise nothing further'}
        {sways && ', and it moves in the wind'}
      </p>

      <NumberField
        label={`${layer.name} seed`}
        scrubLabel="Seed"
        value={layer.seed}
        step={1}
        onChange={(seed) => onChange({ seed: Math.max(0, Math.round(seed)) })}
      />
      <p className="panel-hint">Change it if you simply do not like the arrangement.</p>

      <div className="vector-row" role="group" aria-label={`${layer.name} scale`}>
        <span className="vector-title">Scale</span>
        <div className="vector-fields">
          <NumberField
            label={`${layer.name} smallest`}
            scrubLabel="min"
            value={layer.scaleMin}
            step={0.05}
            onChange={(scaleMin) => onChange({ scaleMin: clamp(scaleMin, 0.05, 20) })}
          />
          <NumberField
            label={`${layer.name} largest`}
            scrubLabel="max"
            value={layer.scaleMax}
            step={0.05}
            onChange={(scaleMax) => onChange({ scaleMax: clamp(scaleMax, 0.05, 20) })}
          />
        </div>
      </div>

      <NumberField
        label={`${layer.name} max slope`}
        scrubLabel="Max slope"
        value={layer.slopeMax}
        step={1}
        suffix="°"
        onChange={(slopeMax) => onChange({ slopeMax: clamp(slopeMax, 0, 90) })}
      />

      <label className="param-row">
        <span>Only on</span>
        <select
          aria-label={`${layer.name} terrain layer`}
          value={layer.terrainLayer === null ? '' : String(layer.terrainLayer)}
          onChange={(event) =>
            onChange({
              terrainLayer: event.target.value === '' ? null : Number(event.target.value),
            })
          }
        >
          <option value="">Anywhere</option>
          <option value="0">Layer 1</option>
          <option value="1">Layer 2</option>
          <option value="2">Layer 3</option>
          <option value="3">Layer 4</option>
        </select>
      </label>
      {layer.terrainLayer !== null && (
        <p className="panel-hint">Paint that layer on the terrain and this follows the brush.</p>
      )}

      <label className="param-check">
        <input
          type="checkbox"
          aria-label={`${layer.name} align to slope`}
          checked={layer.alignToSlope}
          onChange={(event) => onChange({ alignToSlope: event.target.checked })}
        />
        Lie flat on slopes
      </label>
      <p className="panel-hint">
        Off for plants — grass grows upward whatever it stands on, and tilting it combs the
        hillside. On for rocks and debris.
      </p>

      <NumberField
        label={`${layer.name} clumping`}
        scrubLabel="Clumping"
        value={layer.clumping}
        step={0.05}
        onChange={(clumping) => onChange({ clumping: clamp(clumping, 0, 1) })}
      />
      <p className="panel-hint">
        {layer.clumping === 0
          ? 'Evenly spread. Right for a mown lawn, and the strongest tell that everything else was generated.'
          : 'Gathers into patches, the way ground that grows things actually is. The amount of grass stays the same — it just moves.'}
      </p>

      {layer.clumping > 0 && (
        <>
          <NumberField
            label={`${layer.name} patch size`}
            scrubLabel="Patch size"
            value={layer.clumpSize}
            step={0.5}
            suffix="m"
            onChange={(clumpSize) => onChange({ clumpSize: clamp(clumpSize, 0.5, 40) })}
          />
          <p className="panel-hint">
            Across from the middle of a thick part to the middle of a thin one.
          </p>
        </>
      )}

      <NumberField
        label={`${layer.name} colour variation`}
        scrubLabel="Colour variation"
        value={layer.colorJitter}
        step={0.05}
        onChange={(colorJitter) => onChange({ colorJitter: clamp(colorJitter, 0, 1) })}
      />
      <p className="panel-hint">
        {layer.colorJitter === 0
          ? 'Every one the same shade — which is what makes a field read as one object repeated.'
          : 'A different shade per plant. A few percent is enough; more starts to look like a different species.'}
      </p>

      {problems.map((problem) => (
        <p className="scatter-problem" key={problem}>
          {problem}
        </p>
      ))}
    </div>
  );
}

export function ScatterPanel({ manifest }: { manifest: AssetManifest }): React.JSX.Element {
  const scatter = useSceneStore((state) => state.scene.scatter);
  const terrainSize = useSceneStore((state) => state.scene.terrain.size);
  const addScatterLayer = useSceneStore((state) => state.addScatterLayer);
  const updateScatterLayer = useSceneStore((state) => state.updateScatterLayer);
  const removeScatterLayer = useSceneStore((state) => state.removeScatterLayer);

  /**
   * Only models, and only ones it makes sense to carpet a field with.
   *
   * Buildings and enemies are excluded not because scattering them would break — it would work
   * perfectly — but because a dropdown of four hundred entries with a hut in the middle is a
   * dropdown nobody finds the grass in.
   */
  const plantable = useMemo(
    () =>
      manifest.assets.filter(
        (asset) =>
          asset.category === 'trees' || asset.category === 'rocks' || asset.category === 'props',
      ),
    [manifest],
  );

  const area = terrainSize[0] * terrainSize[1];

  return (
    <section className="panel" aria-label="Ground cover">
      <h2>Ground cover</h2>

      {scatter.length === 0 && (
        <p className="panel-hint">
          Nothing yet. A layer carpets the terrain with one model — grass, rocks, flowers — from a
          rule rather than by hand, so it costs a few hundred bytes instead of thousands of objects.
        </p>
      )}

      {scatter.map((layer) => (
        <LayerCard
          key={layer.id}
          layer={layer}
          area={area}
          assets={plantable}
          onChange={(patch) => updateScatterLayer(layer.id, patch)}
          onRemove={() => removeScatterLayer(layer.id)}
        />
      ))}

      <button
        type="button"
        disabled={plantable.length === 0 || scatter.length >= 8}
        onClick={() => addScatterLayer(plantable[0]!.id)}
      >
        Add layer
      </button>
    </section>
  );
}
