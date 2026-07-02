// Wildlife: gull flocks, bow-riding dolphins, circling sharks, reef fish.
import * as THREE from 'three';
import { clamp, randRange, TAU } from '../core/utils.js';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);

export class Animals {
  constructor(ctx) {
    this.ctx = ctx;

    // ---- gulls: one instanced cross-shape, banked & flapped via matrices ----
    const gullGeo = new THREE.BufferGeometry();
    // simple bird: two wing triangles + body sliver
    const verts = new Float32Array([
      // left wing
      0, 0, 0.12, -0.55, 0.06, -0.1, 0, 0, -0.12,
      // right wing
      0, 0, -0.12, 0.55, 0.06, -0.1, 0, 0, 0.12,
      // body
      0, -0.02, 0.25, -0.06, 0.02, -0.2, 0.06, 0.02, -0.2,
    ]);
    gullGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    gullGeo.computeVertexNormals();
    const gullMat = new THREE.MeshStandardMaterial({ color: 0xe8e8ea, roughness: 0.9, side: THREE.DoubleSide });
    this.gullCount = 14;
    this.gullMesh = new THREE.InstancedMesh(gullGeo, gullMat, this.gullCount);
    this.gullMesh.frustumCulled = false;
    ctx.scene.add(this.gullMesh);
    this.gulls = [];
    for (let i = 0; i < this.gullCount; i++) {
      this.gulls.push({
        angle: randRange(Math.random, 0, TAU),
        radius: randRange(Math.random, 14, 46),
        height: randRange(Math.random, 14, 34),
        speed: randRange(Math.random, 0.25, 0.5),
        flap: randRange(Math.random, 0, TAU),
        center: new THREE.Vector3(),
      });
    }
    this._gullCry = 4;

    // ---- dolphins ----
    const dolphinGeo = new THREE.CapsuleGeometry(0.22, 1.1, 3, 6);
    dolphinGeo.rotateX(Math.PI / 2);
    const dolphinMat = new THREE.MeshStandardMaterial({ color: 0x5a6a78, roughness: 0.4 });
    this.dolphins = [];
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(dolphinGeo, dolphinMat);
      mesh.visible = false;
      ctx.scene.add(mesh);
      this.dolphins.push({ mesh, phase: i * 1.7, side: i % 2 ? 1 : -1, offset: 6 + i * 2.4 });
    }
    this._dolphinTimer = 20;
    this._dolphinActive = 0;

    // ---- shark ----
    const finGeo = new THREE.ConeGeometry(0.28, 0.9, 4);
    const sharkMat = new THREE.MeshStandardMaterial({ color: 0x46525c, roughness: 0.6 });
    this.sharkFin = new THREE.Mesh(finGeo, sharkMat);
    this.sharkFin.visible = false;
    ctx.scene.add(this.sharkFin);
    const bodyGeo = new THREE.CapsuleGeometry(0.4, 2.2, 3, 6);
    bodyGeo.rotateX(Math.PI / 2);
    this.sharkBody = new THREE.Mesh(bodyGeo, sharkMat);
    this.sharkBody.visible = false;
    ctx.scene.add(this.sharkBody);
    this.shark = { angle: 0, radius: 9, biteTimer: 8, active: false };

    // ---- reef fish: shimmering swirl near dive spots ----
    const fishGeo = new THREE.PlaneGeometry(0.22, 0.09);
    const fishMat = new THREE.MeshStandardMaterial({
      color: 0xd8b84a, roughness: 0.4, metalness: 0.5, side: THREE.DoubleSide,
      emissive: 0x704a10, emissiveIntensity: 0.3,
    });
    this.fishCount = 40;
    this.fishMesh = new THREE.InstancedMesh(fishGeo, fishMat, this.fishCount);
    this.fishMesh.frustumCulled = false;
    this.fishMesh.visible = false;
    ctx.scene.add(this.fishMesh);
  }

  update(dt) {
    const ctx = this.ctx;
    if (ctx.mode === 'menu') return;
    const t = ctx.time.t;
    const focus = ctx.mode === 'foot' ? ctx.character?.position : ctx.playerShip?.ship?.position;
    if (!focus) return;

    this._updateGulls(dt, t, focus);
    this._updateDolphins(dt, t);
    this._updateShark(dt, t);
    this._updateFish(dt, t, focus);
  }

  _updateGulls(dt, t, focus) {
    // flock anchor: nearest port or the player's mast
    const near = this.ctx.world?.getNearestPort?.(focus);
    const anchor = near && near.distance < 500 ? near.port.dockPosition : focus;

    for (let i = 0; i < this.gullCount; i++) {
      const g = this.gulls[i];
      g.center.lerp(anchor, dt * 0.2);
      g.angle += g.speed * dt;
      g.flap += dt * (5 + g.speed * 6);
      _p.set(
        g.center.x + Math.cos(g.angle) * g.radius,
        Math.max(g.height + Math.sin(t * 0.6 + i) * 3, 8),
        g.center.z + Math.sin(g.angle) * g.radius,
      );
      const bank = Math.sin(g.flap) * 0.5;
      _e.set(bank * 0.4, -g.angle, bank);
      _q.setFromEuler(_e);
      _m.compose(_p, _q, _s);
      this.gullMesh.setMatrixAt(i, _m);
    }
    this.gullMesh.instanceMatrix.needsUpdate = true;

    this._gullCry -= dt;
    if (this._gullCry <= 0) {
      this._gullCry = randRange(Math.random, 6, 18);
      if (this.gulls[0].center.distanceTo(focus) < 120) {
        this.ctx.events?.emit('gull', {});
      }
    }
  }

  _updateDolphins(dt, t) {
    const ps = this.ctx.playerShip?.ship;
    const sailingFast = this.ctx.mode === 'sail' && ps && ps.physics.speed > 4 &&
      (this.ctx.weather?.condition === 'clear' || this.ctx.weather?.condition === 'fair');

    this._dolphinTimer -= dt;
    if (this._dolphinActive <= 0 && sailingFast && this._dolphinTimer <= 0) {
      this._dolphinActive = randRange(Math.random, 12, 20);
      this._dolphinTimer = randRange(Math.random, 40, 90);
      this.ctx.events?.emit('toast', { text: 'Dolphins riding the bow wave!', kind: 'discover' });
    }
    if (this._dolphinActive > 0) {
      this._dolphinActive -= dt;
      for (const d of this.dolphins) {
        d.mesh.visible = !!ps && this._dolphinActive > 0;
        if (!d.mesh.visible) continue;
        d.phase += dt * 1.6;
        const g = ps.group;
        const fwd = ps.physics.heading;
        const leap = Math.sin(d.phase);
        _p.set(
          g.position.x + Math.sin(fwd) * d.offset + Math.cos(fwd) * d.side * 5,
          leap > 0 ? leap * 1.6 - 0.4 : -0.6,
          g.position.z + Math.cos(fwd) * d.offset - Math.sin(fwd) * d.side * 5,
        );
        d.mesh.position.copy(_p);
        d.mesh.rotation.y = fwd;
        d.mesh.rotation.x = -Math.cos(d.phase) * 0.8;
        if (leap > 0 && Math.sin(d.phase - dt * 1.6) <= 0) {
          _p.y = 0;
          this.ctx.effects?.splash(_p, 0.4);
        }
      }
    } else {
      for (const d of this.dolphins) d.mesh.visible = false;
    }
  }

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
      this.shark.radius = 12;
      this.shark.biteTimer = 6;
      this.ctx.events?.emit('toast', { text: 'A fin cuts the water nearby…', kind: 'warn' });
    }
    if (!deepWater) this.shark.active = false;

    this.sharkFin.visible = this.shark.active;
    this.sharkBody.visible = this.shark.active;
    if (!this.shark.active || !ch) return;

    this.shark.angle += dt * 0.7;
    this.shark.radius = Math.max(3, this.shark.radius - dt * 0.7);
    this.shark.biteTimer -= dt;
    const waterY = this.ctx.ocean?.getHeight(ch.position.x, ch.position.z) ?? 0;
    _p.set(
      ch.position.x + Math.cos(this.shark.angle) * this.shark.radius,
      waterY - 0.15,
      ch.position.z + Math.sin(this.shark.angle) * this.shark.radius,
    );
    this.sharkFin.position.copy(_p);
    this.sharkBody.position.set(_p.x, _p.y - 0.8, _p.z);
    const headingTangent = this.shark.angle + Math.PI / 2;
    this.sharkFin.rotation.y = -headingTangent;
    this.sharkBody.rotation.y = -headingTangent;

    if (this.shark.biteTimer <= 0) {
      this.shark.biteTimer = 8;
      this.shark.radius = 12;
      ch.applyDamage(12, this.shark.angle);
      this.ctx.effects?.splash(ch.position, 1.2);
      this.ctx.events?.emit('toast', { text: 'Shark bite! Get to shore!', kind: 'warn' });
    }
  }

  _updateFish(dt, t, focus) {
    const spots = this.ctx.world?.diveSpots ?? [];
    let spot = null;
    for (const s of spots) {
      if (s.position.distanceTo(focus) < 60) { spot = s; break; }
    }
    this.fishMesh.visible = !!spot;
    if (!spot) return;
    for (let i = 0; i < this.fishCount; i++) {
      const a = t * 0.5 + (i / this.fishCount) * TAU;
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
    this.fishMesh.instanceMatrix.needsUpdate = true;
  }
}
