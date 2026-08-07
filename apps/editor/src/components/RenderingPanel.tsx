import {
  SHADOW_QUALITY,
  TONE_MAPPING,
  type ShadowQuality,
  type ToneMapping,
} from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { SWAY_GROUPS } from '@helaengine/schema';
import { NumberField } from './NumberField';

/**
 * Lighting, tone mapping and image effects for the whole scene.
 *
 * Everything here is off or neutral by default, and that is the design rather than caution: a
 * scene saved before any of this existed parses with these defaults and must look exactly as it
 * did. The interesting settings are the ones somebody turns on deliberately.
 */

const SHADOW_LABEL: Record<ShadowQuality, string> = {
  off: 'Off — fastest, flat look',
  low: 'Low — 1024px',
  medium: 'Medium — 2048px',
  high: 'High — 4096px',
};

const TONE_LABEL: Record<ToneMapping, string> = {
  none: 'None — flat and stylised',
  linear: 'Linear',
  reinhard: 'Reinhard',
  cineon: 'Cineon',
  aces: 'ACES — filmic',
};

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function RenderingPanel(): React.JSX.Element {
  const environment = useSceneStore((state) => state.scene.environment);
  const setEnvironment = useSceneStore((state) => state.setEnvironment);

  const { lighting, postProcessing: post, wind } = environment;

  return (
    <section className="panel" aria-label="Rendering">
      <h2>Rendering</h2>

      <h3>Lighting</h3>

      <label className="param-row">
        <span>Sun colour</span>
        <input
          type="color"
          aria-label="Sun colour"
          value={lighting.sun.color}
          onChange={(event) =>
            setEnvironment({
              lighting: { ...lighting, sun: { ...lighting.sun, color: event.target.value } },
            })
          }
        />
      </label>
      <NumberField
        label="Sun intensity"
        scrubLabel="Sun"
        value={lighting.sun.intensity}
        step={0.02}
        onChange={(intensity) =>
          setEnvironment({
            lighting: { ...lighting, sun: { ...lighting.sun, intensity: clamp(intensity, 0, 10) } },
          })
        }
      />
      <NumberField
        label="Sun elevation"
        scrubLabel="Elevation"
        value={lighting.sun.elevation}
        step={0.5}
        suffix="°"
        onChange={(elevation) =>
          setEnvironment({
            lighting: {
              ...lighting,
              sun: { ...lighting.sun, elevation: clamp(elevation, -90, 90) },
            },
          })
        }
      />
      <NumberField
        label="Sun direction"
        scrubLabel="Direction"
        value={lighting.sun.azimuth}
        step={1}
        suffix="°"
        onChange={(azimuth) =>
          setEnvironment({ lighting: { ...lighting, sun: { ...lighting.sun, azimuth } } })
        }
      />

      <label className="param-row">
        <span>Ambient colour</span>
        <input
          type="color"
          aria-label="Ambient colour"
          value={lighting.ambientColor}
          onChange={(event) =>
            setEnvironment({ lighting: { ...lighting, ambientColor: event.target.value } })
          }
        />
      </label>
      <NumberField
        label="Ambient intensity"
        scrubLabel="Ambient"
        value={lighting.ambient}
        step={0.02}
        onChange={(ambient) =>
          setEnvironment({ lighting: { ...lighting, ambient: clamp(ambient, 0, 10) } })
        }
      />

      {/*
        A hemisphere light tints upward faces with the sky and downward faces with the ground —
        the cheapest approximation of bounced light there is, and at low-poly densities it does
        more for a scene than any amount of shadow tuning.
      */}
      <label className="param-check">
        <input
          type="checkbox"
          checked={lighting.hemisphere !== null}
          onChange={(event) =>
            setEnvironment({
              lighting: {
                ...lighting,
                hemisphere: event.target.checked
                  ? { skyColor: '#a0c8ff', groundColor: '#4a4a3a', intensity: 0.5 }
                  : null,
              },
            })
          }
        />
        Sky and ground fill
      </label>

      {lighting.hemisphere && (
        <>
          <label className="param-row">
            <span>Sky</span>
            <input
              type="color"
              aria-label="Sky colour"
              value={lighting.hemisphere.skyColor}
              onChange={(event) =>
                setEnvironment({
                  lighting: {
                    ...lighting,
                    hemisphere: { ...lighting.hemisphere!, skyColor: event.target.value },
                  },
                })
              }
            />
          </label>
          <label className="param-row">
            <span>Ground</span>
            <input
              type="color"
              aria-label="Ground colour"
              value={lighting.hemisphere.groundColor}
              onChange={(event) =>
                setEnvironment({
                  lighting: {
                    ...lighting,
                    hemisphere: { ...lighting.hemisphere!, groundColor: event.target.value },
                  },
                })
              }
            />
          </label>
          <NumberField
            label="Fill intensity"
            scrubLabel="Fill"
            value={lighting.hemisphere.intensity}
            step={0.02}
            onChange={(intensity) =>
              setEnvironment({
                lighting: {
                  ...lighting,
                  hemisphere: { ...lighting.hemisphere!, intensity: clamp(intensity, 0, 5) },
                },
              })
            }
          />
        </>
      )}

      <h3>Shadows</h3>

      <label className="param-row">
        <span>Quality</span>
        <select
          aria-label="Shadow quality"
          value={lighting.shadows.quality}
          onChange={(event) =>
            setEnvironment({
              lighting: {
                ...lighting,
                shadows: { ...lighting.shadows, quality: event.target.value as ShadowQuality },
              },
            })
          }
        >
          {SHADOW_QUALITY.map((quality) => (
            <option key={quality} value={quality}>
              {SHADOW_LABEL[quality]}
            </option>
          ))}
        </select>
      </label>

      {lighting.shadows.quality !== 'off' && (
        <>
          <NumberField
            label="Shadow distance"
            scrubLabel="Distance"
            value={lighting.shadows.distance}
            step={2}
            suffix="m"
            onChange={(distance) =>
              setEnvironment({
                lighting: {
                  ...lighting,
                  shadows: { ...lighting.shadows, distance: clamp(distance, 20, 1000) },
                },
              })
            }
          />
          <p className="panel-hint">
            The shadow map is stretched over this distance, so doubling it halves the detail
            everywhere.
          </p>
        </>
      )}

      <h3>Wind</h3>

      <NumberField
        label="Wind strength"
        value={wind.strength}
        step={0.05}
        suffix="m"
        onChange={(strength) =>
          setEnvironment({ wind: { ...wind, strength: clamp(strength, 0, 4) } })
        }
      />
      <p className="panel-hint">
        {wind.strength === 0
          ? 'Off. Nothing sways, and no shader is patched.'
          : 'How far a two-metre plant leans at the top.'}
      </p>

      {wind.strength > 0 && (
        <>
          <NumberField
            label="Wind direction"
            value={wind.direction}
            step={5}
            suffix="°"
            onChange={(direction) =>
              // Wrapped rather than clamped: dragging past north should carry on round, not stick.
              setEnvironment({ wind: { ...wind, direction: ((direction % 360) + 360) % 360 } })
            }
          />
          <NumberField
            label="Wind speed"
            value={wind.speed}
            step={0.05}
            onChange={(speed) =>
              setEnvironment({ wind: { ...wind, speed: clamp(speed, 0.05, 4) } })
            }
          />
          <NumberField
            label="Gustiness"
            value={wind.gustiness}
            step={0.05}
            onChange={(gustiness) =>
              setEnvironment({ wind: { ...wind, gustiness: clamp(gustiness, 0, 1) } })
            }
          />

          <div className="chip-row" role="group" aria-label="Wind affects">
            {SWAY_GROUPS.map((group) => (
              <button
                key={group}
                type="button"
                className={wind.affects.includes(group) ? 'active' : ''}
                aria-pressed={wind.affects.includes(group)}
                onClick={() =>
                  setEnvironment({
                    wind: {
                      ...wind,
                      affects: wind.affects.includes(group)
                        ? wind.affects.filter((current) => current !== group)
                        : [...wind.affects, group],
                    },
                  })
                }
              >
                {group}
              </button>
            ))}
          </div>
        </>
      )}

      <h3>Image</h3>

      <label className="param-row">
        <span>Tone mapping</span>
        <select
          aria-label="Tone mapping"
          value={environment.toneMapping}
          onChange={(event) => setEnvironment({ toneMapping: event.target.value as ToneMapping })}
        >
          {TONE_MAPPING.map((mode) => (
            <option key={mode} value={mode}>
              {TONE_LABEL[mode]}
            </option>
          ))}
        </select>
      </label>

      {environment.toneMapping !== 'none' && (
        <NumberField
          label="Exposure"
          value={environment.exposure}
          step={0.02}
          onChange={(exposure) => setEnvironment({ exposure: clamp(exposure, 0.1, 4) })}
        />
      )}

      <label className="param-check">
        <input
          type="checkbox"
          checked={post.enabled}
          onChange={(event) =>
            setEnvironment({ postProcessing: { ...post, enabled: event.target.checked } })
          }
        />
        Image effects
      </label>

      {post.enabled && (
        <>
          <label className="param-check">
            <input
              type="checkbox"
              checked={post.bloom.enabled}
              onChange={(event) =>
                setEnvironment({
                  postProcessing: {
                    ...post,
                    bloom: { ...post.bloom, enabled: event.target.checked },
                  },
                })
              }
            />
            Bloom
          </label>
          {post.bloom.enabled && (
            <>
              <NumberField
                label="Bloom strength"
                scrubLabel="Strength"
                value={post.bloom.strength}
                step={0.02}
                onChange={(strength) =>
                  setEnvironment({
                    postProcessing: {
                      ...post,
                      bloom: { ...post.bloom, strength: clamp(strength, 0, 3) },
                    },
                  })
                }
              />
              <NumberField
                label="Bloom threshold"
                scrubLabel="Threshold"
                value={post.bloom.threshold}
                step={0.02}
                onChange={(threshold) =>
                  setEnvironment({
                    postProcessing: {
                      ...post,
                      bloom: { ...post.bloom, threshold: clamp(threshold, 0, 2) },
                    },
                  })
                }
              />
            </>
          )}

          <label className="param-check">
            <input
              type="checkbox"
              checked={post.vignette.enabled}
              onChange={(event) =>
                setEnvironment({
                  postProcessing: {
                    ...post,
                    vignette: { ...post.vignette, enabled: event.target.checked },
                  },
                })
              }
            />
            Vignette
          </label>
          {post.vignette.enabled && (
            <NumberField
              label="Vignette strength"
              scrubLabel="Vignette"
              value={post.vignette.strength}
              step={0.02}
              onChange={(strength) =>
                setEnvironment({
                  postProcessing: {
                    ...post,
                    vignette: { ...post.vignette, strength: clamp(strength, 0, 1) },
                  },
                })
              }
            />
          )}

          <label className="param-check">
            <input
              type="checkbox"
              checked={post.colorGrade.enabled}
              onChange={(event) =>
                setEnvironment({
                  postProcessing: {
                    ...post,
                    colorGrade: { ...post.colorGrade, enabled: event.target.checked },
                  },
                })
              }
            />
            Colour grade
          </label>
          {post.colorGrade.enabled && (
            <>
              <NumberField
                label="Brightness"
                value={post.colorGrade.brightness}
                step={0.02}
                onChange={(brightness) =>
                  setEnvironment({
                    postProcessing: {
                      ...post,
                      colorGrade: { ...post.colorGrade, brightness: clamp(brightness, -1, 1) },
                    },
                  })
                }
              />
              <NumberField
                label="Contrast"
                value={post.colorGrade.contrast}
                step={0.02}
                onChange={(contrast) =>
                  setEnvironment({
                    postProcessing: {
                      ...post,
                      colorGrade: { ...post.colorGrade, contrast: clamp(contrast, -1, 1) },
                    },
                  })
                }
              />
              <NumberField
                label="Saturation"
                value={post.colorGrade.saturation}
                step={0.02}
                onChange={(saturation) =>
                  setEnvironment({
                    postProcessing: {
                      ...post,
                      colorGrade: { ...post.colorGrade, saturation: clamp(saturation, -1, 1) },
                    },
                  })
                }
              />
              <label className="param-row">
                <span>Tint</span>
                <input
                  type="color"
                  aria-label="Tint"
                  value={post.colorGrade.tint}
                  onChange={(event) =>
                    setEnvironment({
                      postProcessing: {
                        ...post,
                        colorGrade: { ...post.colorGrade, tint: event.target.value },
                      },
                    })
                  }
                />
              </label>
            </>
          )}

          <p className="panel-hint">
            Effects cost a full-screen pass each. With all three off nothing is composed at all, so
            a scene that does not use them runs exactly as it did before.
          </p>
        </>
      )}
    </section>
  );
}
