// Sailing physics: wind propulsion, rudder, buoyancy on the Gerstner sea.
import * as THREE from 'three';
import { SHIP_TUNING } from '../core/constants.js';
import { clamp, damp, lerp, wrapAngle } from '../core/utils.js';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Sail efficiency vs relative wind angle (0 = running downwind, π = in irons). */
export function sailEfficiency(relAngle) {
  const x = Math.abs(relAngle);
  if (x > 2.65) return 0;                       // no-go cone (~30° into the wind)
  if (x > 1.9) return lerp(1.0, 0, (x - 1.9) / 0.75); // close hauled fade
  if (x > 0.9) return lerp(0.78, 1.0, (x - 0.9) / 1.0); // beam → broad reach peak
  return lerp(0.55, 0.78, x / 0.9);             // dead run is lazy
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
    this._heel = 0;
    this._pitch = 0;
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
  }

  update(dt) {
    const { ctx, ship } = this;
    const g = ship.group;
    const type = ship.type;
    const weather = ctx.weather;
    const ocean = ctx.ocean;

    // --- propulsion ---
    const windAngle = weather?.wind.angle ?? 0;
    const windSpeed = weather?.wind.speed ?? 6;
    const rel = wrapAngle(this.heading - windAngle);
    const eff = sailEfficiency(rel);
    let vmax = type.maxSpeed * this.speedMult * clamp(windSpeed / 9, 0.45, 1.35);
    if (this.maxSpeedCap != null) vmax = Math.min(vmax, this.maxSpeedCap);
    const target = this.anchored ? 0 : vmax * eff * ship.sailAmount;
    const inertia = this.anchored ? 1.6 : type.accel * 0.28;
    this.speed = damp(this.speed, target, inertia, dt);

    // --- steering (needs way on) ---
    const way = clamp(Math.abs(this.speed) / (type.maxSpeed * 0.5), 0, 1);
    this.heading += this.rudder * type.turnRate * way * SHIP_TUNING.RUDDER_AUTH * dt;

    _fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    g.position.addScaledVector(_fwd, this.speed * dt);

    // --- run aground check at the bow ---
    this._agroundCooldown -= dt;
    const world = ctx.world;
    if (world && this.speed > 0.5) {
      _p.copy(g.position).addScaledVector(_fwd, type.length * 0.45);
      const ground = world.getTerrainHeight(_p.x, _p.z);
      if (ground > -type.draft * 0.9) {
        g.position.addScaledVector(_fwd, -this.speed * dt * 1.2);
        this.speed *= 0.25;
        if (this._agroundCooldown <= 0) {
          this._agroundCooldown = 3;
          ship.applyDamage?.(SHIP_TUNING.AGROUND_DAMAGE, null);
          ctx.events?.emit('ship:aground', { ship });
        }
      }
    }

    // --- buoyancy: 4-point sampling → heave/pitch/roll ---
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

      const targetPitch = Math.atan2(hStern - hBow, L * 2) * 0.85;
      this._pitch = damp(this._pitch, targetPitch, 3.4, dt);

      // wind heel: lateral wind pressure rolls the ship
      const lateral = Math.sin(rel);
      const heelWind = -lateral * ship.sailAmount * clamp(windSpeed / 14, 0, 1.2) * 0.13;
      const targetRoll = Math.atan2(hPort - hStar, Bm * 2) * 0.7 + heelWind;
      this._heel = damp(this._heel, targetRoll, 2.8, dt);

      g.rotation.set(this._pitch, this.heading, this._heel, 'YXZ');
    } else {
      g.rotation.y = this.heading;
    }
  }
}
