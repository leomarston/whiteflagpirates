// Naval combat: cannonballs, broadsides, damage, player gunnery, boarding offers.
//
// Combat feel: firing your own broadside and taking hits push a decaying shake
// signal. It is surfaced two ways so the camera owner can pick either:
//   • event  'shake' { amount }   (amount 0..1, additive trauma)
//   • value  ctx.combat.shake     (current smoothed shake, 0..1, decays ~2.4/s)
// (main.js already turns 'shake', 'cannon:fire' isPlayer, and 'ship:hit' onPlayer
// into camera trauma; these are additive and capped, so they compound safely.)
import * as THREE from 'three';
import { COMBAT } from '../core/constants.js';
import { clamp } from '../core/utils.js';

const MAX_BALLS = 48;
const _v = new THREE.Vector3();
const _local = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);

const AMMO = {
  round: { dmg: COMBAT.ROUNDSHOT_DMG, speed: COMBAT.BALL_SPEED, label: 'Round shot' },
  chain: { dmg: COMBAT.CHAINSHOT_DMG, speed: COMBAT.BALL_SPEED * 0.85, label: 'Chain shot' },
  grape: { dmg: COMBAT.GRAPESHOT_DMG, speed: COMBAT.BALL_SPEED * 0.7, label: 'Grape shot' },
};

const TRAIL_INTERVAL = 0.028; // s between projectile trail wisps

export class NavalCombat {
  constructor(ctx) {
    this.ctx = ctx;
    this.playerAmmo = 'round';
    this.shake = 0; // decaying combat shake, readable as ctx.combat.shake
    // Nearest live enemy the player is engaging, refreshed each frame in update().
    // Shape: { ship, name, faction, hullFrac, crewCount, boardable, distance } | null.
    // Reused across frames; nulled out when nothing qualifies. HUD reads ctx.combat.currentTarget.
    this.currentTarget = null;

    this.balls = [];
    for (let i = 0; i < MAX_BALLS; i++) {
      this.balls.push({
        alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(),
        type: 'round', firedBy: null, isPlayer: false, life: 0, trailAcc: 0,
      });
    }
    this.ballMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.18, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x14140f, roughness: 0.45, metalness: 0.6 }),
      MAX_BALLS,
    );
    this.ballMesh.count = 0;
    this.ballMesh.frustumCulled = false;
    this.ballMesh.castShadow = false;
    ctx.scene.add(this.ballMesh);

    this._pending = [];   // staggered per-cannon shots
    this._chainSlow = new Map(); // ship -> timer
    this._offered = new WeakSet();

    ctx.events?.on('boarding:resolve', ({ victory, ship }) => {
      if (victory && ship?.alive && !ship.sinking) {
        ship._lastHitByPlayer = true;
        ship.sink(true);
      }
    });

    // A sunk ship's magazine cooks off — punctuate the kill (near camera only).
    ctx.events?.on('ship:sunk', ({ ship }) => this._onSunk(ship));
  }

  _addShake(amount) {
    this.shake = Math.min(1, this.shake + amount);
    this.ctx.events?.emit('shake', { amount });
  }

  _onSunk(ship) {
    if (!ship?.group) return;
    const p = ship.position;
    const cam = this.ctx.camera?.position;
    const dist = cam ? cam.distanceTo(p) : 0;
    if (dist > 1400) return; // don't spend particles off-screen
    const len = ship.type?.length ?? 20;
    const wy = (this.ctx.ocean?.getHeight(p.x, p.z) ?? p.y) + len * 0.14;
    _v.set(p.x, wy, p.z);
    this.ctx.effects?.explosion(_v, clamp(len / 22, 0.85, 2.4));
    this.ctx.effects?.woodBurst?.(_v, 8);
    if (dist < 260) this._addShake(clamp(0.5 - dist / 700, 0.12, 0.5));
  }

  reloadTimeFor(ship) {
    let t = COMBAT.RELOAD_TIME;
    if (ship.isPlayer) {
      t /= this.ctx.progression?.getMod?.('reloadSpeed') ?? 1;
      t /= this.ctx.crew?.reloadBonus?.() ?? 1;
    } else {
      t *= 1.25;
    }
    return t;
  }

  /** Returns true if the broadside fired. */
  fireBroadside(ship, side, { type = 'round', spreadRad = 0.035, targetPoint = null } = {}) {
    if (!ship?.alive || ship.sinking) return false;
    const reloadKey = side === 'L' ? 'reloadL' : 'reloadR';
    if (ship[reloadKey] > 0) return false;
    ship[reloadKey] = this.reloadTimeFor(ship);

    const parts = ship.group.userData.parts;
    const points = side === 'L' ? parts.firePointsL : parts.firePointsR;
    for (let i = 0; i < points.length; i++) {
      this._pending.push({
        ship, side, type, targetPoint: targetPoint ? targetPoint.clone() : null,
        local: points[i], delay: i * (0.11 + Math.random() * 0.09), spreadRad,
        isPlayer: ship.isPlayer,
      });
    }
    // recoil kick when the captain pulls the lanyard on their own broadside
    if (ship.isPlayer) this._addShake(0.18 + Math.min(points.length, 10) * 0.014);
    return true;
  }

  _fireOne(job) {
    const { ship, side, type, targetPoint, local, spreadRad } = job;
    if (!ship.alive || ship.sinking) return;
    const ammo = AMMO[type] ?? AMMO.round;

    _v.copy(local).applyMatrix4(ship.group.matrixWorld);

    // base direction: abeam of the ship
    const heading = ship.physics.heading;
    const sideSign = side === 'L' ? -1 : 1;
    _dir.set(Math.cos(heading) * sideSign, 0, -Math.sin(heading) * sideSign);

    // elevation: solve roughly for target range, else default arc
    let elev = 0.045;
    if (targetPoint) {
      const range = Math.hypot(targetPoint.x - _v.x, targetPoint.z - _v.z);
      const s2 = clamp((range * COMBAT.BALL_GRAVITY) / (ammo.speed * ammo.speed), 0, 0.95);
      elev = 0.5 * Math.asin(s2);
    }
    _dir.y = Math.tan(elev);
    _dir.normalize();

    // spread
    _dir.x += (Math.random() - 0.5) * spreadRad * 2;
    _dir.y += (Math.random() - 0.5) * spreadRad;
    _dir.z += (Math.random() - 0.5) * spreadRad * 2;
    _dir.normalize();

    const ball = this.balls.find((b) => !b.alive) ?? this.balls[0];
    ball.alive = true;
    ball.p.copy(_v);
    ball.v.copy(_dir).multiplyScalar(ammo.speed);
    ball.type = type;
    ball.firedBy = ship;
    ball.isPlayer = ship.isPlayer;
    ball.life = COMBAT.MAX_RANGE / ammo.speed + 2;
    ball.trailAcc = 0;

    // cannon flash scales with ship (pistols elsewhere pass the default 1)
    const mscale = clamp(1.1 + (ship.type?.length ?? 20) / 70, 1.1, 1.9);
    this.ctx.effects?.muzzleFlash(_v, _dir, mscale);
    this.ctx.events?.emit('cannon:fire', { ship, pos: _v.clone(), isPlayer: ship.isPlayer });
  }

  _hitShip(ball) {
    const ships = this.ctx.ships?.list ?? [];
    for (const ship of ships) {
      if (!ship.alive || ship.sinking || ship === ball.firedBy) continue;
      _local.copy(ball.p);
      ship.group.worldToLocal(_local);
      const t = ship.type;
      if (
        Math.abs(_local.x) < t.beam / 2 + 0.4 &&
        _local.y > -t.draft && _local.y < t.freeboard + 6 &&
        Math.abs(_local.z) < t.length / 2 + 0.5
      ) {
        return ship;
      }
    }
    return null;
  }

  update(dt) {
    const ctx = this.ctx;

    // shake decays toward rest
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2.4);

    // staggered shots
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const job = this._pending[i];
      job.delay -= dt;
      if (job.delay <= 0) {
        this._pending.splice(i, 1);
        this._fireOne(job);
      }
    }

    // chainshot slowdowns decay
    for (const [ship, timer] of this._chainSlow) {
      const left = timer - dt;
      if (left <= 0 || !ship.alive) {
        ship.physics.maxSpeedCap = null;
        this._chainSlow.delete(ship);
      } else {
        this._chainSlow.set(ship, left);
      }
    }

    // simulate balls
    let n = 0;
    for (const ball of this.balls) {
      if (!ball.alive) continue;
      ball.life -= dt;
      ball.v.y -= COMBAT.BALL_GRAVITY * dt;
      ball.p.addScaledVector(ball.v, dt);

      let dead = ball.life <= 0;

      if (!dead) {
        const hit = this._hitShip(ball);
        if (hit) {
          dead = true;
          const ammo = AMMO[ball.type] ?? AMMO.round;
          let dmg = ammo.dmg * (0.85 + Math.random() * 0.3);
          if (ball.type === 'chain') {
            this._chainSlow.set(hit, 12);
            hit.physics.maxSpeedCap = hit.type.maxSpeed * 0.5;
            // rigging/sail damage cue — a chain shot tore through the sails
            ctx.events?.emit('ship:rigging-hit', { ship: hit });
          }
          if (ball.type === 'grape') {
            hit.crewCount = Math.max(0, hit.crewCount - (1 + Math.floor(Math.random() * 2)));
            dmg *= hit === ctx.playerShip?.ship ? 1 : 0.8;
          }
          if (ball.isPlayer) {
            dmg *= ctx.progression?.getMod?.('cannonDamage') ?? 1;
            hit._lastHitByPlayer = true;
          }
          hit.applyDamage(dmg, ball.p);
          // punchy impact feedback
          ctx.effects?.woodBurst(ball.p, 8);
          ctx.effects?.sparks(ball.p, 8);
          const onPlayer = hit === ctx.playerShip?.ship;
          if (onPlayer) this._addShake(clamp(0.15 + dmg / hit.hullMax * 1.3, 0.15, 0.5));
          ctx.events?.emit('ship:hit', {
            ship: hit, byPlayer: ball.isPlayer, onPlayer,
          });
        }
      }

      if (!dead) {
        const waterY = ctx.ocean?.getHeight(ball.p.x, ball.p.z) ?? 0;
        if (ball.p.y <= waterY) {
          dead = true;
          _v.set(ball.p.x, waterY, ball.p.z);
          ctx.effects?.splash(_v, 1.05);
        } else if (ctx.world && ball.p.y <= ctx.world.getTerrainHeight(ball.p.x, ball.p.z)) {
          dead = true;
          ctx.effects?.woodBurst(ball.p, 4);
          ctx.effects?.sparks(ball.p, 5);
        }
      }

      if (dead) {
        ball.alive = false;
        continue;
      }

      // smoke tracer trailing the shot
      ball.trailAcc += dt;
      if (ball.trailAcc >= TRAIL_INTERVAL) {
        ball.trailAcc = 0;
        ctx.effects?.trail?.(ball.p);
      }

      _m.compose(ball.p, _q, _s);
      this.ballMesh.setMatrixAt(n++, _m);
    }
    this.ballMesh.count = n;
    if (n) this.ballMesh.instanceMatrix.needsUpdate = true;

    this._updatePlayerGunnery();
    this._updateBoardingOffers();
    this._updateTarget();
  }

  /** Maintain ctx.combat.currentTarget: the single enemy the player is engaging.
   *  Nearest live enemy within range, biased toward one abeam/ahead (ships behind
   *  the player are penalised). No per-frame Vector3 allocation. */
  _updateTarget() {
    const ctx = this.ctx;
    const ship = ctx.playerShip?.ship;
    if (ctx.mode !== 'sail' || !ship || !ship.alive || ship.sinking) {
      this.currentTarget = null;
      return;
    }
    const p = ship.group.position;
    const heading = ship.physics.heading;
    // forward unit vector (same heading->world mapping used for target leading below)
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const RANGE = 450;
    let best = null, bestScore = Infinity, bestD = 0;
    for (const s of ctx.ships?.list ?? []) {
      if (s === ship || s.isPlayer || !s.alive || s.sinking) continue;
      const dx = s.position.x - p.x, dz = s.position.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > RANGE) continue;
      // bias: penalise ships well behind the player so abeam/ahead contacts win ties
      const fwd = d > 0.001 ? (dx * fx + dz * fz) / d : 1; // cos angle off the bow, -1..1
      const score = d * (fwd < -0.3 ? 1.6 : 1);
      if (score < bestScore) { bestScore = score; best = s; bestD = d; }
    }
    if (!best) { this.currentTarget = null; return; }
    let t = this.currentTarget;
    if (!t) t = this.currentTarget = {};
    t.ship = best;
    t.name = best.name;
    t.faction = best.faction;
    t.hullFrac = clamp(best.hull / best.hullMax, 0, 1);
    t.crewCount = best.crewCount;
    t.boardable = best.hull < best.hullMax * 0.25;
    t.distance = bestD;
  }

  _updatePlayerGunnery() {
    const ctx = this.ctx;
    if (ctx.mode !== 'sail' || ctx.time.paused) {
      ctx.events?.emit('aim:update', { side: null });
      return;
    }
    const input = ctx.input;
    const ps = ctx.playerShip;
    const ship = ps?.ship;
    if (!ship) return;

    // ammo selection
    for (const [key, code] of [['round', 'Digit1'], ['chain', 'Digit2'], ['grape', 'Digit3']]) {
      if (input.wasPressed(code) && this.playerAmmo !== key) {
        this.playerAmmo = key;
        ctx.events?.emit('toast', { text: `${AMMO[key].label} loaded.`, kind: 'info' });
      }
    }

    const side = ps.aimSide;
    if (side) {
      const reload = side === 'L' ? ship.reloadL : ship.reloadR;
      ctx.events?.emit('aim:update', {
        side, ready: reload <= 0, reload,
        reloadMax: this.reloadTimeFor(ship), ammo: this.playerAmmo,
      });
      if (input.mouse.wasPressed(0)) {
        this.fireBroadside(ship, side, {
          type: this.playerAmmo,
          targetPoint: this._playerTargetPoint(ship, side),
        });
      }
    } else {
      ctx.events?.emit('aim:update', { side: null });
    }
  }

  /** Range the player's broadside: aim at the nearest enemy on the fired side
   *  (led by flight time), else a sensible mid-range point abeam so the shot
   *  actually arcs out instead of always plopping down at the default elevation. */
  _playerTargetPoint(ship, side) {
    const heading = ship.physics.heading;
    const sideSign = side === 'L' ? -1 : 1;
    const ax = Math.cos(heading) * sideSign, az = -Math.sin(heading) * sideSign;
    const p = ship.group.position;
    let best = null, bestD = COMBAT.MAX_RANGE;
    for (const s of this.ctx.ships?.list ?? []) {
      if (s === ship || !s.alive || s.sinking) continue;
      const dx = s.position.x - p.x, dz = s.position.z - p.z;
      if (dx * ax + dz * az < 30) continue;          // must be on the aimed side
      const d = Math.hypot(dx, dz);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best) {
      const flight = bestD / COMBAT.BALL_SPEED;
      _v.copy(best.position);
      _v.x += Math.sin(best.physics.heading) * best.physics.speed * flight;
      _v.z += Math.cos(best.physics.heading) * best.physics.speed * flight;
      return _v.clone();
    }
    return new THREE.Vector3(p.x + ax * 260, 0, p.z + az * 260);
  }

  _updateBoardingOffers() {
    const ctx = this.ctx;
    const ps = ctx.playerShip?.ship;
    if (!ps || ctx.mode !== 'sail') return;
    for (const ship of ctx.ships?.list ?? []) {
      if (ship === ps || ship.isPlayer) continue;
      // Track boardability on the ship itself so other systems can read it without
      // listening for the offer event (a ship is boardable once hull < 25%).
      const boardable = ship.alive && !ship.sinking && ship.hull < ship.hullMax * 0.25;
      ship._boardable = boardable;
      if (!boardable) continue;
      if (this._offered.has(ship)) continue;
      if (ship.position.distanceTo(ps.position) > COMBAT.BOARD_RANGE) continue;
      this._offered.add(ship);
      ctx.events?.emit('boarding:offer', { ship });
    }
  }
}

export { AMMO };
