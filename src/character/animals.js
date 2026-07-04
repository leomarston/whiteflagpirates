// Wildlife: wheeling & diving gull flocks, a bow-riding dolphin pod that leaps
// with splashes, telegraphed circling sharks, reef fish, beach crabs, gliding
// sea turtles, and jungle birds that startle from the canopy.
//
// Everything is instanced or pooled, hot paths allocate nothing, and each group
// is gated by context so the total live count stays well under the 60 budget.
// Nothing updates in menu mode.
//
// Public API (contract): new Animals(ctx); update(dt).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, damp, randRange, TAU } from '../core/utils.js';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);   // identity scale (never mutated)
const _sf = new THREE.Vector3(1, 1, 1);  // flap scale for winged instances

// Active-instance budget. Groups are context-gated, but the worst realistic
// overlap (on foot on a jungle beach that also sits near a reef dive spot):
//   gulls + fish + crabs + turtles + jungle birds = 14+20+10+4+8 = 56 < 60.
// Sailing: gulls + dolphins + fish + turtles = 14+6+20+4 = 44. Never exceeds 60.
const GULL_N = 14;
const DOLPHIN_N = 6;
const FISH_N = 20;
const CRAB_N = 10;
const TURTLE_N = 4;
const JBIRD_N = 8;

function mergeAll(geos) {
  return mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)));
}

// A swept-wing bird silhouette (wings + slim body), ~0.9m span.
function makeBirdGeo() {
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([
    0, 0, 0.12, -0.55, 0.06, -0.1, 0, 0, -0.12,
    0, 0, -0.12, 0.55, 0.06, -0.1, 0, 0, 0.12,
    0, -0.02, 0.25, -0.06, 0.02, -0.2, 0.06, 0.02, -0.2,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

export class Animals {
  constructor(ctx) {
    this.ctx = ctx;

    // ---- gulls: instanced flock that wheels, banks & dives -----------------
    const birdGeo = makeBirdGeo();
    this._birdGeo = birdGeo;
    const gullMat = new THREE.MeshStandardMaterial({ color: 0xe8e8ea, roughness: 0.9, side: THREE.DoubleSide });
    this.gullMesh = new THREE.InstancedMesh(birdGeo, gullMat, GULL_N);
    this.gullMesh.frustumCulled = false;
    this.gullMesh.castShadow = false;
    this.gullMesh.count = 0;
    ctx.scene.add(this.gullMesh);
    this._gullCenter = new THREE.Vector3();
    this._gulls = [];
    for (let i = 0; i < GULL_N; i++) {
      this._gulls.push({
        angle: randRange(Math.random, 0, TAU),
        aSpeed: randRange(Math.random, 0.28, 0.5) * (Math.random() < 0.5 ? 1 : -1),
        radius: randRange(Math.random, 12, 46),
        cruise: randRange(Math.random, 14, 32),
        alt: randRange(Math.random, 14, 32),
        vy: 0,
        flap: randRange(Math.random, 0, TAU),
        flapRate: randRange(Math.random, 7, 10),
        mode: 'wheel',
        modeT: randRange(Math.random, 3, 12),
      });
    }
    this._gullCry = 4;
    this._wheelPhase = 0;

    // ---- dolphins: bow-riding pod ------------------------------------------
    const dolBody = new THREE.CapsuleGeometry(0.24, 1.15, 4, 8); dolBody.rotateX(Math.PI / 2);
    const dorsal = new THREE.ConeGeometry(0.12, 0.34, 4); dorsal.rotateX(-0.3); dorsal.translate(0, 0.26, -0.05);
    const fluke = new THREE.BoxGeometry(0.5, 0.05, 0.22); fluke.translate(0, 0, -0.72);
    const dolphinGeo = mergeAll([dolBody, dorsal, fluke]);
    const dolphinMat = new THREE.MeshStandardMaterial({ color: 0x5a6a78, roughness: 0.35, metalness: 0.1 });
    this.dolphins = [];
    for (let i = 0; i < DOLPHIN_N; i++) {
      const mesh = new THREE.Mesh(dolphinGeo, dolphinMat);
      mesh.visible = false;
      mesh.castShadow = false;
      ctx.scene.add(mesh);
      this.dolphins.push({
        mesh, leap: i * 1.3, side: i % 2 ? 1 : -1,
        offset: 7 + (i >> 1) * 3.2, lat: randRange(Math.random, 4, 6.5),
        rate: randRange(Math.random, 1.3, 1.7), wasUp: false,
      });
    }
    this._dolphinTimer = 20;
    this._dolphinActive = 0;
    this._dolphinAmt = 0;

    // ---- shark: fin + body, circling with a lunge telegraph ----------------
    const sharkMat = new THREE.MeshStandardMaterial({ color: 0x46525c, roughness: 0.6 });
    const finGeo = new THREE.ConeGeometry(0.28, 0.9, 4);
    this.sharkFin = new THREE.Mesh(finGeo, sharkMat);
    this.sharkFin.visible = false; this.sharkFin.castShadow = false;
    ctx.scene.add(this.sharkFin);
    const sBody = new THREE.CapsuleGeometry(0.42, 2.3, 4, 8); sBody.rotateX(Math.PI / 2);
    const sTail = new THREE.ConeGeometry(0.34, 0.8, 4); sTail.rotateX(Math.PI / 2); sTail.translate(0, 0, -1.5);
    this.sharkBody = new THREE.Mesh(mergeAll([sBody, sTail]), sharkMat);
    this.sharkBody.visible = false; this.sharkBody.castShadow = false;
    ctx.scene.add(this.sharkBody);
    this.shark = { angle: 0, radius: 9, biteTimer: 8, lunge: 0, active: false };
    this._sharkWarn = 0;

    // ---- reef fish: shimmering swirl at dive spots -------------------------
    const fishGeo = new THREE.PlaneGeometry(0.22, 0.09);
    const fishMat = new THREE.MeshStandardMaterial({
      color: 0xd8b84a, roughness: 0.4, metalness: 0.5, side: THREE.DoubleSide,
      emissive: 0x704a10, emissiveIntensity: 0.3,
    });
    this.fishMesh = new THREE.InstancedMesh(fishGeo, fishMat, FISH_N);
    this.fishMesh.frustumCulled = false;
    this.fishMesh.castShadow = false;
    this.fishMesh.count = 0;
    ctx.scene.add(this.fishMesh);

    // ---- crabs: beach scuttlers --------------------------------------------
    const crabBody = new THREE.SphereGeometry(0.16, 6, 4); crabBody.scale(1.3, 0.6, 1.0);
    const clawL = new THREE.BoxGeometry(0.06, 0.05, 0.14); clawL.translate(-0.2, 0, 0.1);
    const clawR = new THREE.BoxGeometry(0.06, 0.05, 0.14); clawR.translate(0.2, 0, 0.1);
    const crabGeo = mergeAll([crabBody, clawL, clawR]);
    const crabMat = new THREE.MeshStandardMaterial({ color: 0xc0563a, roughness: 0.7 });
    this.crabMesh = new THREE.InstancedMesh(crabGeo, crabMat, CRAB_N);
    this.crabMesh.frustumCulled = false;
    this.crabMesh.castShadow = false;
    this.crabMesh.count = 0;
    ctx.scene.add(this.crabMesh);
    this._crabs = [];
    for (let i = 0; i < CRAB_N; i++) {
      this._crabs.push({ x: 0, z: 0, y: 0, ang: 0, phase: Math.random() * TAU, waitT: 0, tgt: 0, placed: false });
    }
    this._crabCenter = new THREE.Vector3(1e9, 0, 1e9);

    // ---- sea turtles: slow gliders -----------------------------------------
    const shell = new THREE.SphereGeometry(0.5, 8, 6); shell.scale(1.0, 0.42, 1.25);
    const tHead = new THREE.SphereGeometry(0.14, 6, 5); tHead.scale(1, 0.8, 1.3); tHead.translate(0, -0.02, 0.66);
    const flip = (sx, sz) => { const f = new THREE.BoxGeometry(0.14, 0.05, 0.4); f.translate(sx * 0.42, -0.05, sz * 0.3); return f; };
    const turtleGeo = mergeAll([shell, tHead, flip(-1, 1), flip(1, 1), flip(-1, -1), flip(1, -1)]);
    const turtleMat = new THREE.MeshStandardMaterial({ color: 0x3f5b45, roughness: 0.7 });
    this.turtleMesh = new THREE.InstancedMesh(turtleGeo, turtleMat, TURTLE_N);
    this.turtleMesh.frustumCulled = false;
    this.turtleMesh.castShadow = false;
    this.turtleMesh.count = 0;
    ctx.scene.add(this.turtleMesh);
    this._turtles = [];
    for (let i = 0; i < TURTLE_N; i++) {
      this._turtles.push({
        angle: randRange(Math.random, 0, TAU), aSpeed: randRange(Math.random, 0.12, 0.25) * (Math.random() < 0.5 ? 1 : -1),
        radius: randRange(Math.random, 6, 16), phase: Math.random() * TAU, dive: randRange(Math.random, 0, TAU),
      });
    }
    this._turtleCenter = new THREE.Vector3();
    this._turtleActive = false;

    // ---- jungle birds: startle bursts from the canopy ----------------------
    const jbirdMat = new THREE.MeshStandardMaterial({ color: 0x2fa36b, roughness: 0.8, side: THREE.DoubleSide });
    this.jbirdMesh = new THREE.InstancedMesh(birdGeo, jbirdMat, JBIRD_N);
    this.jbirdMesh.frustumCulled = false;
    this.jbirdMesh.castShadow = false;
    this.jbirdMesh.count = 0;
    ctx.scene.add(this.jbirdMesh);
    this._jbirds = [];
    for (let i = 0; i < JBIRD_N; i++) {
      this._jbirds.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, flap: 0, life: 0 });
    }
    this._jbirdCooldown = randRange(Math.random, 8, 18);
  }

  _hideAll() {
    this.gullMesh.count = 0;
    this.fishMesh.count = 0;
    this.crabMesh.count = 0;
    this.turtleMesh.count = 0;
    this.jbirdMesh.count = 0;
    for (const d of this.dolphins) d.mesh.visible = false;
    this.sharkFin.visible = false;
    this.sharkBody.visible = false;
  }

  update(dt) {
    const ctx = this.ctx;
    if (ctx.mode === 'menu') { this._hideAll(); return; }
    const t = ctx.time.t;
    const focus = ctx.mode === 'foot' ? ctx.character?.position : ctx.playerShip?.ship?.position;
    if (!focus) { this._hideAll(); return; }

    this._updateGulls(dt, t, focus);
    this._updateDolphins(dt, t);
    this._updateShark(dt, t);
    this._updateFish(dt, t, focus);
    this._updateCrabs(dt, t, focus);
    this._updateTurtles(dt, t, focus);
    this._updateJungleBirds(dt, t, focus);
  }

  // -- gulls: shared drifting center; each bird wheels, banks into turns, and
  //    occasionally peels into a dive toward the sea then climbs back up ------
  _updateGulls(dt, t, focus) {
    const near = this.ctx.world?.getNearestPort?.(focus);
    const anchor = near && near.distance < 500 ? near.port.dockPosition : focus;
    this._gullCenter.x = damp(this._gullCenter.x, anchor.x, 0.4, dt);
    this._gullCenter.z = damp(this._gullCenter.z, anchor.z, 0.4, dt);
    // whole-flock breathing so the gyre isn't static
    this._wheelPhase += dt * 0.15;
    const wheel = 0.85 + Math.sin(this._wheelPhase) * 0.18;
    const waterAt = (x, z) => this.ctx.ocean?.getHeight(x, z) ?? 0;

    for (let i = 0; i < GULL_N; i++) {
      const g = this._gulls[i];
      g.angle += g.aSpeed * dt * wheel;
      g.flap += dt * g.flapRate * (g.mode === 'dive' ? 0.4 : 1);
      g.modeT -= dt;

      const x = this._gullCenter.x + Math.cos(g.angle) * g.radius;
      const z = this._gullCenter.z + Math.sin(g.angle) * g.radius;

      // mode logic → target altitude
      let targetAlt = g.cruise + Math.sin(t * 0.5 + i) * 2.5;
      if (g.mode === 'wheel') {
        if (g.modeT <= 0 && Math.random() < 0.4) { g.mode = 'dive'; g.modeT = randRange(Math.random, 1.0, 1.8); }
        else if (g.modeT <= 0) g.modeT = randRange(Math.random, 3, 9);
      } else if (g.mode === 'dive') {
        targetAlt = waterAt(x, z) + 1.6;
        if (g.modeT <= 0) {
          g.mode = 'climb'; g.modeT = randRange(Math.random, 1.5, 2.5);
          if (Math.random() < 0.4) this.ctx.effects?.splash(_p.set(x, waterAt(x, z), z), 0.3);
        }
      } else { // climb
        targetAlt = g.cruise + 4;
        if (g.modeT <= 0) { g.mode = 'wheel'; g.modeT = randRange(Math.random, 3, 9); }
      }

      const newAlt = damp(g.alt, targetAlt, g.mode === 'dive' ? 3.5 : 1.8, dt);
      g.vy = (newAlt - g.alt) / Math.max(dt, 1e-3);
      g.alt = newAlt;

      // orientation: heading along orbit tangent, pitch from climb rate, roll banks into the turn
      const yaw = g.angle + (g.aSpeed >= 0 ? Math.PI / 2 : -Math.PI / 2);
      const pitch = clamp(-g.vy * 0.06, -0.7, 0.7);
      const roll = clamp(g.aSpeed * 0.9, -0.6, 0.6) + Math.sin(g.flap) * 0.28;
      const flapScale = 0.7 + Math.abs(Math.sin(g.flap)) * 0.55;

      _p.set(x, g.alt, z);
      _e.set(pitch, -yaw, roll);
      _q.setFromEuler(_e);
      _sf.set(1, flapScale, 1);
      _m.compose(_p, _q, _sf);
      this.gullMesh.setMatrixAt(i, _m);
    }
    this.gullMesh.count = GULL_N;
    this.gullMesh.instanceMatrix.needsUpdate = true;

    this._gullCry -= dt;
    if (this._gullCry <= 0) {
      this._gullCry = randRange(Math.random, 6, 16);
      if (this._gullCenter.distanceTo(focus) < 120) this.ctx.events?.emit('gull', {});
    }
  }

  // -- dolphins: a pod that surfs ahead of the bow, weaving and leaping in
  //    ballistic arcs with splashes on entry & exit -------------------------
  _updateDolphins(dt, t) {
    const ps = this.ctx.playerShip?.ship;
    const cond = this.ctx.weather?.condition;
    const sailingFast = this.ctx.mode === 'sail' && ps && ps.physics.speed > 4 && (cond === 'clear' || cond === 'fair');

    this._dolphinTimer -= dt;
    if (this._dolphinActive <= 0 && sailingFast && this._dolphinTimer <= 0) {
      this._dolphinActive = randRange(Math.random, 12, 20);
      this._dolphinTimer = randRange(Math.random, 40, 90);
      this.ctx.events?.emit('toast', { text: 'Dolphins riding the bow wave!', kind: 'discover' });
    }
    if (this._dolphinActive > 0 && !sailingFast) this._dolphinActive = Math.min(this._dolphinActive, 1.2);
    if (this._dolphinActive > 0) this._dolphinActive -= dt;

    // smooth fade in/out via a shared amount
    const want = this._dolphinActive > 0 && ps ? 1 : 0;
    this._dolphinAmt = damp(this._dolphinAmt, want, 3, dt);
    if (this._dolphinAmt < 0.02 || !ps) {
      for (const d of this.dolphins) d.mesh.visible = false;
      return;
    }

    const g = ps.group;
    const fwd = ps.physics.heading;
    const sinF = Math.sin(fwd), cosF = Math.cos(fwd);
    for (const d of this.dolphins) {
      d.mesh.visible = true;
      d.leap += dt * d.rate;
      const weave = Math.sin(t * 1.1 + d.leap) * 1.4;
      const along = d.offset + Math.sin(t * 0.6 + d.side) * 1.5;
      const lat = (d.lat + weave) * d.side;
      const bx = g.position.x + sinF * along + cosF * lat;
      const bz = g.position.z + cosF * along - sinF * lat;
      const up = Math.sin(d.leap);
      const y = up > 0 ? up * 1.7 - 0.35 : -0.6;
      d.mesh.position.set(bx, y, bz);
      d.mesh.rotation.y = fwd;
      // pitch nose along the arc (up on the way up, down on the way down)
      d.mesh.rotation.x = -Math.cos(d.leap) * 0.9;
      d.mesh.scale.setScalar(this._dolphinAmt);
      // splash as it breaks / re-enters the surface
      const isUp = up > 0;
      if (isUp !== d.wasUp) {
        d.wasUp = isUp;
        this.ctx.effects?.splash(_p.set(bx, this.ctx.ocean?.getHeight(bx, bz) ?? 0, bz), isUp ? 0.5 : 0.35);
      }
    }
  }

  // -- shark: circles the swimmer, tightens & lunges in for a telegraphed bite
  _updateShark(dt, t) {
    const ch = this.ctx.character;
    const swimming = this.ctx.mode === 'foot' && ch?.isSwimming;
    let deepWater = false;
    if (swimming) {
      const ground = this.ctx.world?.getTerrainHeight?.(ch.position.x, ch.position.z) ?? 0;
      deepWater = ground < -6;
      const near = this.ctx.world?.getNearestPort?.(ch.position);
      if (near && near.distance < 120) deepWater = false;
    }

    if (deepWater && !this.shark.active) {
      this.shark.active = true;
      this.shark.radius = 13;
      this.shark.biteTimer = 6;
      this.shark.lunge = 0;
      this.shark.angle = Math.random() * TAU;
      if (this._sharkWarn <= 0) {
        this._sharkWarn = 20;
        this.ctx.events?.emit('toast', { text: 'A fin cuts the water nearby…', kind: 'warn' });
      }
    }
    if (!deepWater) this.shark.active = false;
    if (this._sharkWarn > 0) this._sharkWarn -= dt;

    this.sharkFin.visible = this.shark.active;
    this.sharkBody.visible = this.shark.active;
    if (!this.shark.active || !ch) return;

    const sh = this.shark;
    sh.biteTimer -= dt;
    // telegraph: in the last ~1.2s before a bite, the shark wheels inward fast
    const winding = sh.biteTimer < 1.2 && sh.lunge <= 0;
    sh.angle += dt * (winding ? 1.4 : 0.7);
    const targetR = winding ? 2.2 : 8;
    sh.radius = damp(sh.radius, targetR, winding ? 3.5 : 1.2, dt);

    const waterY = this.ctx.ocean?.getHeight(ch.position.x, ch.position.z) ?? 0;
    const cx = ch.position.x + Math.cos(sh.angle) * sh.radius;
    const cz = ch.position.z + Math.sin(sh.angle) * sh.radius;
    const finY = waterY - 0.1 + Math.sin(t * 2 + sh.angle) * 0.06;
    this.sharkFin.position.set(cx, finY, cz);
    this.sharkBody.position.set(cx, finY - 0.75, cz);
    // heading tangent + a tail-wag yaw wobble
    const tangent = sh.angle + Math.PI / 2 + Math.sin(t * 6) * 0.12;
    this.sharkFin.rotation.y = -tangent;
    this.sharkBody.rotation.y = -tangent;
    this.sharkBody.rotation.z = Math.sin(t * 6) * 0.12;

    if (sh.biteTimer <= 0 && sh.lunge <= 0) {
      sh.lunge = 0.35;
    }
    if (sh.lunge > 0) {
      sh.lunge -= dt;
      if (sh.lunge <= 0) {
        sh.biteTimer = randRange(Math.random, 7, 10);
        sh.radius = 12;
        ch.applyDamage(12, sh.angle);
        this.ctx.effects?.splash(ch.position, 1.3);
        this.ctx.events?.emit('shake', { amount: 0.4 });
        this.ctx.events?.emit('toast', { text: 'Shark bite! Get to shore!', kind: 'warn' });
      }
    }
  }

  // -- reef fish: shimmering swirl above a dive spot -------------------------
  _updateFish(dt, t, focus) {
    const spots = this.ctx.world?.diveSpots ?? [];
    let spot = null;
    for (const sPt of spots) {
      if (sPt.position.distanceTo(focus) < 60) { spot = sPt; break; }
    }
    if (!spot) { this.fishMesh.count = 0; return; }
    for (let i = 0; i < FISH_N; i++) {
      const a = t * 0.5 + (i / FISH_N) * TAU;
      const r = 2.5 + Math.sin(i * 3.7) * 1.4;
      _p.set(
        spot.position.x + Math.cos(a + i) * r,
        spot.position.y + 1.5 + Math.sin(t * 1.2 + i) * 0.8,
        spot.position.z + Math.sin(a + i) * r,
      );
      _e.set(0, -(a + i) + Math.PI / 2, Math.sin(t * 3 + i) * 0.2);
      _q.setFromEuler(_e);
      _m.compose(_p, _q, _s);
      this.fishMesh.setMatrixAt(i, _m);
    }
    this.fishMesh.count = FISH_N;
    this.fishMesh.instanceMatrix.needsUpdate = true;
  }

  // -- crabs: scatter on the sand near the walking player, scuttle & flee ----
  _updateCrabs(dt, t, focus) {
    const ch = this.ctx.character;
    const active = this.ctx.mode === 'foot' && ch && !ch.isSwimming;
    if (!active) { this.crabMesh.count = 0; return; }
    const world = this.ctx.world;
    // (re)seed the cluster if the player has wandered off the current patch,
    // and only where the ground reads as beach (just above sea level)
    if (this._crabCenter.distanceToSquared(focus) > 900) {
      const gh = world?.getTerrainHeight?.(focus.x, focus.z) ?? -100;
      if (gh > 0.1 && gh < 2.2) {
        this._crabCenter.copy(focus);
        for (const c of this._crabs) {
          c.x = focus.x + randRange(Math.random, -16, 16);
          c.z = focus.z + randRange(Math.random, -16, 16);
          c.ang = randRange(Math.random, 0, TAU);
          c.waitT = randRange(Math.random, 0, 3);
          c.placed = true;
        }
      } else {
        // not on a beach — nothing to show
        this.crabMesh.count = 0;
        this._crabCenter.set(1e9, 0, 1e9);
        return;
      }
    }

    let n = 0;
    for (let i = 0; i < CRAB_N; i++) {
      const c = this._crabs[i];
      if (!c.placed) continue;
      const gh = world?.getTerrainHeight?.(c.x, c.z) ?? -100;
      if (gh < 0.05 || gh > 2.6) continue; // fell off the sand strip → skip
      const dx = c.x - focus.x, dz = c.z - focus.z;
      const pd = Math.hypot(dx, dz);
      if (pd < 3.2) {
        // flee sideways-away from the player, scuttling fast
        const away = Math.atan2(dx, dz);
        c.ang = away + Math.PI / 2 * (i % 2 ? 1 : -1);
        c.x += Math.sin(away) * 2.6 * dt;
        c.z += Math.cos(away) * 2.6 * dt;
        c.phase += dt * 22;
      } else {
        c.waitT -= dt;
        if (c.waitT <= 0) {
          c.waitT = randRange(Math.random, 1.5, 4);
          c.tgt = randRange(Math.random, 0, TAU);
        }
        // sidle toward a lazy heading
        c.x += Math.sin(c.tgt) * 0.5 * dt;
        c.z += Math.cos(c.tgt) * 0.5 * dt;
        c.ang = c.tgt + Math.PI / 2;
        c.phase += dt * 6;
      }
      const bob = Math.abs(Math.sin(c.phase)) * 0.03;
      _p.set(c.x, gh + 0.06 + bob, c.z);
      _e.set(0, c.ang, Math.sin(c.phase) * 0.12);
      _q.setFromEuler(_e);
      _m.compose(_p, _q, _s);
      this.crabMesh.setMatrixAt(n++, _m);
    }
    this.crabMesh.count = n;
    if (n) this.crabMesh.instanceMatrix.needsUpdate = true;
  }

  // -- sea turtles: glide in a loose gyre over a reef, bob & occasionally dive
  _updateTurtles(dt, t, focus) {
    const spots = this.ctx.world?.diveSpots ?? [];
    let anchor = null;
    for (const sPt of spots) {
      if (sPt.position.distanceTo(focus) < 70) { anchor = sPt.position; break; }
    }
    const swimming = this.ctx.mode === 'foot' && this.ctx.character?.isSwimming;
    if (!anchor && swimming) anchor = focus;
    if (!anchor) { this.turtleMesh.count = 0; return; }

    this._turtleCenter.x = damp(this._turtleCenter.x, anchor.x, 0.6, dt);
    this._turtleCenter.z = damp(this._turtleCenter.z, anchor.z, 0.6, dt);
    for (let i = 0; i < TURTLE_N; i++) {
      const tt = this._turtles[i];
      tt.angle += tt.aSpeed * dt;
      tt.phase += dt * 1.4;
      tt.dive += dt * 0.35;
      const x = this._turtleCenter.x + Math.cos(tt.angle) * tt.radius;
      const z = this._turtleCenter.z + Math.sin(tt.angle) * tt.radius;
      const waterY = this.ctx.ocean?.getHeight(x, z) ?? 0;
      const diveOff = Math.max(0, Math.sin(tt.dive)) * 1.4; // dips below now and then
      _p.set(x, waterY - 0.35 - diveOff + Math.sin(tt.phase) * 0.05, z);
      const yaw = tt.angle + (tt.aSpeed >= 0 ? Math.PI / 2 : -Math.PI / 2);
      _e.set(clamp(-Math.cos(tt.dive) * 0.3, -0.4, 0.4), -yaw, Math.sin(tt.phase) * 0.12);
      _q.setFromEuler(_e);
      _m.compose(_p, _q, _s);
      this.turtleMesh.setMatrixAt(i, _m);
    }
    this.turtleMesh.count = TURTLE_N;
    this.turtleMesh.instanceMatrix.needsUpdate = true;
  }

  // -- jungle birds: rest hidden, then burst up from the canopy when the
  //    player moves through a jungle island, scattering & fading out --------
  _updateJungleBirds(dt, t, focus) {
    const ch = this.ctx.character;
    const foot = this.ctx.mode === 'foot' && ch && !ch.isSwimming;
    // trigger a fresh startle
    if (foot) {
      this._jbirdCooldown -= dt;
      if (this._jbirdCooldown <= 0) {
        this._jbirdCooldown = randRange(Math.random, 10, 26);
        const isl = this.ctx.world?.getNearestIsland?.(focus);
        const biome = isl?.island?.def?.biome;
        const onJungle = isl && isl.distance < (isl.island.radius ?? 400) &&
          (biome === 'jungle' || biome === 'tropical' || biome === 'mangrove');
        if (onJungle) this._startleBirds(focus);
      }
    }

    let n = 0;
    for (let i = 0; i < JBIRD_N; i++) {
      const bd = this._jbirds[i];
      if (bd.life <= 0) continue;
      bd.life -= dt;
      bd.flap += dt * 16;
      // climb & fan out, easing upward
      bd.vy = damp(bd.vy, 1.4, 1.5, dt);
      bd.x += bd.vx * dt;
      bd.y += bd.vy * dt;
      bd.z += bd.vz * dt;
      bd.vx *= (1 - 0.6 * dt);
      bd.vz *= (1 - 0.6 * dt);
      const yaw = Math.atan2(bd.vx, bd.vz);
      const roll = Math.sin(bd.flap) * 0.5;
      const flapScale = 0.6 + Math.abs(Math.sin(bd.flap)) * 0.6;
      _p.set(bd.x, bd.y, bd.z);
      _e.set(-0.2, -yaw, roll);
      _q.setFromEuler(_e);
      _sf.set(1, flapScale, 1);
      _m.compose(_p, _q, _sf);
      this.jbirdMesh.setMatrixAt(n++, _m);
    }
    this.jbirdMesh.count = n;
    if (n) this.jbirdMesh.instanceMatrix.needsUpdate = true;
  }

  _startleBirds(focus) {
    const world = this.ctx.world;
    // roost point a little ahead of the player, up in the canopy
    const ang = randRange(Math.random, 0, TAU);
    const dist = randRange(Math.random, 7, 14);
    const rx = focus.x + Math.sin(ang) * dist;
    const rz = focus.z + Math.cos(ang) * dist;
    const gh = world?.getTerrainHeight?.(rx, rz) ?? 0;
    if (gh < 0.5) return; // over water — no trees
    const canopy = gh + randRange(Math.random, 5, 9);
    const count = 6 + Math.floor(Math.random() * (JBIRD_N - 6));
    let spawned = 0;
    for (let i = 0; i < JBIRD_N && spawned < count; i++) {
      const bd = this._jbirds[i];
      if (bd.life > 0) continue;
      const a = Math.random() * TAU;
      const sp = randRange(Math.random, 3, 6);
      bd.x = rx + (Math.random() - 0.5) * 2;
      bd.y = canopy + (Math.random() - 0.5) * 1.5;
      bd.z = rz + (Math.random() - 0.5) * 2;
      bd.vx = Math.sin(a) * sp;
      bd.vz = Math.cos(a) * sp;
      bd.vy = randRange(Math.random, 1.5, 3);
      bd.flap = Math.random() * TAU;
      bd.life = randRange(Math.random, 2.0, 3.2);
      spawned++;
    }
    if (spawned) this.ctx.events?.emit('gull', {});
  }
}
