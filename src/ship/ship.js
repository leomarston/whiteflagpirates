// Ship entity + fleet registry.
import * as THREE from 'three';
import { COMBAT } from '../core/constants.js';
import { clamp01, damp, wrapAngle } from '../core/utils.js';
import { buildShip } from './shipFactory.js';
import { SHIP_TYPES } from './shipTypes.js';
import { ShipPhysics } from './sailing.js';

let _shipId = 0;

export class Ship {
  constructor(ctx, typeKey, opts = {}) {
    this.ctx = ctx;
    this.id = ++_shipId;
    this.typeKey = typeKey;
    this.type = SHIP_TYPES[typeKey] ?? SHIP_TYPES.sloop;
    this.faction = opts.faction ?? 'corsairs';
    this.isPlayer = !!opts.player;
    this.name = opts.name ?? this.type.name;

    const factionData = ctx.data?.factions?.[this.faction];
    this.group = buildShip(typeKey, {
      faction: factionData,
      paint: opts.paint,
      player: this.isPlayer,
    });
    ctx.scene.add(this.group);

    this.physics = new ShipPhysics(ctx, this);
    this.hullMax = this.type.hullMax * (opts.hullMult ?? 1);
    this.hull = this.hullMax;
    this.sailAmount = 0;
    this.alive = true;
    this.sinking = false;
    this._sinkT = 0;
    this.reloadL = 0;
    this.reloadR = 0;
    this.crewCount = opts.crewCount ?? Math.round(this.type.crewMax * 0.7);
    this._fires = [];
    this._sprayTimer = 0;
  }

  get position() {
    return this.group.position;
  }

  applyDamage(amount, point) {
    if (!this.alive || this.sinking) return;
    this.hull -= amount;
    if (point && amount >= 8 && this.hull < this.hullMax * 0.5 && this._fires.length < 2) {
      // heavy hits below half hull can start fires
      if (Math.random() < 0.3) {
        const local = this.group.worldToLocal(point.clone());
        const handle = this.ctx.effects?.fire?.(this.group, local);
        if (handle) this._fires.push(handle);
      }
    }
    if (this.hull <= 0) {
      this.hull = 0;
      this.sink();
    }
  }

  sink(byPlayer = this._lastHitByPlayer) {
    if (this.sinking || !this.alive) return;
    this.sinking = true;
    this._sinkT = 0;
    this.sailAmount = 0;
    this.ctx.events?.emit('ship:sunk', { ship: this, byPlayer: !!byPlayer });
    for (const f of this._fires) f.stop?.();
    this._fires.length = 0;
  }

  update(dt) {
    if (!this.alive) return;
    const g = this.group;

    if (this.sinking) {
      this._sinkT += dt;
      const t = this._sinkT / 12;
      g.position.y -= dt * (0.6 + t * 1.8);
      g.rotation.x += dt * 0.05;
      g.rotation.z += dt * 0.035;
      if (this._sinkT > 1 && Math.random() < dt * 3) {
        this.ctx.effects?.splash?.(g.position, 1.4);
      }
      if (t >= 1) {
        this.alive = false;
        this.ctx.scene.remove(g);
      }
      return;
    }

    this.physics.update(dt);

    // reload timers tick down here; combat resets them on fire
    this.reloadL = Math.max(0, this.reloadL - dt);
    this.reloadR = Math.max(0, this.reloadR - dt);

    // sail cloth + flag uniforms
    const parts = g.userData.parts;
    const weather = this.ctx.weather;
    const sailShader = parts.sailMat.userData.shader;
    if (sailShader) {
      const rel = weather ? Math.abs(wrapAngle(this.physics.heading - weather.wind.angle)) : 1;
      sailShader.uniforms.uSail.value = damp(sailShader.uniforms.uSail.value, this.sailAmount, 4, dt);
      sailShader.uniforms.uAlign.value = clamp01(1 - Math.max(0, rel - 1.9) / 0.75);
      sailShader.uniforms.uTime.value = this.ctx.time.t;
    }
    const flagShader = parts.flagMat.userData.shader;
    if (flagShader) flagShader.uniforms.uTime.value = this.ctx.time.t + this.id * 3.1;

    // night lanterns
    const sunY = this.ctx.sky?.sunDir.y ?? 1;
    const night = 1 - clamp01((sunY + 0.12) / 0.22);
    parts.lanternMat.emissiveIntensity = 0.25 + night * 2.4;
    if (parts.lanternLight) parts.lanternLight.intensity = night * 9;
    if (g.userData.sternWindows) g.userData.sternWindows.emissiveIntensity = night * 1.4;

    // bow spray when driving hard
    this._sprayTimer -= dt;
    if (this.physics.speed > 4.5 && this._sprayTimer <= 0) {
      this._sprayTimer = 0.4 + Math.random() * 0.3;
      const bow = g.localToWorld(new THREE.Vector3(0, 0, this.type.length * 0.46));
      bow.y = this.ctx.ocean?.getHeight(bow.x, bow.z) ?? 0;
      this.ctx.effects?.splash?.(bow, 0.5 + this.physics.speed / 12);
    }
  }
}

export class ShipManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.list = [];
  }

  createShip(typeKey, opts = {}) {
    const ship = new Ship(this.ctx, typeKey, opts);
    this.list.push(ship);
    return ship;
  }

  remove(ship) {
    const i = this.list.indexOf(ship);
    if (i >= 0) this.list.splice(i, 1);
    if (ship.group.parent) this.ctx.scene.remove(ship.group);
    ship.alive = false;
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const ship = this.list[i];
      ship.update(dt);
      if (!ship.alive && ship.sinking) this.list.splice(i, 1);
    }
  }
}
