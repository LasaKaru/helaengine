import { useMemo } from 'react';
import type { AssetManifest, SfxBinding } from '@helaengine/schema';
import { SfxBindingSchema } from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

/**
 * Events worth offering in the picker.
 *
 * A suggestion list, not a restriction: the field is a text input underneath, because an author can
 * name their own event from a pickup's `sfxEvent` or a trigger's `emit` action, and a closed list
 * here would make those unreachable. The vocabulary that has to stay closed is what an event can
 * *do*, and that is enforced elsewhere.
 */
const SUGGESTED_EVENTS = [
  'pickup',
  'checkpoint',
  'playerDamaged',
  'playerDied',
  'playerRespawned',
  'enemyDied',
  'enemyAlerted',
  'weaponFired',
  'weaponReloaded',
  'weaponEmpty',
  'secretUnlocked',
];

function VolumeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
}): React.JSX.Element {
  return (
    <div className="param-row">
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        aria-label={label}
        value={Math.round(value * 100)}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
      />
      <span className="audio-readout">{Math.round(value * 100)}%</span>
    </div>
  );
}

function ClipPicker({
  label,
  value,
  clips,
  onChange,
}: {
  label: string;
  value: string | null;
  clips: Array<{ id: string; name: string }>;
  onChange(value: string | null): void;
}): React.JSX.Element {
  return (
    <label className="param-row">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">None</option>
        {clips.map((clip) => (
          <option key={clip.id} value={clip.id}>
            {clip.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function SfxRow({
  binding,
  index,
  clips,
  onChange,
  onRemove,
}: {
  binding: SfxBinding;
  index: number;
  clips: Array<{ id: string; name: string }>;
  onChange(next: SfxBinding): void;
  onRemove(): void;
}): React.JSX.Element {
  return (
    <div className="action-card">
      <div className="behavior-head">
        <input
          type="text"
          aria-label={`Sound ${index + 1} event`}
          list="hela-sfx-events"
          value={binding.event}
          onChange={(event) => onChange({ ...binding, event: event.target.value })}
        />
        <div className="ui-button-actions">
          <button type="button" aria-label={`Remove sound ${index + 1}`} onClick={onRemove}>
            ×
          </button>
        </div>
      </div>

      <label className="param-row">
        <span>Plays</span>
        <select
          aria-label={`Sound ${index + 1} clip`}
          value={binding.assetId}
          onChange={(event) => onChange({ ...binding, assetId: event.target.value })}
        >
          {clips.map((clip) => (
            <option key={clip.id} value={clip.id}>
              {clip.name}
            </option>
          ))}
        </select>
      </label>

      <label className="param-check">
        <input
          type="checkbox"
          aria-label={`Sound ${index + 1} positional`}
          checked={binding.positional}
          onChange={(event) => onChange({ ...binding, positional: event.target.checked })}
        />
        In the world (needs an objectId)
      </label>

      <div className="param-row">
        <span>Volume</span>
        <NumberField
          label={`Sound ${index + 1} volume`}
          scrubLabel=""
          value={binding.volume}
          step={0.05}
          onChange={(value) => onChange({ ...binding, volume: Math.min(1, Math.max(0, value)) })}
        />
      </div>
    </div>
  );
}

/**
 * The scene's sound: which music plays when, and what makes a noise.
 *
 * Sound effects are bound to *event names* rather than to a fixed list of occasions, because the
 * event bus is already what everything in this engine talks through. A pickup's `sfxEvent`, a
 * trigger's `emit` and a weapon's `weaponFired` are all just names, so any of them can be given a
 * clip without the schema growing a field per case.
 */
export function AudioPanel({ manifest }: { manifest: AssetManifest }): React.JSX.Element {
  const audio = useSceneStore((state) => state.scene.audioConfig);
  const setAudioConfig = useSceneStore((state) => state.setAudioConfig);

  const clips = useMemo(
    () =>
      manifest.assets
        .filter((asset) => asset.category === 'audio')
        .map((asset) => ({ id: asset.id, name: asset.name })),
    [manifest],
  );

  const setSfx = (sfx: SfxBinding[]): void => setAudioConfig({ sfx });

  return (
    <section className="panel" aria-label="Audio">
      <h2>Audio</h2>

      {clips.length === 0 ? (
        <p className="panel-hint">
          No audio in the manifest. Run <code>pnpm ingest-assets</code> after adding clips.
        </p>
      ) : (
        <>
          <datalist id="hela-sfx-events">
            {SUGGESTED_EVENTS.map((event) => (
              <option key={event} value={event} />
            ))}
          </datalist>

          <h3>Music</h3>
          <ClipPicker
            label="Menu track"
            value={audio.music.menuTrackAssetId}
            clips={clips}
            onChange={(menuTrackAssetId) => setAudioConfig({ music: { menuTrackAssetId } })}
          />
          <ClipPicker
            label="Exploring track"
            value={audio.music.exploreTrackAssetId}
            clips={clips}
            onChange={(exploreTrackAssetId) => setAudioConfig({ music: { exploreTrackAssetId } })}
          />
          <ClipPicker
            label="Combat track"
            value={audio.music.combatTrackAssetId}
            clips={clips}
            onChange={(combatTrackAssetId) => setAudioConfig({ music: { combatTrackAssetId } })}
          />

          <div className="param-row">
            <span>Crossfade</span>
            <NumberField
              label="Crossfade"
              scrubLabel=""
              value={audio.music.crossfadeSeconds}
              step={0.1}
              suffix="s"
              onChange={(value) =>
                setAudioConfig({ music: { crossfadeSeconds: Math.min(10, Math.max(0, value)) } })
              }
            />
          </div>

          <div className="param-row">
            <span>Combat hold</span>
            <NumberField
              label="Combat hold"
              scrubLabel=""
              value={audio.music.combatHoldSeconds}
              step={1}
              suffix="s"
              onChange={(value) =>
                setAudioConfig({ music: { combatHoldSeconds: Math.min(60, Math.max(0, value)) } })
              }
            />
          </div>

          <h3>Sounds</h3>
          {audio.sfx.length === 0 && (
            <p className="panel-hint">
              Nothing bound. Add a sound and name the event it answers to.
            </p>
          )}

          {audio.sfx.map((binding, index) => (
            <SfxRow
              key={`${index}-${binding.event}`}
              binding={binding}
              index={index}
              clips={clips}
              onChange={(next) =>
                setSfx(audio.sfx.map((entry, at) => (at === index ? next : entry)))
              }
              onRemove={() => setSfx(audio.sfx.filter((_unused, at) => at !== index))}
            />
          ))}

          <button
            type="button"
            className="ui-add"
            aria-label="Add sound"
            disabled={audio.sfx.length >= 48}
            onClick={() =>
              setSfx([
                ...audio.sfx,
                SfxBindingSchema.parse({ event: 'pickup', assetId: clips[0]!.id }),
              ])
            }
          >
            Add sound
          </button>

          <h3>Default levels</h3>
          <VolumeRow
            label="Master"
            value={audio.masterVolume}
            onChange={(masterVolume) => setAudioConfig({ masterVolume })}
          />
          <VolumeRow
            label="Music"
            value={audio.musicVolume}
            onChange={(musicVolume) => setAudioConfig({ musicVolume })}
          />
          <VolumeRow
            label="Effects"
            value={audio.sfxVolume}
            onChange={(sfxVolume) => setAudioConfig({ sfxVolume })}
          />
          <p className="panel-hint">
            The player&rsquo;s own mixer rides on top of these and is stored on their machine, not
            in the scene.
          </p>
        </>
      )}
    </section>
  );
}
