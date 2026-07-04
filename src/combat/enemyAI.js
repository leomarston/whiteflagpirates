// The enemy fleet: spawning, sailing brains, engagement, loot crates.
import * as THREE from 'three';
import { clamp, randRange, wrapAngle } from '../core/utils.js';

const CAP = 8;
const DESPAWN_DIST = 2600;
const _v = new THREE.Vector3();
const _target = new THREE.Vector3();

export class EnemyFleet {
  constructor(ctx) {
    this.ctx = ctx;
    this.entries = [];       // {ship, brain}
    this.crates = [];        // floating loot
    this._spawnTimer = 6;
    this._rng = Math.random;

    this._crateGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    this._crateMat = new THREE.MeshStandardMaterial({ color: 0x8a6a44, roughness: 0.9 });
    this._mapMat = new THREE.MeshStandardMaterial({ color: 0xc9a24b, roughness: 0.6, emissive: 0x664e1a, emissiveIntensity: 0.4 });

    ctx.events?.on('ship:sunk', ({ ship, byPlayer }) => this._onSunk(ship, byPlayer));
    ctx.events?.on('ship:hit', ({ ship, byPlayer }) => {
      if (!byPlayer) return;
      const entry = this.entries.find((e) => e.ship === ship);
      if (entry) {
        entry.brain.provoked = true;
        if (entry.brain.role === 'trade') entry.brain.state = 'flee';
      }
    });
    ctx.events?.on('spawn:ship', (req) => this._spawnFromEvent(req));
    ctx.events?.on('spawn:loot', ({ pos, contents }) => {
      this._dropCrate(new THREE.Vector3(pos.x ?? pos[0] ?? 0, 0, pos.z ?? pos[2] ?? 0), contents);
    });
  }

  get threatLevel() {
    const ps = this.ctx.playerShip?.ship;
    if (!ps) return 0;
    let level = 0;
    for (const { ship, brain } of this.entries) {
      if (brain.state !== 'engage') continue;
      const d = ship.position.distanceTo(ps.position);
      if (d < 500) return 2;
      if (d < 900) level = 1;
    }
    return level;
  }

  _playerPos() {
    return this.ctx.playerShip?.ship?.position ?? this.ctx.camera.position;
  }

  _spawn(typeKey, faction, role, pos, name) {
    if (this.entries.length >= CAP) return null;
    const names = this.ctx.data?.names;
    const factions = this.ctx.data?.factions;
    const prefix = factions?.[faction]?.shipPrefixes ?? [''];
    const shipName = name ?? `${prefix[Math.floor(Math.random() * prefix.length)]}${names?.shipName?.(Math.random) ?? 'Stray'}`;
    const ship = this.ctx.ships?.createShip(typeKey, { faction, name: shipName });
    if (!ship) return null;
    ship.physics.placeAt(pos.x, pos.z, Math.random() * Math.PI * 2);
    ship.sailAmount = 0.7;
    const brain = {
      role, state: role === 'trade' ? 'trade' : 'patrol',
      provoked: false, announced: false,
      waypoint: new THREE.Vector3(pos.x + randRange(Math.random, -600, 600), 0, pos.z + randRange(Math.random, -600, 600)),
      fleeDropped: false,
      broadsideSide: 'L',
    };
    this.entries.push({ ship, brain });
    return ship;
  }

  _spawnFromEvent(req = {}) {
    const p = this._playerPos();
    const a = Math.random() * Math.PI * 2;
    const d = randRange(Math.random, 800, 1200);
    const pos = { x: p.x + Math.sin(a) * d, z: p.z + Math.cos(a) * d };
    const type = req.typeKey ?? (req.role === 'hunter' ? 'frigate' : 'sloop');
    const ship = this._spawn(type, req.faction ?? 'crown', req.role ?? 'patrol', pos);
    if (ship) ship._brainRole = req.role ?? 'patrol';
    if (ship && req.role === 'hunter') {
      const entry = this.entries.find((e) => e.ship === ship);
      if (entry) { entry.brain.provoked = true; entry.brain.state = 'engage'; }
    }
  }

  _maybeSpawn() {
    if (this.entries.length >= CAP - 2) return;
    const ctx = this.ctx;
    const p = this._playerPos();
    const near = ctx.world?.getNearestPort?.(p);
    if (near && near.distance < 400) return;

    const nearIsl = ctx.world?.getNearestIsland?.(p);
    const roll = Math.random();
    const a = Math.random() * Math.PI * 2;
    const d = randRange(Math.random, 700, 1500);
    const pos = { x: p.x + Math.sin(a) * d, z: p.z + Math.cos(a) * d };

    // don't spawn on land
    if ((ctx.world?.getTerrainHeight(pos.x, pos.z) ?? -30) > -6) return;

    const crownNear = nearIsl?.island.def.faction === 'crown' && nearIsl.distance < 2200;
    if (crownNear && roll < 0.5) {
      this._spawn(Math.random() < 0.4 ? 'frigate' : 'sloop', 'crown', 'patrol', pos);
    } else if (roll < 0.45) {
      this._spawn(Math.random() < 0.6 ? 'merchantman' : 'cutter', 'concern', 'trade', pos);
    } else if (roll < 0.72) {
      this._spawn(Math.random() < 0.5 ? 'brig' : 'sloop', 'corsairs', 'pirate', pos);
    } else if (crownNear || roll < 0.85) {
      this._spawn('sloop', 'crown', 'patrol', pos);
    }
  }

  _onSunk(ship, byPlayer) {
    const i = this.entries.findIndex((e) => e.ship === ship);
    if (i < 0) return;
    const entry = this.entries[i];
    this.entries.splice(i, 1);
    // loot crates from AI ships
    const count = entry.brain.role === 'trade' ? 3 : 1 + Math.floor(Math.random() * 2);
    for (let j = 0; j < count; j++) {
      _v.copy(ship.position);
      _v.x += randRange(Math.random, -8, 8);
      _v.z += randRange(Math.random, -8, 8);
      const goods = this.ctx.data?.goods ?? [];
      const good = goods[Math.floor(Math.random() * goods.length)];
      this._dropCrate(_v, {
        gold: Math.round(randRange(Math.random, 20, 90)),
        goods: good ? { [good.key]: 1 + Math.floor(Math.random() * 3) } : null,
        map: entry.brain.role === 'trade' && Math.random() < 0.15,
      });
    }
  }

  _dropCrate(pos, contents = {}) {
    const mesh = new THREE.Mesh(this._crateGeo, contents.map ? this._mapMat : this._crateMat);
    mesh.position.copy(pos);
    mesh.rotation.y = Math.random() * 6.28;
    this.ctx.scene.add(mesh);
    this.crates.push({ mesh, contents, life: 180, phase: Math.random() * 6.28 });
  }

  _updateBrain(entry, dt) {
    const { ship, brain } = entry;
    const ctx = this.ctx;
    const ps = ctx.playerShip?.ship;
    const p = ship.position;
    const playerDist = ps ? p.distanceTo(ps.position) : Infinity;

    // hostility decisions
    const crownRep = ctx.state?.data?.reputation?.crown ?? 0;
    const corsairRep = ctx.state?.data?.reputation?.corsairs ?? 0;
    const hostileToPlayer =
      brain.provoked ||
      (brain.role === 'pirate' && playerDist < 450 && corsairRep < 60) ||
      (brain.role === 'patrol' && crownRep < -20 && playerDist < 550) ||
      brain.role === 'hunter';

    if (brain.state !== 'flee') {
      if (brain.role === 'trade' && playerDist < 300 && hostileNearby(this, p)) {
        brain.state = 'flee';
      } else if (hostileToPlayer && ps?.alive && playerDist < 900) {
        brain.state = 'engage';
      } else if (brain.state === 'engage') {
        brain.state = brain.role === 'trade' ? 'trade' : 'patrol';
      }
      // low hull → run
      if (ship.hull < ship.hullMax * 0.22 && brain.role !== 'hunter') brain.state = 'flee';
    }

    let desiredHeading = ship.physics.heading;
    let desiredSail = 0.65;

    if (brain.state === 'engage' && ps?.alive) {
      if (!brain.announced) {
        brain.announced = true;
        ctx.events?.emit('toast', { text: `${ship.name} is moving to engage!`, kind: 'warn' });
      }
      const bearing = Math.atan2(ps.position.x - p.x, ps.position.z - p.z);
      const relBearing = wrapAngle(bearing - ship.physics.heading);
      // commit to whichever broadside faces the target and hold it
      brain.broadsideSide = relBearing > 0 ? 'R' : 'L';
      const sideAngle = brain.broadsideSide === 'R' ? Math.PI / 2 : -Math.PI / 2;

      // fight at an optimal broadside range — close if far, sheer off if too near,
      // run parallel to the quarry when in the band so the guns stay on target.
      const OPT = 175;
      if (playerDist > OPT + 90) {
        desiredHeading = bearing - sideAngle * 0.45; // bear down at an angle
        desiredSail = 1;
      } else if (playerDist < OPT - 70) {
        desiredHeading = bearing + sideAngle;        // sheer away, keep guns bearing
        desiredSail = 0.75;
      } else {
        // in the band: match the quarry's course, nudged to hold them abeam
        desiredHeading = ps.physics.heading - wrapAngle(relBearing - sideAngle) * 0.6;
        desiredSail = 0.62;
      }

      // fire a full broadside when the guns bear, target's in range, and reloaded
      if (playerDist < 500 && Math.abs(wrapAngle(relBearing - sideAngle)) < 0.28) {
        const flight = playerDist / 90;
        _target.copy(ps.position);
        _target.x += Math.sin(ps.physics.heading) * ps.physics.speed * flight;
        _target.z += Math.cos(ps.physics.heading) * ps.physics.speed * flight;
        // cripple a fast quarry with chain, else round shot
        const ammo = (ps.physics.speed > 7 && Math.random() < 0.3) ? 'chain' : 'round';
        ctx.combat?.fireBroadside(ship, brain.broadsideSide, {
          type: ammo, spreadRad: 0.055, targetPoint: _target,
        });
      }
    } else if (brain.state === 'flee') {
      const windAngle = ctx.weather?.wind.angle ?? 0;
      desiredHeading = windAngle; // run downwind
      desiredSail = 1;
      if (!brain.fleeDropped && brain.role === 'trade' && Math.random() < dt * 0.1) {
        brain.fleeDropped = true;
        this._dropCrate(p, { goods: { sugar: 2 }, gold: 15 });
        ctx.events?.emit('toast', { text: `${ship.name} is dumping cargo!`, kind: 'info' });
      }
    } else {
      // patrol / trade: waypoints
      const d = Math.hypot(brain.waypoint.x - p.x, brain.waypoint.z - p.z);
      if (d < 120) {
        brain.waypoint.set(
          p.x + randRange(Math.random, -900, 900), 0,
          p.z + randRange(Math.random, -900, 900),
        );
      }
      desiredHeading = Math.atan2(brain.waypoint.x - p.x, brain.waypoint.z - p.z);
      desiredSail = 0.55;
    }

    // avoid running into islands: look ahead
    const world = ctx.world;
    if (world) {
      _v.set(Math.sin(ship.physics.heading), 0, Math.cos(ship.physics.heading));
      const ahead = world.getTerrainHeight(p.x + _v.x * 120, p.z + _v.z * 120);
      if (ahead > -8) {
        desiredHeading += 0.9;
        desiredSail = Math.min(desiredSail, 0.4);
      }
    }

    ship.physics.rudder = clamp(wrapAngle(desiredHeading - ship.physics.heading) * 1.8, -1, 1);
    ship.sailAmount += (desiredSail - ship.sailAmount) * Math.min(1, dt * 1.5);
  }

  update(dt) {
    const ctx = this.ctx;
    if (ctx.mode === 'menu') return;

    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0) {
      this._spawnTimer = 9;
      this._maybeSpawn();
    }

    const p = this._playerPos();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (!entry.ship.alive) {
        this.entries.splice(i, 1);
        continue;
      }
      if (entry.ship.position.distanceTo(p) > DESPAWN_DIST) {
        ctx.ships?.remove(entry.ship);
        this.entries.splice(i, 1);
        continue;
      }
      this._updateBrain(entry, dt);
    }

    // loot crates: bob & collect
    const ps = ctx.playerShip?.ship;
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const crate = this.crates[i];
      crate.life -= dt;
      const m = crate.mesh;
      const h = ctx.ocean?.getHeight(m.position.x, m.position.z) ?? 0;
      m.position.y = h - 0.15 + Math.sin(ctx.time.t * 1.2 + crate.phase) * 0.08;
      m.rotation.x = Math.sin(ctx.time.t * 0.8 + crate.phase) * 0.12;

      let remove = crate.life <= 0;
      if (!remove && ps && m.position.distanceTo(ps.position) < 13) {
        remove = true;
        this._collect(crate.contents);
      }
      if (remove) {
        ctx.scene.remove(m);
        this.crates.splice(i, 1);
      }
    }
  }

  _collect(contents) {
    const ctx = this.ctx;
    const bits = [];
    const goldMult = ctx.progression?.getMod?.('goldFind') ?? 1;
    if (contents.gold) {
      const g = Math.round(contents.gold * goldMult);
      ctx.state?.addGold(g);
      bits.push(`${g} sovereigns`);
    }
    if (contents.goods) {
      const cargo = ctx.state?.data?.cargo ?? {};
      const capacity = ctx.economy?.cargoCapacity?.() ?? 30;
      const used = ctx.economy?.cargoUsed?.() ?? 0;
      for (const [key, qty] of Object.entries(contents.goods)) {
        if (used + qty <= capacity) {
          cargo[key] = (cargo[key] ?? 0) + qty;
          const good = ctx.data?.goods?.find((g) => g.key === key);
          bits.push(`${qty}× ${good?.name ?? key}`);
        } else {
          ctx.state?.addGold(10);
          bits.push('10 sovereigns (hold full)');
        }
      }
    }
    if (contents.map) {
      ctx.treasure?.grantRandomMap?.('flotsam');
      bits.push('a sea-stained map!');
    }
    ctx.events?.emit('loot:collect', contents);
    ctx.events?.emit('toast', { text: `Salvaged: ${bits.join(', ') || 'nothing of note'}`, kind: 'gold' });
  }
}

function hostileNearby(fleet, pos) {
  for (const { ship, brain } of fleet.entries) {
    if (brain.role === 'pirate' && ship.position.distanceTo(pos) < 500) return true;
  }
  return false;
}
