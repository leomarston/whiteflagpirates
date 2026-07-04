// Living crew on deck: a handful of simple, stylised deckhands standing and
// working a ship's weather deck — a helmsman at the wheel, hands amidships on
// the lines, and gunners at the batteries. All of them ride in a SINGLE
// InstancedMesh per ship (merged torso+head+limbs), so a whole crew costs ~1
// draw call. A gentle idle sway/bob/work motion is driven by ctx.time.t with a
// per-figure phase; nothing allocates in the update loop (module scratch only).
//
// Contract (kept small & defensive):
//   new CrewFigures(ctx, ship) -> { object3D, update(dt), dispose() }
//   Ship adds crew.object3D to its group, ticks update(dt), disposes on sink.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, clamp01, TAU } from '../core/utils.js';

// module scratch — reused every frame so the deck-crew tick allocates nothing
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);   // identity scale (never mutated)
const _scl = new THREE.Vector3(1, 1, 1); // working scale (sink shrink)
const _col = new THREE.Color();

const CULL_DIST = 220;                    // m: beyond this AI crew wink out (LOD)

// A single ~1.65m stylised deckhand: stout torso, round head, a suggestion of
// legs and arms. Feet sit at local y=0 so a figure drops straight onto the deck.
function makeCrewGeo() {
  const torso = new THREE.BoxGeometry(0.42, 0.6, 0.26); torso.translate(0, 1.05, 0);
  const head = new THREE.SphereGeometry(0.13, 8, 6); head.translate(0, 1.5, 0);
  const legL = new THREE.BoxGeometry(0.15, 0.72, 0.18); legL.translate(-0.11, 0.36, 0);
  const legR = new THREE.BoxGeometry(0.15, 0.72, 0.18); legR.translate(0.11, 0.36, 0);
  const armL = new THREE.BoxGeometry(0.12, 0.5, 0.15); armL.rotateZ(0.12); armL.translate(-0.28, 1.12, 0.02);
  const armR = new THREE.BoxGeometry(0.12, 0.5, 0.15); armR.rotateZ(-0.12); armR.translate(0.28, 1.12, 0.02);
  const geo = mergeGeometries([torso, head, legL, legR, armL, armR].map((g) => (g.index ? g.toNonIndexed() : g)));
  torso.dispose(); head.dispose(); legL.dispose(); legR.dispose(); armL.dispose(); armR.dispose();
  return geo;
}

// Earthy slops & jackets — a little variety across the watch.
const CLOTH_TONES = [0x6a5a44, 0x4a5560, 0x5e4a3a, 0x7a6a4c, 0x3f4a52, 0x6e5238];

export class CrewFigures {
  constructor(ctx, ship) {
    this.ctx = ctx;
    this.ship = ship;
    this.object3D = null;
    this.mesh = null;
    this._sinkT = 0;

    const parts = ship?.group?.userData?.parts;
    const type = ship?.type;
    if (!parts || !type) return;            // exotic hull with no deck — no crew

    const L = type.length ?? 18;
    const B = type.beam ?? 5;
    const F = type.freeboard ?? 1.8;
    const deckY = parts.deckY ?? 0;
    const qRaise = clamp(F * 0.42, 0.5, 1.1);   // matches shipFactory quarterdeck lift

    // nominal full manning — figures thin out as grape shot drops crewCount
    this.crew0 = Math.max(1, ship.crewCount ?? Math.round((type.crewMax ?? 8) * 0.7));

    // ---- lay out the watch: helmsman (always) -> hands -> gunners ----------
    const slots = [];
    const push = (x, y, z, ry, kind) => {
      const a = Math.random() * TAU;
      slots.push({
        x, y, z, ry, kind,
        phase: Math.random() * TAU,
        rate: 0.8 + Math.random() * 0.6,
        // per-kind idle character: bob height, fore/aft lean, side sway
        bob: kind === 'gun' ? 0.05 : kind === 'hand' ? 0.035 : 0.02,
        lean: kind === 'hand' ? 0.16 : kind === 'gun' ? 0.12 : 0.05,
        sway: kind === 'helm' ? 0.06 : 0.04,
        yaw: kind === 'helm' ? 0.06 : 0.0,   // helmsman works the wheel
        // scatter direction used when she founders
        scX: Math.cos(a), scZ: Math.sin(a),
      });
    };

    // helmsman just abaft the wheel on the raised quarterdeck, facing the bow
    push(B * 0.06, deckY + qRaise, -L * 0.32 - 0.55, 0, 'helm');

    // hands amidships working the lines (scaled with rig size)
    const nHands = clamp((type.masts ?? 1) + 1, 2, 3);
    const handSpots = [
      [-B * 0.16, L * 0.02, Math.PI * 0.5],
      [B * 0.18, -L * 0.04, -Math.PI * 0.5],
      [0, L * 0.12, Math.PI],
    ];
    for (let i = 0; i < nHands; i++) {
      const h = handSpots[i];
      push(h[0], deckY, h[1], h[2], 'hand');
    }

    // gunners inboard of the batteries, facing outboard to their guns
    const nGun = (type.cannonsPerSide ?? 2) >= 6 ? 2 : 1;
    const gunSpots = [
      [-B * 0.3, -L * 0.06, -Math.PI * 0.5],
      [B * 0.3, L * 0.04, Math.PI * 0.5],
    ];
    for (let i = 0; i < nGun; i++) {
      const gspot = gunSpots[i];
      push(gspot[0], deckY, gspot[1], gspot[2], 'gun');
    }

    this.slots = slots;
    this.max = slots.length;

    // ---- one InstancedMesh for the whole watch ----------------------------
    const geo = makeCrewGeo();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0.0 });
    this._geo = geo;
    this._mat = mat;
    const mesh = new THREE.InstancedMesh(geo, mat, this.max);
    mesh.name = 'crew';
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;             // group moves; skip broken per-instance culling
    // seed matrices + per-figure clothing tone so nothing renders unposed
    for (let i = 0; i < this.max; i++) {
      const sl = slots[i];
      _p.set(sl.x, sl.y, sl.z);
      _e.set(0, sl.ry, 0, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      _col.setHex(CLOTH_TONES[i % CLOTH_TONES.length]);
      mesh.setColorAt(i, _col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.mesh = mesh;
    this.object3D = mesh;
  }

  update(dt) {
    const mesh = this.mesh;
    if (!mesh) return;
    const ship = this.ship;
    const ctx = this.ctx;

    // LOD: distant AI crews wink out to protect the frame; the player's own
    // deck always stays manned so her ship never reads as a ghost.
    if (!ship?.isPlayer) {
      const cam = ctx?.camera;
      const g = ship?.group;
      if (cam && g) {
        const dx = g.position.x - cam.position.x;
        const dz = g.position.z - cam.position.z;
        if (dx * dx + dz * dz > CULL_DIST * CULL_DIST) {
          if (mesh.visible) mesh.visible = false;
          return;
        }
      }
    }

    if (ship?.sinking) { this._updateSinking(dt); return; }
    if (!mesh.visible) mesh.visible = true;

    // thin the watch as grape shot kills crew — never below the lone helmsman
    const frac = clamp01((ship?.crewCount ?? this.crew0) / this.crew0);
    mesh.count = clamp(Math.round(this.max * frac), 1, this.max);

    const t = ctx?.time?.t ?? 0;
    const n = mesh.count;
    for (let i = 0; i < n; i++) {
      const sl = this.slots[i];
      const ph = t * sl.rate + sl.phase;
      const bobY = Math.sin(ph * 2.0) * sl.bob;
      const lean = Math.sin(ph) * sl.lean;                 // rock fore/aft at work
      const sway = Math.sin(ph * 0.7 + 1.3) * sl.sway;     // gentle side roll
      const yaw = sl.ry + (sl.yaw ? Math.sin(ph * 1.4) * sl.yaw : 0);
      _e.set(lean, yaw, sway, 'YXZ');
      _q.setFromEuler(_e);
      _p.set(sl.x, sl.y + bobY, sl.z);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  // she's foundering: the watch scatters outward and dwindles, then vanishes.
  _updateSinking(dt) {
    const mesh = this.mesh;
    this._sinkT += dt;
    const shrink = clamp01(1 - this._sinkT / 1.6);
    if (shrink <= 0) { if (mesh.visible) mesh.visible = false; return; }
    const t = this.ctx?.time?.t ?? 0;
    const out = this._sinkT * 1.5;
    const n = mesh.count || this.max;
    for (let i = 0; i < n; i++) {
      const sl = this.slots[i];
      _p.set(
        sl.x + sl.scX * out,
        sl.y + Math.sin(t * 8 + sl.phase) * 0.12 - this._sinkT * 0.35,
        sl.z + sl.scZ * out,
      );
      _e.set(sl.scX * 0.7, sl.ry, sl.scZ * 0.7, 'YXZ');
      _q.setFromEuler(_e);
      _scl.set(shrink, shrink, shrink);
      _m.compose(_p, _q, _scl);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._geo?.dispose?.();
    this._mat?.dispose?.();
    this.mesh = null;
    this.object3D = null;
  }
}
