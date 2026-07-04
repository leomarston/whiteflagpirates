// Ship entity + fleet registry.
import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep, wrapAngle } from '../core/utils.js';
import { buildShip } from './shipFactory.js';
import { SHIP_TYPES } from './shipTypes.js';
import { ShipPhysics } from './sailing.js';
import { CrewFigures } from './crewFigures.js';

let _shipId = 0;

// module scratch — reused every frame so hot paths allocate nothing
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();

const SINK_DURATION = 13;   // s from mortal blow to gone beneath the waves

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
    this._slamTimer = 0;
    this._sprayFlip = false;
    this._bubbleAcc = 0;
    this._wakeAdded = false;

    // visible battle damage: tattered/darkened canvas, chain-shot wear, smoke
    this._sailDmg = 0;
    this._riggingWear = 0;
    this._smokeTimer = 0;
    this._offRigging = ctx.events?.on('ship:rigging-hit', (e) => {
      if (e?.ship === this) this._riggingWear = clamp01(this._riggingWear + 0.16);
    });

    // living crew on deck — one InstancedMesh, ticked in update, culled by LOD
    try {
      this.crew = new CrewFigures(ctx, this);
      if (this.crew?.object3D) this.group.add(this.crew.object3D);
    } catch (err) {
      this.crew = null;
    }
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
    this.physics.speed *= 0.4;
    // which way she rolls & tips as she founders (kept for the whole sequence)
    this._sinkRoll = Math.random() < 0.5 ? 1 : -1;
    this._sinkPitchDir = Math.random() < 0.5 ? 1 : -1;
    this._sinkHeading = this.physics.heading;
    this.ctx.events?.emit('ship:sunk', { ship: this, byPlayer: !!byPlayer });
    for (const f of this._fires) f.stop?.();
    this._fires.length = 0;

    // the mortal blow: a gout of splinters and a broad wash of foam
    const fx = this.ctx.effects;
    if (fx) {
      const g = this.group;
      const oy = this.ctx.ocean?.getHeight(g.position.x, g.position.z) ?? 0;
      _s1.set(g.position.x, oy + 0.4, g.position.z);
      fx.woodBurst?.(_s1, 10);
      fx.splash?.(_s1, 1.8);
    }
  }

  update(dt) {
    if (!this.alive) return;
    const g = this.group;

    // register with the ocean's wake foam once we're live (player + AI ships)
    if (!this._wakeAdded && this.ctx.ocean?.addWakeSource) {
      this.ctx.ocean.addWakeSource(g);
      this._wakeAdded = true;
    }

    // living crew ticks in both states — they scatter & vanish as she founders
    this.crew?.update(dt);

    if (this.sinking) {
      this._updateSinking(dt);
      return;
    }

    this.physics.update(dt);

    // reload timers tick down here; combat resets them on fire
    this.reloadL = Math.max(0, this.reloadL - dt);
    this.reloadR = Math.max(0, this.reloadR - dt);

    const parts = g.userData.parts;
    const t = this.ctx.time.t;

    // sail cloth + flag uniforms
    const weather = this.ctx.weather;
    const sailShader = parts.sailMat.userData.shader;
    if (sailShader) {
      const rel = weather ? Math.abs(wrapAngle(this.physics.heading - weather.wind.angle)) : 1;
      sailShader.uniforms.uSail.value = damp(sailShader.uniforms.uSail.value, this.sailAmount, 4, dt);
      sailShader.uniforms.uAlign.value = clamp01(1 - Math.max(0, rel - 1.9) / 0.75);
      sailShader.uniforms.uTime.value = t;
    }
    const flagShader = parts.flagMat.userData.shader;
    if (flagShader) flagShader.uniforms.uTime.value = t + this.id * 3.1;

    // night lanterns — warm and softly guttering after dusk
    const sunY = this.ctx.sky?.sunDir.y ?? 1;
    const night = 1 - clamp01((sunY + 0.12) / 0.22);
    const flick = 0.9 + 0.1 * Math.sin(t * 8.3 + this.id) * Math.sin(t * 3.1 + this.id * 2.0);
    parts.lanternMat.emissiveIntensity = (0.25 + night * 2.4) * flick;
    if (parts.lanternLight) parts.lanternLight.intensity = night * 9 * flick;
    if (g.userData.sternWindows) g.userData.sternWindows.emissiveIntensity = night * 1.4;

    this._updateBattleDamage(dt);
    this._updateBowWave(dt);
  }

  // -- visible battle damage: canvas darkens & tatters as she's shot to pieces,
  //    chain shot lets her sails luff & sag, and a badly-holed hull pours smoke.
  _updateBattleDamage(dt) {
    const g = this.group;
    const parts = g.userData?.parts;
    if (!parts) return;

    // chain-shot wear bleeds off slowly so a repaired ship recovers her canvas
    if (this._riggingWear > 0) this._riggingWear = Math.max(0, this._riggingWear - dt * 0.03);

    const hullFrac = this.hullMax > 0 ? this.hull / this.hullMax : 1;
    let dmg = 0;
    if (hullFrac < 0.4) dmg = clamp01((0.4 - hullFrac) / 0.4);
    dmg = Math.max(dmg, this._riggingWear);
    const cap = this.physics?.maxSpeedCap;
    const chain = (cap != null && isFinite(cap)) ? 1 : 0;   // chain-slowed -> sails sag
    this._sailDmg = damp(this._sailDmg, dmg, 3, dt);
    const d = this._sailDmg;

    // darken & dull the cloth (readable at distance)
    const sailMat = parts.sailMat;
    if (sailMat) {
      const c = lerp(1, 0.42, d);
      sailMat.color?.setRGB?.(c, c * 0.97, c * 0.9);
      sailMat.emissiveIntensity = lerp(0.24, 0.06, d);
    }
    // tatter/reef the individual sails; chain-slow lets them sag a touch further
    const sy = lerp(1, 0.72, d) * (1 - 0.1 * chain);
    const sails = parts.sails;
    if (sails) {
      for (let i = 0; i < sails.length; i++) {
        const sm = sails[i];
        if (!sm) continue;
        sm.scale.y = sy;
        sm.scale.x = lerp(1, i % 2 ? 0.9 : 0.96, d);   // uneven, torn head
      }
    }

    // battle smoke pouring from a badly-holed hull — throttled, never per-frame
    if (hullFrac < 0.35) {
      this._smokeTimer -= dt;
      if (this._smokeTimer <= 0) {
        this._smokeTimer = 0.55 + Math.random() * 0.45;
        const fx = this.ctx.effects;
        if (fx?.smoke?.spawn) {
          const type = this.type;
          _s1.set(
            (Math.random() - 0.5) * type.beam * 0.34,
            (parts.deckY ?? 0) + 1.1,
            (Math.random() - 0.5) * type.length * 0.24,
          );
          g.localToWorld(_s1);
          const wind = this.ctx.weather?.wind;
          const wx = wind ? Math.cos(wind.angle) * 1.2 : 0.4;
          const wz = wind ? Math.sin(wind.angle) * 1.2 : 0.2;
          fx.smoke.spawn(
            _s1.x, _s1.y, _s1.z,
            wx * 0.3, 1.4 + Math.random() * 1.2, wz * 0.3,
            1.6 + Math.random() * 1.4, 1.8 + Math.random() * 1.6,
            0.16 + Math.random() * 0.12, (Math.random() - 0.5) * 0.8,
          );
        }
      }
    }
  }

  // -- bow wave & spray: peels off the forefoot, heavier the faster she drives
  _updateBowWave(dt) {
    const spd = this.physics.speed;
    const fx = this.ctx.effects;
    if (!fx) return;
    const g = this.group;
    const type = this.type;

    if (spd > 2.5) {
      this._sprayTimer -= dt;
      if (this._sprayTimer <= 0) {
        this._sprayTimer = clamp(0.34 - spd * 0.012, 0.09, 0.34);
        // alternate the port & starboard bow quarters
        this._sprayFlip = !this._sprayFlip;
        const side = this._sprayFlip ? 1 : -1;
        _s1.set(side * type.beam * 0.32, 0, type.length * 0.46);
        g.localToWorld(_s1);
        _s1.y = (this.ctx.ocean?.getHeight(_s1.x, _s1.z) ?? 0) + 0.1;
        fx.splash?.(_s1, clamp(0.35 + spd / 16, 0.35, 1.3));
      }
    }

    // driving hard, she buries her stem in a swell — a sheet of green water
    this._slamTimer -= dt;
    if (spd > 5 && this._slamTimer <= 0) {
      _s2.set(0, 0, type.length * 0.5);
      g.localToWorld(_s2);
      const oh = this.ctx.ocean?.getHeight(_s2.x, _s2.z) ?? 0;
      if (_s2.y < oh - 0.22) {
        this._slamTimer = 0.45;
        _s2.y = oh + 0.15;
        fx.splash?.(_s2, 1.0 + spd / 12);
      }
    }
  }

  // -- founder & go under: slow heel, accelerating plunge, boiling foam -------
  _updateSinking(dt) {
    const g = this.group;
    const type = this.type;
    this._sinkT += dt;
    const t = clamp01(this._sinkT / SINK_DURATION);

    // roll onto her beam ends and tip as the sea takes her — eased, unhurried
    const heel = this._sinkRoll * 1.0 * smoothstep(0.0, 0.62, t);
    const pitch = this._sinkPitchDir * 0.55 * smoothstep(0.18, 0.95, t);
    g.rotation.set(pitch, this._sinkHeading, heel, 'YXZ');

    // descent starts gentle, then she slides under with a rush
    const rate = 0.45 + t * t * 3.4;
    g.position.y -= dt * rate;

    // boiling foam & rising bubbles around the drowning hull
    const fx = this.ctx.effects;
    if (fx && t < 0.98) {
      this._bubbleAcc -= dt;
      if (this._bubbleAcc <= 0) {
        this._bubbleAcc = 0.14 + Math.random() * 0.18;
        _s1.set((Math.random() - 0.5) * type.length * 0.7, 0, (Math.random() - 0.5) * type.beam * 1.4)
          .applyAxisAngle(_s2.set(0, 1, 0), this._sinkHeading);
        _s1.x += g.position.x;
        _s1.z += g.position.z;
        _s1.y = (this.ctx.ocean?.getHeight(_s1.x, _s1.z) ?? 0) + 0.05;
        fx.splash?.(_s1, 0.3 + Math.random() * 0.35);
        if (Math.random() < 0.25) fx.woodBurst?.(_s1, 2);
      }
    }

    if (t >= 1) {
      // the final plunge — a last wash of foam, wreckage, and a shudder felt
      // by anyone close enough to see her go
      if (fx) {
        _s1.set(g.position.x, (this.ctx.ocean?.getHeight(g.position.x, g.position.z) ?? 0) + 0.2, g.position.z);
        fx.splash?.(_s1, 2.2);
        fx.woodBurst?.(_s1, 8);
      }
      const cam = this.ctx.camera;
      if (cam) {
        const d = Math.hypot(g.position.x - cam.position.x, g.position.z - cam.position.z);
        if (d < 150) this.ctx.events?.emit('shake', { amount: 0.4 * (1 - d / 150) });
      }
      this.alive = false;
      this.ctx.scene.remove(g);
      this.dispose();
    }
  }

  /** Free per-ship GPU resources. Geometries are per-ship (safe); only the
   *  per-ship materials are disposed — shared cached materials/textures aren't. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._offRigging?.();
    this._offRigging = null;
    this.crew?.dispose?.();
    const seen = new Set();
    this.group.traverse((o) => {
      if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    });
    const parts = this.group.userData?.parts;
    for (const m of [parts?.sailMat, parts?.flagMat, parts?.lanternMat, this.group.userData?.sternWindows]) {
      m?.dispose?.();
    }
    parts?.lanternLight?.dispose?.();
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
    ship.dispose?.();
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const ship = this.list[i];
      ship.update(dt);
      if (!ship.alive && ship.sinking) this.list.splice(i, 1);
    }
  }
}
