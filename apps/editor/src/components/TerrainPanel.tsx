import type { SculptMode } from '@helaengine/engine';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

const SCULPT_MODES: SculptMode[] = ['raise', 'lower', 'smooth', 'flatten'];
const SEGMENT_CHOICES = [32, 64, 128, 256];

/**
 * Terrain settings and brush controls.
 *
 * Resolution and world size are shown as an explicit, confirmable change rather than a live slider:
 * altering either resamples the heightmap, and quietly rewriting a sculpted terrain because
 * someone dragged a number is not a trade worth making.
 */
export function TerrainPanel(): React.JSX.Element {
  const terrain = useSceneStore((state) => state.scene.terrain);
  const setTerrain = useSceneStore((state) => state.setTerrain);
  const tool = useEditorStore((state) => state.tool);
  const brush = useEditorStore((state) => state.brush);
  const setBrush = useEditorStore((state) => state.setBrush);

  const sculpting = tool === 'sculpt';
  const painting = tool === 'paint';

  return (
    <section className="panel panel-terrain" aria-label="Terrain">
      <h2>Terrain</h2>

      {!sculpting && !painting && (
        <p className="panel-hint">Pick the Sculpt or Paint tool to shape the ground.</p>
      )}

      {(sculpting || painting) && (
        <>
          <div className="brush-fields">
            <NumberField
              label="Brush radius"
              scrubLabel="Size"
              suffix="m"
              value={brush.radius}
              step={0.5}
              onChange={(radius) => setBrush({ radius: Math.max(0.5, Math.min(64, radius)) })}
            />
            <NumberField
              label="Brush strength"
              scrubLabel="Str"
              value={brush.strength}
              step={0.02}
              onChange={(strength) => setBrush({ strength: Math.max(0.01, Math.min(1, strength)) })}
            />
          </div>

          {sculpting && (
            <div className="chip-row" role="group" aria-label="Sculpt mode">
              {SCULPT_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={brush.sculptMode === mode ? 'active' : ''}
                  aria-pressed={brush.sculptMode === mode}
                  onClick={() => setBrush({ sculptMode: mode })}
                >
                  {mode}
                </button>
              ))}
            </div>
          )}

          {painting && (
            <div className="chip-row" role="group" aria-label="Paint layer">
              {terrain.layers.map((layer, index) => (
                <button
                  key={layer.name}
                  type="button"
                  className={brush.layer === index ? 'active' : ''}
                  aria-pressed={brush.layer === index}
                  onClick={() => setBrush({ layer: index })}
                >
                  <span className="layer-swatch" style={{ background: layer.color }} />
                  {layer.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <dl className="terrain-meta">
        <dt>Size</dt>
        <dd>
          {terrain.size[0]} × {terrain.size[1]} m
        </dd>
        <dt>Sculpted</dt>
        <dd>{terrain.heightmap ? 'yes' : 'no'}</dd>
      </dl>

      <label className="terrain-resolution">
        <span>Resolution</span>
        <select
          aria-label="Terrain resolution"
          value={terrain.segments}
          onChange={(event) => {
            const segments = Number(event.target.value);
            if (
              terrain.heightmap &&
              !window.confirm('Changing resolution clears the sculpted heightmap. Continue?')
            ) {
              return;
            }
            setTerrain({ segments, heightmap: null, splatmap: null });
          }}
        >
          {SEGMENT_CHOICES.map((segments) => (
            <option key={segments} value={segments}>
              {segments} × {segments}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
