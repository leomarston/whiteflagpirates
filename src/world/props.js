// Ambient set dressing that makes the open sea feel lived-in: instanced drifting
// barrels / crates / debris bobbing on the swell, striped harbour buoys marking
// each port's approach, a distant wheeling gull flock over The Old Teeth, richer
// wreck hulks marking dive spots (world.diveSpots), and the Mistral Rock
// lighthouse with a sweeping night beam. Everything is instanced or merged and
// updates with zero per-frame allocation.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp01, mulberry32, randRange } from '../core/utils.js';

const TAU = Math.PI * 2;

// per-frame scratch (never allocate in update)
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _col = new THREE.Color();

function harborApproach(field, isl) {
  let best = null;
  for (let i = 0; i < 24; i++) {
    const ang = (i / 24) * TAU;
    const dx = Math.sin(ang), dz = Math.cos(ang);
    let shore = null, deep = null;
    for (let d = isl.radius * 0.2; d < isl.radius * 2.2; d += 6) {
      const h = field.heightAt(isl.center.x + dx * d, isl.center.z + dz * d);
      if (shore == null && h < 0.6) shore = d;
      if (shore != null && h < -4.5) { deep = d; break; }
    }
    if (shore == null || deep == null) continue;
    const run = deep - shore;
    if (!best || run < best.run) best = { dx, dz, deep, run };
  }
  return best;
}

export function buildProps(ctx, world) {
  const group = new THREE.Group();
  group.name = 'props';
  ctx.scene.add(group);

  const rng = mulberry32(31337);
  const scale = ctx.engine?.qualityProfile?.particleScale ?? 1;
  const field = world.field;

  // =====================================================================
  // FLOATERS — instanced barrels, crates & broken planks drifting on lanes.
  // =====================================================================
  const floaters = [];
  const spawnFloater = (x, z, kind) => {
    floaters.push({
      x, z, kind,
      phase: rng() * TAU,
      yaw: rng() * TAU,
      wob: 0.4 + rng() * 0.8,
      draft: kind === 'plank' ? 0.05 : kind === 'crate' ? 0.22 : 0.2,
    });
  };
  // scatter along shipping lanes around islands
  const laneN = Math.round(26 * scale);
  for (let i = 0; i < laneN; i++) {
    const isl = world.islands[Math.floor(rng() * world.islands.length)];
    const ang = rng() * TAU;
    const dist = isl.radius * randRange(rng, 1.7, 3.4);
    const x = isl.center.x + Math.sin(ang) * dist;
    const z = isl.center.z + Math.cos(ang) * dist;
    if (field.heightAt(x, z) > -3) continue; // keep them in real water
    const r = rng();
    spawnFloater(x, z, r < 0.45 ? 'barrel' : r < 0.75 ? 'crate' : 'plank');
  }

  const barrelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.9, 10);
  const crateGeo = new THREE.BoxGeometry(0.8, 0.7, 0.8);
  // a "broken plank / debris" clump: two crossed boards
  const plankGeo = mergeGeometries([
    new THREE.BoxGeometry(1.6, 0.09, 0.28),
    (() => { const g = new THREE.BoxGeometry(1.2, 0.09, 0.24); g.rotateY(0.7); g.translate(0.1, 0.02, 0.05); return g; })(),
  ]);
  const floatMats = {
    barrel: new THREE.MeshStandardMaterial({ color: 0x5c4028, roughness: 0.9 }),
    crate: new THREE.MeshStandardMaterial({ color: 0x6e5636, roughness: 0.92 }),
    plank: new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 1 }),
  };
  const floatInst = {};
  for (const kind of ['barrel', 'crate', 'plank']) {
    const n = floaters.filter((f) => f.kind === kind).length;
    if (!n) continue;
    const geo = kind === 'barrel' ? barrelGeo : kind === 'crate' ? crateGeo : plankGeo;
    const im = new THREE.InstancedMesh(geo, floatMats[kind], n);
    im.castShadow = false; im.receiveShadow = false;
    im.frustumCulled = false;
    im.name = `floaters:${kind}`;
    group.add(im);
    floatInst[kind] = { mesh: im, items: floaters.filter((f) => f.kind === kind) };
  }

  // =====================================================================
  // BUOYS — striped channel markers flanking each port's approach.
  // =====================================================================
  const buoyItems = [];
  for (const isl of world.islands) {
    if (!isl.def.port) continue;
    // Prefer the port's real dock bearing (built just before props) so the
    // channel markers flank the actual pier; fall back to a local scan only
    // if the port is missing for some reason.
    let dx, dz, px, pz;
    if (isl.port) {
      const heading = isl.port.dockHeading ?? 0;
      dx = Math.sin(heading); dz = Math.cos(heading);
      px = isl.port.dockPosition.x + dx * 12;
      pz = isl.port.dockPosition.z + dz * 12;
    } else {
      const ap = harborApproach(field, isl);
      if (!ap) continue;
      dx = ap.dx; dz = ap.dz;
      px = isl.center.x + ap.dx * (ap.deep + 20);
      pz = isl.center.z + ap.dz * (ap.deep + 20);
    }
    const perpX = dz, perpZ = -dx; // unit perpendicular
    buoyItems.push({ x: px + perpX * 8, z: pz + perpZ * 8, phase: rng() * TAU, port: true }); // starboard (green)
    buoyItems.push({ x: px - perpX * 8, z: pz - perpZ * 8, phase: rng() * TAU, port: false }); // port (red)
  }
  let buoyInst = null, buoyLampInst = null;
  const buoyLampMat = new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffd27a, emissiveIntensity: 0.2 });
  if (buoyItems.length) {
    // float body: squashed sphere + short mast + a small cage cone, merged
    const bodyGeo = mergeGeometries([
      (() => { const g = new THREE.SphereGeometry(0.55, 10, 8); g.scale(1, 0.8, 1); g.translate(0, 0.1, 0); return g; })(),
      (() => { const g = new THREE.CylinderGeometry(0.09, 0.11, 1.4, 6); g.translate(0, 1.0, 0); return g; })(),
      (() => { const g = new THREE.ConeGeometry(0.24, 0.5, 6); g.translate(0, 1.75, 0); return g; })(),
    ]);
    buoyInst = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), buoyItems.length);
    buoyInst.frustumCulled = false;
    buoyInst.name = 'buoys';
    group.add(buoyInst);
    const lampGeo = new THREE.SphereGeometry(0.16, 8, 6);
    buoyLampInst = new THREE.InstancedMesh(lampGeo, buoyLampMat, buoyItems.length);
    buoyLampInst.frustumCulled = false;
    group.add(buoyLampInst);
    for (let i = 0; i < buoyItems.length; i++) {
      _col.setHex(buoyItems[i].port ? 0x2f8f4a : 0xb5352a);
      buoyInst.setColorAt(i, _col);
    }
    if (buoyInst.instanceColor) buoyInst.instanceColor.needsUpdate = true;
  }

  // =====================================================================
  // WRECK HULKS on Coralline Reach → dive spots (kept in world.diveSpots).
  // =====================================================================
  const coralline = world.islands.find((i) => i.def.id === 'coralline');
  world.diveSpots = [];
  const glints = [];
  const glintMat = new THREE.MeshBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.8, depthWrite: false });
  if (coralline) {
    const wreckMat = new THREE.MeshStandardMaterial({ color: 0x3a2c1e, roughness: 1 });
    const hulkGeos = [];
    for (let i = 0; i < 3; i++) {
      const ang = randRange(rng, 0, TAU);
      const dd = coralline.radius * randRange(rng, 0.85, 1.25);
      const x = coralline.center.x + Math.sin(ang) * dd;
      const z = coralline.center.z + Math.cos(ang) * dd;
      const seabedY = field.heightAt(x, z);
      if (seabedY > -2) continue;
      const y0 = Math.max(seabedY + 1.4, seabedY * 0.5);
      const yaw = rng() * TAU;
      const roll = randRange(rng, -0.45, 0.45);
      const buildLocal = (g) => { g.rotateX(roll); g.rotateY(yaw); g.translate(x, y0, z); hulkGeos.push(g); };
      // broken hull (half tube)
      const hull = new THREE.CylinderGeometry(2.3, 3.3, 15, 9, 1, false, 0, Math.PI);
      hull.rotateZ(Math.PI / 2);
      buildLocal(hull);
      // exposed ribs at the snapped end
      for (let r = -3; r <= 3; r++) {
        const rib = new THREE.CylinderGeometry(0.13, 0.13, 2.6, 5);
        rib.rotateZ(r * 0.16);
        rib.translate(6.4, 1.2, r * 0.75);
        buildLocal(rib);
      }
      // snapped, leaning mast
      const mast = new THREE.CylinderGeometry(0.18, 0.26, 11, 6);
      mast.rotateZ(1.15); mast.translate(1.5, 3.4, 0.4);
      buildLocal(mast);
      // spilled cargo resting on the actual seabed nearby (world space)
      for (let c = 0; c < 4; c++) {
        const cxg = x + randRange(rng, -6, 6);
        const czg = z + randRange(rng, -5, 5);
        const cby = field.heightAt(cxg, czg);
        const cg = rng() < 0.5
          ? new THREE.CylinderGeometry(0.4, 0.4, 0.85, 8)
          : new THREE.BoxGeometry(0.8, 0.8, 0.8);
        cg.rotateY(rng() * TAU);
        cg.translate(cxg, cby + 0.45, czg);
        hulkGeos.push(cg);
      }

      // shimmering glint marker so divers can find it
      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), glintMat);
      glint.position.set(x, seabedY + 2.4, z);
      glint.renderOrder = 2;
      group.add(glint);
      glints.push(glint);
      world.diveSpots.push({ position: new THREE.Vector3(x, seabedY + 1, z), looted: false, glint });
    }
    if (hulkGeos.length) {
      const hulkMesh = new THREE.Mesh(mergeGeometries(hulkGeos.map((g) => (g.index ? g.toNonIndexed() : g))), wreckMat);
      hulkMesh.castShadow = false; hulkMesh.receiveShadow = true;
      group.add(hulkMesh);
    }
  }

  // =====================================================================
  // SEABIRDS — a distant gull flock wheeling over The Old Teeth colony.
  // =====================================================================
  const oldteeth = world.islands.find((i) => i.def.id === 'oldteeth') ?? world.islands[0];
  let birdInst = null;
  const birds = [];
  if (oldteeth) {
    const birdN = Math.round(14 * scale);
    // a small gull silhouette: two swept wings (M shape)
    const wingL = new THREE.BufferGeometry();
    wingL.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0, 0.22, -1.0, 0.14, -0.12, 0, 0, -0.26,
    ]), 3));
    wingL.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2));
    wingL.computeVertexNormals();
    const wingR = new THREE.BufferGeometry();
    wingR.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0, 0.22, 0, 0, -0.26, 1.0, 0.14, -0.12,
    ]), 3));
    wingR.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2));
    wingR.computeVertexNormals();
    const birdGeo = mergeGeometries([wingL, wingR]);
    const birdMat = new THREE.MeshStandardMaterial({ color: 0x525056, roughness: 0.9, side: THREE.DoubleSide });
    birdInst = new THREE.InstancedMesh(birdGeo, birdMat, birdN);
    birdInst.frustumCulled = false;
    birdInst.name = 'seabirds';
    group.add(birdInst);
    for (let i = 0; i < birdN; i++) {
      birds.push({
        r: randRange(rng, 0.7, 1.5) * oldteeth.radius,
        alt: randRange(rng, 42, 78),
        a0: rng() * TAU,
        spd: randRange(rng, 0.05, 0.1) * (rng() < 0.5 ? 1 : -1),
        flap: rng() * TAU,
        flapSpd: randRange(rng, 5, 8),
        bob: randRange(rng, 3, 7),
      });
    }
  }
  const birdCX = oldteeth ? oldteeth.center.x : 0;
  const birdCZ = oldteeth ? oldteeth.center.z : 0;

  // =====================================================================
  // MISTRAL ROCK LIGHTHOUSE — merged tower, emissive lamp, sweeping beam.
  // =====================================================================
  const mistral = world.islands.find((i) => i.def.id === 'mistralrock');
  let beaconLamp = null, beamPivot = null, beamMat = null, beaconLight = null;
  if (mistral) {
    let bx = mistral.center.x, bz = mistral.center.z, bh = -1;
    for (let i = 0; i < 40; i++) {
      const x = mistral.center.x + randRange(rng, -0.4, 0.4) * mistral.radius;
      const z = mistral.center.z + randRange(rng, -0.4, 0.4) * mistral.radius;
      const h = field.heightAt(x, z);
      if (h > bh) { bh = h; bx = x; bz = z; }
    }
    const baseY = bh - 0.5;
    const towerGeos = [
      (() => { const g = new THREE.CylinderGeometry(2.1, 3.4, 22, 12); g.translate(0, 11, 0); return g; })(),
      (() => { const g = new THREE.CylinderGeometry(2.6, 2.6, 0.5, 12); g.translate(0, 22.2, 0); return g; })(), // gallery
    ];
    const towerMat = new THREE.MeshStandardMaterial({ color: 0xd9d2c4, roughness: 0.8 });
    const tower = new THREE.Mesh(mergeGeometries(towerGeos), towerMat);
    tower.position.set(bx, baseY, bz);
    tower.castShadow = true; tower.receiveShadow = true;
    group.add(tower);
    // painted red bands + cap in a second material
    const trimGeos = [
      (() => { const g = new THREE.CylinderGeometry(2.85, 3.0, 2.0, 12); g.translate(0, 7, 0); return g; })(),
      (() => { const g = new THREE.CylinderGeometry(2.25, 2.45, 2.0, 12); g.translate(0, 15, 0); return g; })(),
      (() => { const g = new THREE.ConeGeometry(1.9, 3, 12); g.translate(0, 26.4, 0); return g; })(),
    ];
    const trim = new THREE.Mesh(mergeGeometries(trimGeos), new THREE.MeshStandardMaterial({ color: 0x7e2a1e, roughness: 0.6 }));
    trim.position.set(bx, baseY, bz);
    group.add(trim);
    // lantern room glass (emissive)
    beaconLamp = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.5, 2.6, 12),
      new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffdf90, emissiveIntensity: 0.2 }),
    );
    beaconLamp.position.set(bx, baseY + 23.6, bz);
    group.add(beaconLamp);
    // sweeping beam: a long additive cone on a rotating pivot at the lamp
    beamPivot = new THREE.Group();
    beamPivot.position.set(bx, baseY + 23.6, bz);
    beamMat = new THREE.MeshBasicMaterial({
      color: 0xffe6a8, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const beamGeo = new THREE.ConeGeometry(4.2, 120, 12, 1, true);
    beamGeo.rotateZ(Math.PI / 2);      // point down +X
    beamGeo.translate(60, 0, 0);        // apex at the lamp
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.renderOrder = 3;
    beamPivot.add(beam);
    group.add(beamPivot);
    // one real light at the lamp (Mistral has no port; this is the only prop light)
    beaconLight = new THREE.PointLight(0xffe0a0, 0, 120, 1.4);
    beaconLight.position.set(bx, baseY + 23.6, bz);
    group.add(beaconLight);
  }

  const nightOf = () => {
    const sunY = ctx.sky?.sunDir?.y ?? Math.sin((ctx.time.dayFrac - 0.25) * TAU);
    return 1 - clamp01((sunY + 0.12) / 0.22);
  };

  // Wreck salvage is session state (not persisted), so re-arm every dive spot
  // whenever a game begins — otherwise a New Voyage inherits the last run's
  // looted flags and the wrecks stay empty with their glints hidden.
  ctx.events?.on('game:start', () => {
    for (const spot of world.diveSpots) {
      spot.looted = false;
      if (spot.glint) spot.glint.visible = true;
    }
  });

  return {
    group,
    update(dt) {
      const t = ctx.time.t;
      const ocean = ctx.ocean;
      const night = nightOf();

      // --- floaters bob & tumble on the swell ---
      for (const kind of Object.keys(floatInst)) {
        const { mesh, items } = floatInst[kind];
        for (let i = 0; i < items.length; i++) {
          const f = items[i];
          const h = ocean ? ocean.getHeight(f.x, f.z) : 0;
          _p.set(f.x, h - f.draft + Math.sin(t * 0.8 + f.phase) * 0.06, f.z);
          const roll = kind === 'barrel' ? Math.PI / 2 : 0;
          _e.set(
            Math.sin(t * f.wob + f.phase) * 0.14,
            f.yaw + Math.sin(t * 0.2 + f.phase) * 0.15,
            roll + Math.cos(t * f.wob * 0.9 + f.phase) * 0.14,
          );
          _q.setFromEuler(_e);
          _m.compose(_p, _q, _s);
          mesh.setMatrixAt(i, _m);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }

      // --- buoys ride the chop, lamps kindle at night ---
      if (buoyInst) {
        for (let i = 0; i < buoyItems.length; i++) {
          const b = buoyItems[i];
          const h = ocean ? ocean.getHeight(b.x, b.z) : 0;
          _p.set(b.x, h - 0.15 + Math.sin(t * 0.9 + b.phase) * 0.08, b.z);
          _e.set(Math.sin(t * 1.1 + b.phase) * 0.16, 0, Math.cos(t * 0.95 + b.phase) * 0.16);
          _q.setFromEuler(_e);
          _m.compose(_p, _q, _s);
          buoyInst.setMatrixAt(i, _m);
          _p.y += 1.9; // lamp sits atop the mast
          _m.compose(_p, _q, _s);
          buoyLampInst.setMatrixAt(i, _m);
        }
        buoyInst.instanceMatrix.needsUpdate = true;
        buoyLampInst.instanceMatrix.needsUpdate = true;
        buoyLampMat.emissiveIntensity = 0.15 + night * (1.8 + Math.sin(t * 3.0) * 0.5);
      }

      // --- gull flock wheels over the colony ---
      if (birdInst) {
        for (let i = 0; i < birds.length; i++) {
          const b = birds[i];
          const a = b.a0 + t * b.spd;
          _p.set(birdCX + Math.cos(a) * b.r, b.alt + Math.sin(t * 0.4 + b.a0) * b.bob, birdCZ + Math.sin(a) * b.r);
          const flap = 1 + Math.sin(t * b.flapSpd + b.flap) * 0.35;
          _s.set(1.6, 1.6 * flap, 1.6);
          _e.set(0, -a + (b.spd > 0 ? Math.PI : 0), Math.sin(t * b.flapSpd + b.flap) * 0.2);
          _q.setFromEuler(_e);
          _m.compose(_p, _q, _s);
          birdInst.setMatrixAt(i, _m);
        }
        _s.set(1, 1, 1);
        birdInst.instanceMatrix.needsUpdate = true;
      }

      // --- dive glints shimmer & hide once salvaged ---
      for (const spot of world.diveSpots) {
        const g = spot.glint;
        if (!g) continue;
        g.visible = !spot.looted;
        if (spot.looted) continue;
        const s = 1 + Math.sin(t * 2.4 + spot.position.x) * 0.35;
        g.scale.set(s, s, s);
        g.material.opacity = 0.45 + Math.sin(t * 2.4 + spot.position.z) * 0.35;
        g.position.y = (spot.position.y - 1) + 2.4 + Math.sin(t * 1.3 + spot.position.x) * 0.25;
      }

      // --- Mistral light pulses & the beam sweeps through the dark ---
      if (beaconLamp) {
        beaconLamp.material.emissiveIntensity = 0.2 + night * (2.4 + Math.sin(t * 1.8) * 1.4);
        if (beamPivot) beamPivot.rotation.y += dt * 0.5;
        if (beamMat) beamMat.opacity = night * 0.16 * (0.7 + Math.sin(t * 1.8) * 0.3);
        if (beaconLight) beaconLight.intensity = night * (18 + Math.sin(t * 1.8) * 6);
      }
    },
  };
}
