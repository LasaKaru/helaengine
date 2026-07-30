import type { Weapon } from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

/** A weapon stat that is a plain number, described once so the form is a loop rather than a wall. */
interface StatField {
  key: keyof Weapon;
  label: string;
  step: number;
  suffix?: string;
  min: number;
  max: number;
  /** Rounds, clips and magazines are whole things; damage and seconds are not. */
  integer?: boolean;
}

const STATS: StatField[] = [
  { key: 'damage', label: 'Damage', step: 1, min: 0, max: 10_000 },
  { key: 'range', label: 'Range', step: 5, suffix: 'm', min: 1, max: 500 },
  { key: 'fireInterval', label: 'Fire interval', step: 0.05, suffix: 's', min: 0.02, max: 10 },
  { key: 'clipSize', label: 'Clip size', step: 1, min: 0, max: 500, integer: true },
  { key: 'reserveAmmo', label: 'Reserve ammo', step: 5, min: 0, max: 9999, integer: true },
  { key: 'reloadSeconds', label: 'Reload time', step: 0.1, suffix: 's', min: 0, max: 10 },
  { key: 'spreadDegrees', label: 'Spread', step: 0.5, suffix: '°', min: 0, max: 45 },
];

function WeaponCard({ weapon, index }: { weapon: Weapon; index: number }): React.JSX.Element {
  const setWeapon = useSceneStore((state) => state.setWeapon);
  const removeWeapon = useSceneStore((state) => state.removeWeapon);
  const toggleStartingWeapon = useSceneStore((state) => state.toggleStartingWeapon);
  const starting = useSceneStore((state) => state.scene.inventory.startingWeaponIds);

  return (
    <div className="action-card">
      <div className="behavior-head">
        <input
          type="text"
          aria-label={`Weapon ${index + 1} name`}
          value={weapon.name}
          onChange={(event) => setWeapon(weapon.id, { name: event.target.value })}
        />
        <div className="ui-button-actions">
          <button
            type="button"
            aria-label={`Remove weapon ${index + 1}`}
            onClick={() => removeWeapon(weapon.id)}
          >
            ×
          </button>
        </div>
      </div>

      <label className="param-check">
        <input
          type="checkbox"
          // Labelled per weapon: a catalogue with two entries has two of each of these, and
          // "Player starts with this" alone tells neither a screen reader nor a test which one.
          aria-label={`Weapon ${index + 1} starting`}
          checked={starting.includes(weapon.id)}
          onChange={() => toggleStartingWeapon(weapon.id)}
        />
        Player starts with this
      </label>

      <label className="param-check">
        <input
          type="checkbox"
          aria-label={`Weapon ${index + 1} automatic`}
          checked={weapon.automatic}
          onChange={(event) => setWeapon(weapon.id, { automatic: event.target.checked })}
        />
        Automatic (hold to fire)
      </label>

      {STATS.map((stat) => (
        <div className="param-row" key={stat.key}>
          <span>{stat.label}</span>
          <NumberField
            label={`Weapon ${index + 1} ${stat.label.toLowerCase()}`}
            scrubLabel=""
            value={weapon[stat.key] as number}
            step={stat.step}
            {...(stat.suffix ? { suffix: stat.suffix } : {})}
            onChange={(value) => {
              const clamped = Math.min(stat.max, Math.max(stat.min, value));
              setWeapon(weapon.id, {
                [stat.key]: stat.integer ? Math.round(clamped) : clamped,
              } as Partial<Weapon>);
            }}
          />
        </div>
      ))}

      {weapon.clipSize === 0 && (
        <p className="panel-hint">No clip: this weapon never reloads and never runs out.</p>
      )}
    </div>
  );
}

/**
 * The scene's weapon catalogue and starting loadout.
 *
 * A catalogue rather than per-object stats, because a pistol is one thing described once and
 * granted by however many crates the level has. That indirection is the same one `assetId` makes,
 * and it is what stops a rebalance from being a search-and-replace across the whole document.
 */
export function WeaponsPanel(): React.JSX.Element {
  const weapons = useSceneStore((state) => state.scene.inventory.weapons);
  const maxCarried = useSceneStore((state) => state.scene.inventory.maxCarried);
  const addWeapon = useSceneStore((state) => state.addWeapon);
  const setInventory = useSceneStore((state) => state.setInventory);

  return (
    <section className="panel" aria-label="Weapons">
      <h2>Weapons</h2>

      {weapons.length === 0 && (
        <p className="panel-hint">
          No weapons yet. Add one, then attach a Pickup behaviour to an object to grant it.
        </p>
      )}

      {weapons.map((weapon, index) => (
        <WeaponCard key={weapon.id} weapon={weapon} index={index} />
      ))}

      <button type="button" className="ui-add" aria-label="Add weapon" onClick={() => addWeapon()}>
        Add weapon
      </button>

      <div className="param-row">
        <span>Carry limit</span>
        <NumberField
          label="Carry limit"
          scrubLabel=""
          value={maxCarried}
          step={1}
          onChange={(value) =>
            setInventory({ maxCarried: Math.round(Math.min(16, Math.max(1, value))) })
          }
        />
      </div>
    </section>
  );
}
