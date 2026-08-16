import { useMemo } from 'react';
import {
  DRIVE_LABELS,
  DRIVE_LAYOUTS,
  defaultVehicle,
  vehicleProblems,
  type AssetManifest,
  type DriveLayout,
  type SceneObject,
  type Suspension,
  type Vehicle,
  type WheelLayout,
} from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

/**
 * Turning an object into something the player can drive.
 *
 * The panel leads with the two settings that decide whether the car is driveable at all — a Dynamic
 * chassis and some engine power — because everything below them is tuning, and tuning a car that
 * cannot move is a confusing way to spend an afternoon. The suspension numbers come with their
 * failure modes written next to them for the same reason: "24" means nothing, "too soft and it
 * grounds out on every rise" means something.
 */

export function VehiclePanel({
  object,
  manifest,
}: {
  object: SceneObject;
  manifest: AssetManifest;
}): React.JSX.Element {
  const setVehicle = useSceneStore((state) => state.setVehicle);
  const vehicle = object.vehicle;

  const knownAssets = useMemo(
    () => new Set(manifest.assets.map((asset) => asset.id)),
    [manifest.assets],
  );
  const models = useMemo(
    () => manifest.assets.filter((asset) => asset.category !== 'audio'),
    [manifest.assets],
  );

  // The mass and gravity go in too, because the most destructive vehicle mistake — springs too weak
  // to hold the car up — cannot be seen from the vehicle settings alone.
  const gravity = useSceneStore((state) => state.scene.player.gravity);
  const problems = vehicle
    ? vehicleProblems(vehicle, object.physics.body, knownAssets, {
        mass: object.physics.mass ?? 1000,
        gravity,
      })
    : [];
  const update = (patch: Partial<Vehicle>): void => {
    if (vehicle) setVehicle(object.id, { ...vehicle, ...patch });
  };
  const wheels = (patch: Partial<WheelLayout>): void => {
    if (vehicle) update({ wheels: { ...vehicle.wheels, ...patch } });
  };
  const suspension = (patch: Partial<Suspension>): void => {
    if (vehicle) update({ suspension: { ...vehicle.suspension, ...patch } });
  };

  return (
    <section className="panel" aria-label="Vehicle">
      <h2>Vehicle</h2>

      <label className="param-check">
        <input
          type="checkbox"
          aria-label="Vehicle"
          checked={vehicle !== null}
          onChange={(event) =>
            setVehicle(object.id, event.target.checked ? defaultVehicle() : null)
          }
        />
        This can be driven
      </label>

      {vehicle === null && (
        <p className="panel-hint">
          Turning this on makes the object a chassis: four suspension rays, an engine and a seat. It
          needs a Dynamic body under Physics, because the chassis is the only thing that moves.
        </p>
      )}

      {vehicle && (
        <>
          <label className="param-row">
            <span>Wheel model</span>
            <select
              aria-label="Wheel model"
              value={vehicle.wheelAssetId}
              onChange={(event) => update({ wheelAssetId: event.target.value })}
            >
              <option value="">None (invisible wheels)</option>
              {models.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name}
                </option>
              ))}
            </select>
          </label>
          <p className="panel-hint">
            Placed at each suspension ray and spun to match. It collides with nothing — the ray has
            already decided where the wheel is.
          </p>

          <div className="gizmo-modes" role="group" aria-label="Driven wheels">
            {DRIVE_LAYOUTS.map((layout) => (
              <button
                key={layout}
                type="button"
                className={vehicle.drive === layout ? 'active' : ''}
                aria-pressed={vehicle.drive === layout}
                onClick={() => update({ drive: layout as DriveLayout })}
              >
                {DRIVE_LABELS[layout]}
              </button>
            ))}
          </div>

          <h3>Engine</h3>
          <div className="param-row">
            <span>Power</span>
            <NumberField
              label="Engine power"
              scrubLabel=""
              value={vehicle.enginePower}
              step={100}
              suffix="N"
              onChange={(enginePower) => update({ enginePower: Math.max(0, enginePower) })}
            />
          </div>
          <div className="param-row">
            <span>Brakes</span>
            <NumberField
              label="Brake power"
              scrubLabel=""
              value={vehicle.brakePower}
              step={100}
              suffix="N"
              onChange={(brakePower) => update({ brakePower: Math.max(0, brakePower) })}
            />
          </div>
          <div className="param-row">
            <span>Top speed</span>
            <NumberField
              label="Top speed"
              scrubLabel=""
              value={vehicle.maxSpeed}
              step={1}
              suffix="m/s"
              onChange={(maxSpeed) => update({ maxSpeed: Math.max(1, maxSpeed) })}
            />
          </div>

          <h3>Steering</h3>
          <div className="param-row">
            <span>Full lock</span>
            <NumberField
              label="Max steer"
              scrubLabel=""
              value={vehicle.maxSteer}
              step={0.05}
              suffix="rad"
              onChange={(maxSteer) => update({ maxSteer: Math.min(1.5, Math.max(0.01, maxSteer)) })}
            />
          </div>
          <div className="param-row">
            <span>Time to lock</span>
            <NumberField
              label="Steer seconds"
              scrubLabel=""
              value={vehicle.steerSeconds}
              step={0.05}
              suffix="s"
              onChange={(steerSeconds) => update({ steerSeconds: Math.max(0, steerSeconds) })}
            />
          </div>
          {vehicle.steerSeconds === 0 && (
            <p className="panel-hint">
              Instant steering is the single thing that makes a car feel like a toy: the tyre force
              changes direction in one step and the chassis jerks sideways.
            </p>
          )}
          <div className="param-row">
            <span>Lock lost at speed</span>
            <NumberField
              label="Steer speed falloff"
              scrubLabel=""
              value={vehicle.steerSpeedFalloff}
              step={0.05}
              onChange={(value) => update({ steerSpeedFalloff: Math.min(1, Math.max(0, value)) })}
            />
          </div>
          <p className="panel-hint">
            How much of full lock is taken away at top speed. Zero leaves full lock available at
            speed, which spins the car on any input.
          </p>

          <h3>Wheels</h3>
          <div className="param-row">
            <span>Radius</span>
            <NumberField
              label="Wheel radius"
              scrubLabel=""
              value={vehicle.wheels.radius}
              step={0.05}
              suffix="m"
              onChange={(radius) => wheels({ radius: Math.max(0.05, radius) })}
            />
          </div>
          <div className="param-row">
            <span>Axle offset</span>
            <NumberField
              label="Axle offset"
              scrubLabel=""
              value={vehicle.wheels.axleOffset}
              step={0.1}
              suffix="m"
              onChange={(axleOffset) => wheels({ axleOffset: Math.max(0.1, axleOffset) })}
            />
          </div>
          <div className="param-row">
            <span>Track half-width</span>
            <NumberField
              label="Track half width"
              scrubLabel=""
              value={vehicle.wheels.trackHalfWidth}
              step={0.05}
              suffix="m"
              onChange={(trackHalfWidth) =>
                wheels({ trackHalfWidth: Math.max(0.1, trackHalfWidth) })
              }
            />
          </div>
          <div className="param-row">
            <span>Hub height</span>
            <NumberField
              label="Hub height"
              scrubLabel=""
              value={vehicle.wheels.hubHeight}
              step={0.05}
              suffix="m"
              onChange={(hubHeight) => wheels({ hubHeight })}
            />
          </div>

          <h3>Suspension</h3>
          <div className="param-row">
            <span>Rest length</span>
            <NumberField
              label="Suspension rest length"
              scrubLabel=""
              value={vehicle.suspension.restLength}
              step={0.05}
              suffix="m"
              onChange={(restLength) => suspension({ restLength: Math.max(0.01, restLength) })}
            />
          </div>
          <div className="param-row">
            <span>Stiffness</span>
            <NumberField
              label="Suspension stiffness"
              scrubLabel=""
              value={vehicle.suspension.stiffness}
              step={1}
              onChange={(stiffness) => suspension({ stiffness: Math.max(1, stiffness) })}
            />
          </div>
          <p className="panel-hint">
            Too soft and the car wallows and grounds out on every rise; too stiff and it skips off
            bumps and loses grip exactly when it needs it.
          </p>
          <div className="param-row">
            <span>Compression</span>
            <NumberField
              label="Suspension compression"
              scrubLabel=""
              value={vehicle.suspension.compression}
              step={0.1}
              onChange={(compression) => suspension({ compression: Math.max(0, compression) })}
            />
          </div>
          <div className="param-row">
            <span>Relaxation</span>
            <NumberField
              label="Suspension relaxation"
              scrubLabel=""
              value={vehicle.suspension.relaxation}
              step={0.1}
              onChange={(relaxation) => suspension({ relaxation: Math.max(0, relaxation) })}
            />
          </div>
          <div className="param-row">
            <span>Travel</span>
            <NumberField
              label="Suspension travel"
              scrubLabel=""
              value={vehicle.suspension.maxTravel}
              step={0.05}
              suffix="m"
              onChange={(maxTravel) => suspension({ maxTravel: Math.max(0, maxTravel) })}
            />
          </div>

          <h3>Grip</h3>
          <div className="param-row">
            <span>Forward</span>
            <NumberField
              label="Wheel friction"
              scrubLabel=""
              value={vehicle.friction}
              step={0.1}
              onChange={(friction) => update({ friction: Math.max(0, friction) })}
            />
          </div>
          <div className="param-row">
            <span>Sideways</span>
            <NumberField
              label="Side friction"
              scrubLabel=""
              value={vehicle.sideFriction}
              step={0.1}
              onChange={(sideFriction) => update({ sideFriction: Math.max(0, sideFriction) })}
            />
          </div>
          <p className="panel-hint">Lower sideways grip drifts; higher sticks.</p>

          <div className="param-row">
            <span>Get in within</span>
            <NumberField
              label="Enter radius"
              scrubLabel=""
              value={vehicle.enterRadius}
              step={0.5}
              suffix="m"
              onChange={(enterRadius) => update({ enterRadius: Math.max(0.5, enterRadius) })}
            />
          </div>

          {problems.length > 0 && (
            <div className="joint-problems" role="status" aria-label="Vehicle problems">
              {problems.map((problem) => (
                <p key={problem}>{problem}</p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
