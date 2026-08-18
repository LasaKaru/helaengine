import {
  SHADOW_QUALITY,
  TONE_MAPPING,
  type ShadowQuality,
  type ToneMapping,
  WEATHER_HINTS,
  WEATHER_KINDS,
  WEATHER_LABELS,
  weatherCount,
  LOD_MODES,
  streamingProblems,
  LOD_MODE_HINTS,
  LOD_MODE_LABELS,
  type LodMode,
  type WeatherKind,
  WATER_HINTS,
  WATER_KINDS,
  WATER_LABELS,
  defaultWater,
  waterColor,
  waterProblems,
  type WaterKind,
} from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { LOOKS, LOOK_DESCRIPTION, LOOK_LABEL, SWAY_GROUPS, applyLook } from '@helaengine/schema';
import { liveTerrainRange, liveTerrainRelief } from '../engine/liveScene';
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
  // Read once per render rather than subscribed to: it changes when the terrain is sculpted, which
  // already re-renders this panel through the document, and sampling a heightfield on every frame
  // of a sculpt stroke would be work for a sentence nobody is reading mid-drag.
  const terrainRelief = liveTerrainRelief();

  return (
    <section className="panel" aria-label="Rendering">
      <h2>Rendering</h2>

      <h3>Look</h3>
      <div className="chip-row" role="group" aria-label="Look">
        {LOOKS.map((look) => (
          <button
            key={look}
            type="button"
            aria-label={LOOK_LABEL[look]}
            title={LOOK_DESCRIPTION[look]}
            onClick={() => setEnvironment(applyLook(environment, look))}
          >
            {LOOK_LABEL[look]}
          </button>
        ))}
      </div>
      <p className="panel-hint">
        A starting point, written into the settings below. Nothing remembers which one you pressed —
        every field stays yours to edit and to undo.
      </p>

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

      <h3>Weather</h3>

      <label className="param-row">
        <span>Kind</span>
        <select
          aria-label="Weather"
          value={environment.weather.kind}
          title={WEATHER_HINTS[environment.weather.kind]}
          onChange={(event) =>
            setEnvironment({
              weather: { ...environment.weather, kind: event.target.value as WeatherKind },
            })
          }
        >
          {WEATHER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {WEATHER_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      <p className="panel-hint">{WEATHER_HINTS[environment.weather.kind]}</p>

      {environment.weather.kind !== 'none' && (
        <>
          <div className="param-row">
            <span>Intensity</span>
            <NumberField
              label="Weather intensity"
              scrubLabel=""
              value={environment.weather.intensity}
              step={0.05}
              onChange={(intensity) =>
                setEnvironment({
                  weather: { ...environment.weather, intensity: clamp(intensity, 0, 1) },
                })
              }
            />
          </div>
          <p className="panel-hint">
            About {weatherCount(environment.weather).toLocaleString()} particles, in one draw call —
            positions are computed in the shader, so this costs no per-frame work at all.
          </p>

          <div className="param-row">
            <span>Reaches</span>
            <NumberField
              label="Weather radius"
              scrubLabel=""
              value={environment.weather.radius}
              step={5}
              suffix="m"
              onChange={(radius) =>
                setEnvironment({
                  weather: { ...environment.weather, radius: clamp(radius, 5, 300) },
                })
              }
            />
          </div>
          <p className="panel-hint">
            The box that follows the camera. Too small and the player sees its edge as they turn;
            too large and the same particles spread thin enough to look like drizzle.
          </p>

          <label className="param-check">
            <input
              type="checkbox"
              aria-label="Weather follows wind"
              checked={environment.weather.followWind}
              onChange={(event) =>
                setEnvironment({
                  weather: { ...environment.weather, followWind: event.target.checked },
                })
              }
            />
            Blown by the wind
          </label>
        </>
      )}

      <WaterSection />

      <h3>Detail</h3>

      <label className="param-row">
        <span>Level of detail</span>
        <select
          aria-label="Level of detail"
          value={environment.lod.mode}
          onChange={(event) => setEnvironment({ lod: { mode: event.target.value as LodMode } })}
        >
          {LOD_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {LOD_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>
      <p className="panel-hint">{LOD_MODE_HINTS[environment.lod.mode]}</p>
      <p className="panel-hint">
        The coarse copies are generated when the level loads, from the models themselves — nothing
        is downloaded and nothing is added to an export. Rigged characters keep every triangle:
        averaging bone weights across a joint tears an elbow, which is far more noticeable than the
        saving.
      </p>

      <div className="param-row">
        <span>Draw distance</span>
        <NumberField
          label="Draw distance"
          value={environment.streaming.distance}
          step={10}
          suffix="m"
          onChange={(distance) =>
            setEnvironment({
              streaming: {
                ...environment.streaming,
                distance: Math.max(0, Math.min(5000, distance)),
              },
            })
          }
        />
      </div>
      <p className="panel-hint">
        Zero is off, and off is the absence of the system rather than an enormous distance: no grid
        is built and nothing is tested. Above zero, the level is divided into chunks and the ones
        further away than this are not drawn at all — one distance test per chunk instead of one
        frustum test per mesh.
      </p>
      <label className="param-check">
        <input
          type="checkbox"
          aria-label="Hide what the terrain blocks"
          checked={environment.streaming.occlusion}
          onChange={(event) =>
            setEnvironment({
              streaming: { ...environment.streaming, occlusion: event.target.checked },
            })
          }
        />
        Hide what the terrain blocks
      </label>
      <p className="panel-hint">
        A chunk behind a hill is not drawn. Terrain only — the ground is the one occluder an outdoor
        level reliably has, and testing it is a dozen height samples per chunk against the
        heightfield the collider already uses. A level built from walls and rooms gets nothing from
        this.
      </p>

      {(() => {
        const problems = streamingProblems(
          environment.streaming,
          environment.fog ? environment.fog.far : null,
          terrainRelief,
        );
        if (problems.length === 0) return null;
        return (
          <div className="joint-problems" role="status" aria-label="Draw distance problems">
            {problems.map((problem) => (
              <p key={problem}>{problem}</p>
            ))}
          </div>
        );
      })()}

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

/**
 * Water: whether the level has any, and what kind.
 *
 * Its own component rather than more lines in the panel, for the same reason `SurfaceSection` is:
 * it subscribes to one slice of the document, so dragging a wave-height slider does not re-render
 * every lighting control above it.
 *
 * The order of the controls is the order somebody thinks in. Kind first — pond, lake, sea — because
 * it sets everything else to something sensible and most authors never go further. Height second,
 * because it is the one number that decides whether the water is visible at all. The rest are
 * adjustments, and physics is last because it is the only part that changes how the level plays.
 */
function WaterSection(): React.JSX.Element {
  const water = useSceneStore((state) => state.scene.environment.water);
  const setEnvironment = useSceneStore((state) => state.setEnvironment);

  // Sampled per render rather than subscribed to, like the terrain relief above: it changes when
  // somebody sculpts, which already re-renders this panel through the document.
  const range = liveTerrainRange();
  const problems = water ? waterProblems(water, range) : [];

  return (
    <>
      <h3>Water</h3>

      <label className="param-check">
        <input
          type="checkbox"
          aria-label="Water"
          checked={water !== null}
          onChange={(event) =>
            setEnvironment({ water: event.target.checked ? defaultWater() : null })
          }
        />
        This level has water
      </label>

      {water === null ? (
        <p className="panel-hint">
          Off. No surface is built and no shader is compiled — a level without water costs nothing
          for it.
        </p>
      ) : (
        <>
          <label className="param-row">
            <span>Kind</span>
            <select
              aria-label="Water kind"
              value={water.kind}
              title={WATER_HINTS[water.kind]}
              onChange={(event) => {
                /**
                 * Changing the kind takes its whole preset, keeping only the height and the physics.
                 *
                 * Keeping the sliders and changing the label would make "Sea" mean nothing — the
                 * kind *is* the constants. Keeping the height is the other half: it is where the
                 * author put the waterline, and a preset has no business moving it.
                 */
                const kind = event.target.value as WaterKind;
                setEnvironment({
                  water: {
                    ...defaultWater(kind),
                    height: water.height,
                    color: null,
                    buoyancy: water.buoyancy,
                    buoyancyStrength: water.buoyancyStrength,
                    drag: water.drag,
                  },
                });
              }}
            >
              {WATER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {WATER_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>
          <p className="panel-hint">{WATER_HINTS[water.kind]}</p>

          <NumberField
            label="Surface height"
            value={water.height}
            step={0.25}
            suffix="m"
            onChange={(height) =>
              setEnvironment({ water: { ...water, height: clamp(height, -500, 500) } })
            }
          />
          <p className="panel-hint">
            Ground above this is dry land and below it is underwater, so the shoreline follows
            whatever you sculpt. Sculpt a hollow and it fills.
          </p>

          {problems.length > 0 && (
            <div className="joint-problems" role="status" aria-label="Water problems">
              {problems.map((problem) => (
                <p key={problem}>{problem}</p>
              ))}
            </div>
          )}

          <NumberField
            label="Clarity"
            value={water.clarity}
            step={0.25}
            suffix="m"
            onChange={(clarity) =>
              setEnvironment({ water: { ...water, clarity: clamp(clarity, 0.1, 30) } })
            }
          />
          <p className="panel-hint">
            How far down you can see. It is the strongest cue that water has any depth at all — a
            pond you can see the bottom of reads quite differently from a sea you cannot.
          </p>

          <NumberField
            label="Wave height"
            value={water.waveHeight}
            step={0.01}
            suffix="m"
            onChange={(waveHeight) =>
              setEnvironment({ water: { ...water, waveHeight: clamp(waveHeight, 0, 2) } })
            }
          />
          <NumberField
            label="Wave length"
            value={water.waveScale}
            step={0.5}
            suffix="m"
            onChange={(waveScale) =>
              setEnvironment({ water: { ...water, waveScale: clamp(waveScale, 0.2, 60) } })
            }
          />
          <NumberField
            label="Wave speed"
            value={water.waveSpeed}
            step={0.05}
            onChange={(waveSpeed) =>
              setEnvironment({ water: { ...water, waveSpeed: clamp(waveSpeed, 0, 4) } })
            }
          />

          <label className="param-row">
            <span>Colour</span>
            <input
              type="color"
              aria-label="Water colour"
              value={waterColor(water)}
              onChange={(event) =>
                setEnvironment({ water: { ...water, color: event.target.value } })
              }
            />
          </label>
          {water.color !== null && (
            <button
              type="button"
              onClick={() => setEnvironment({ water: { ...water, color: null } })}
            >
              Back to the {WATER_LABELS[water.kind].toLowerCase()} colour
            </button>
          )}

          <label className="param-check">
            <input
              type="checkbox"
              aria-label="Water buoyancy"
              checked={water.buoyancy}
              onChange={(event) =>
                setEnvironment({ water: { ...water, buoyancy: event.target.checked } })
              }
            />
            Things float and the player swims
          </label>
          <p className="panel-hint">
            {water.buoyancy
              ? 'Objects are lifted by how deep they are, and the player swims once they are chest-deep.'
              : 'Off — the surface is scenery. A moat the player never enters costs nothing in the solver.'}
          </p>

          {water.buoyancy && (
            <>
              <NumberField
                label="Buoyancy"
                value={water.buoyancyStrength}
                step={0.05}
                onChange={(buoyancyStrength) =>
                  setEnvironment({
                    water: { ...water, buoyancyStrength: clamp(buoyancyStrength, 0, 4) },
                  })
                }
              />
              <p className="panel-hint">
                A multiple of an object&rsquo;s own weight. 1 hangs still wherever it is left, below
                that it sinks, above it floats — a stone is about 0.4.
              </p>

              <NumberField
                label="Drag"
                value={water.drag}
                step={0.25}
                onChange={(drag) =>
                  setEnvironment({ water: { ...water, drag: clamp(drag, 0, 10) } })
                }
              />
              <p className="panel-hint">
                How much water slows what moves through it. At zero a crate dropped in bobs forever.
              </p>
            </>
          )}
        </>
      )}
    </>
  );
}
