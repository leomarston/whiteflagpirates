// Sailing physics: wind propulsion, rudder, buoyancy on the Gerstner sea.
//
// FEEL GOALS: fast top speed and snappy acceleration (unchanged), but with the
// weight of a real hull layered on top — the helm carries momentum (the bow
// keeps swinging a beat after you centre the rudder), she heels into a hard
// turn and to leeward under press of sail (easing as you bear away), pitches
// over the swell, and squats as she takes up speed. All secondary motion is
// spring-damped so nothing snaps.
import * as THREE from 'three';
import { SHIP_TUNING } from '../core/constants.js';
import { clamp, damp, lerp, wrapAngle } from '../core/utils.js';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Sail efficiency vs relative wind angle (0 = running downwind, π = straight
 * into the wind). Arcade rig: the wind drives hard from EVERY quarter — no
 * no-go cone, no crawling. Best across the wind, only a touch softer dead into
 * it or dead downwind, so you're always fast whichever way you point.
 */
export function sailEfficiency(relAngle) {
  const x = Math.abs(relAngle);
  if (x > 2.4) return lerp(1.0, 0.85, (x - 2.4) / (Math.PI - 2.4)); // into the wind: still strong
  if (x > 0.8) return 1.0;                        // beam to broad reach: full power
  return lerp(0.85, 1.0, x / 0.8);               // dead downwind: nearly full
}

export class ShipPhysics {
  constructor(ctx, ship) {
    this.ctx = ctx;
    this.ship = ship;
    this.heading = 0;
    this.speed = 0;
    this.rudder = 0;
    this.speedMult = 1;      // upgrades / crew bonuses
    this.maxSpeedCap = null; // chainshot slowdowns
    this.yawRate = 0;        // rad/s — carries rotational momentum (read by camera)
    this._heel = 0;          // current roll (rad)  — read by the follow camera
    this._pitch = 0;         // current pitch (rad) — read by the follow camera
    this._accel = 0;         // smoothed surge (m/s²-ish) for squat trim
    this._yAboveWater = 0;
    this._agroundCooldown = 0;
    this.anchored = false;
  }

  placeAt(x, z, heading) {
    const g = this.ship.group;
    g.position.set(x, 0, z);
    this.heading = heading;
    g.rotation.set(0, heading, 0);
    this.speed = 0;
    this.yawRate = 0;
    this._heel = 0;
    this._pitch = 0;
    this._accel = 0;
  }

  update(dt) {
    const { ctx, ship } = this;
    const g = ship.group;
    const type = ship.type;
    const weather = ctx.weather;
    const ocean = ctx.ocean;

    // --- propulsion --------------------------------------------------------
    const windAngle = weather?.wind.angle ?? 0;
    const windSpeed = weather?.wind.speed ?? 6;
    const rel = wrapAngle(this.heading - windAngle);
    const eff = sailEfficiency(rel);
    // strong wind from every side — high floor so she always drives hard
    let vmax = type.maxSpeed * this.speedMult * clamp(0.9 + windSpeed / 24, 0.9, 1.6);
    if (this.maxSpeedCap != null) vmax = Math.min(vmax, this.maxSpeedCap);
    const target = this.anchored ? 0 : vmax * eff * ship.sailAmount;
    // snappy acceleration so pressing W actually sends her going
    const inertia = this.anchored ? 2.2 : 0.85 + type.accel * 0.8;
    const prevSpeed = this.speed;
    this.speed = damp(this.speed, target, inertia, dt);
    // smoothed surge signal (no /dt blow-up): drives bow squat/rise trim
    this._accel = damp(this._accel, (this.speed - prevSpeed) / Math.max(dt, 1e-3), 6, dt);

    // --- steering: rudder authority needs way on, and the turn has weight ---
    // The bow doesn't snap to the rudder — the yaw rate springs toward its
    // target so she winds into a turn and coasts a beat after you centre up.
    const way = clamp(Math.abs(this.speed) / (type.maxSpeed * 0.5), 0, 1);
    const targetYaw = this.rudder * type.turnRate * way * SHIP_TUNING.RUDDER_AUTH;
    // nimble hulls (high turnRate) build & shed their swing faster; a galleon lumbers
    const yawLambda = 1.7 + type.turnRate * 3.2;
    this.yawRate = damp(this.yawRate, targetYaw, yawLambda, dt);
    this.heading += this.yawRate * dt;

    _fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    g.position.addScaledVector(_fwd, this.speed * dt);

    // --- shoaling & run-aground at the bow ---------------------------------
    // Instead of slamming to a stop, drag builds smoothly as the bow enters
    // water shallower than the draft — the ship eases to rest near the beach.
    // A real grounding (ramming near-dry land) still stops her and dings the hull.
    this._agroundCooldown -= dt;
    const world = ctx.world;
    if (world) {
      _p.copy(g.position).addScaledVector(_fwd, type.length * 0.45);
      const ground = world.getTerrainHeight(_p.x, _p.z);
      const shoalStart = -type.draft * 1.5;
      if (ground > shoalStart) {
        const shoal = clamp((ground - shoalStart) / (type.draft * 1.5), 0, 1);
        this.speed *= Math.exp(-shoal * 3.5 * dt);           // progressive drag
        if (ground > -type.draft * 0.25 && this.speed > 0.4) {
          // actually hitting dry-ish land — stop and take the knock
          g.position.addScaledVector(_fwd, -this.speed * dt);
          this.speed *= 0.35;
          this.yawRate *= 0.4;
          if (this._agroundCooldown <= 0) {
            this._agroundCooldown = 4;
            ship.applyDamage?.(SHIP_TUNING.AGROUND_DAMAGE, null);
            ctx.events?.emit('ship:aground', { ship });
          }
        }
      }
    }

    // --- buoyancy: 4-point sampling → heave/pitch/roll ---------------------
    if (ocean && !ship.sinking) {
      const L = type.length * 0.38;
      const Bm = type.beam * 0.5;
      _right.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
      const hBow = ocean.getHeight(g.position.x + _fwd.x * L, g.position.z + _fwd.z * L);
      const hStern = ocean.getHeight(g.position.x - _fwd.x * L, g.position.z - _fwd.z * L);
      const hPort = ocean.getHeight(g.position.x - _right.x * Bm, g.position.z - _right.z * Bm);
      const hStar = ocean.getHeight(g.position.x + _right.x * Bm, g.position.z + _right.z * Bm);
      const hMid = (hBow + hStern + hPort + hStar) / 4;

      const targetY = hMid + 0.12;
      this._yAboveWater = damp(this._yAboveWater, targetY, SHIP_TUNING.BUOY_SPRING, dt);
      g.position.y = this._yAboveWater;

      // pitch: ride the swell fore-and-aft, plus a touch of stern-squat / bow-rise
      // as she takes up speed (accelerating lifts the bow; braking digs it in).
      const swellPitch = Math.atan2(hStern - hBow, L * 2) * 0.85;
      const squat = clamp(this._accel * 0.014, -0.05, 0.05);
      this._pitch = damp(this._pitch, swellPitch - squat, 3.4, dt);

      // roll: wave slop + wind heel to leeward (eases as you bear away / dowse
      // sail) + a bank into a hard turn that grows with speed.
      const swellRoll = Math.atan2(hPort - hStar, Bm * 2) * 0.7;
      const lateral = Math.sin(rel);                                   // beam-on wind → most heel
      const press = ship.sailAmount * clamp(windSpeed / 14, 0, 1.2);
      const heelWind = -lateral * press * 0.15;
      const speedFrac = clamp(this.speed / type.maxSpeed, 0, 1.3);
      const turnHeel = clamp(-this.yawRate * speedFrac * 0.9, -0.16, 0.16);
      const targetRoll = swellRoll + heelWind + turnHeel;
      this._heel = damp(this._heel, targetRoll, 2.8, dt);

      g.rotation.set(this._pitch, this.heading, this._heel, 'YXZ');
    } else {
      g.rotation.y = this.heading;
    }
  }
}
