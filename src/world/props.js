// Ambient set dressing: buoys, drifting barrels, wreck hulks & dive spots.
import * as THREE from 'three';
import { mulberry32, randRange } from '../core/utils.js';

export function buildProps(ctx, world) {
  const group = new THREE.Group();
  group.name = 'props';
  ctx.scene.add(group);

  const rng = mulberry32(31337);
  const floaters = []; // bob on the waves

  const barrelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.9, 10);
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x5c4028, roughness: 0.9 });
  const buoyMat = new THREE.MeshStandardMaterial({ color: 0x9e3324, roughness: 0.7 });

  // drifting barrels scattered on shipping lanes
  for (let i = 0; i < 14; i++) {
    const isl = world.islands[Math.floor(rng() * world.islands.length)];
    const ang = rng() * Math.PI * 2;
    const dist = isl.radius * randRange(rng, 1.8, 3.2);
    const barrel = new THREE.Mesh(barrelGeo, barrelMat);
    barrel.position.set(
      isl.center.x + Math.sin(ang) * dist, 0,
      isl.center.z + Math.cos(ang) * dist,
    );
    barrel.rotation.set(rng() * 0.6, rng() * 6.28, Math.PI / 2 - 0.2 + rng() * 0.4);
    group.add(barrel);
    floaters.push({ mesh: barrel, phase: rng() * 6.28, draft: 0.18 });
  }

  // wreck hulks on Coralline Reach → dive spots
  const coralline = world.islands.find((i) => i.def.id === 'coralline');
  world.diveSpots = [];
  if (coralline) {
    const wreckMat = new THREE.MeshStandardMaterial({ color: 0x3e2f20, roughness: 1 });
    for (let i = 0; i < 3; i++) {
      const ang = randRange(rng, 0, Math.PI * 2);
      const d = coralline.radius * randRange(rng, 0.85, 1.25);
      const x = coralline.center.x + Math.sin(ang) * d;
      const z = coralline.center.z + Math.cos(ang) * d;
      const seabedY = world.field.heightAt(x, z);
      if (seabedY > -2) continue;

      const hulk = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.4, 16, 8, 1, false, 0, Math.PI), wreckMat);
      hull.rotation.z = Math.PI / 2;
      hull.rotation.x = randRange(rng, -0.4, 0.4);
      hulk.add(hull);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.26, 12, 6), wreckMat);
      mast.position.set(2, 4, 0);
      mast.rotation.z = 1.2;
      hulk.add(mast);
      hulk.position.set(x, Math.max(seabedY + 1.4, seabedY * 0.5), z);
      hulk.rotation.y = rng() * 6.28;
      group.add(hulk);

      // glint marker so divers can find it
      const glint = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.85 }),
      );
      glint.position.set(x, seabedY + 2.2, z);
      group.add(glint);
      world.diveSpots.push({ position: new THREE.Vector3(x, seabedY + 1, z), looted: false, glint });
    }
  }

  // beacon on Mistral Rock — a lonely lighthouse
  const mistral = world.islands.find((i) => i.def.id === 'mistralrock');
  let beaconLamp = null;
  if (mistral) {
    // put the tower near the summit
    let bx = mistral.center.x, bz = mistral.center.z, bh = -1;
    for (let i = 0; i < 40; i++) {
      const x = mistral.center.x + randRange(rng, -0.4, 0.4) * mistral.radius;
      const z = mistral.center.z + randRange(rng, -0.4, 0.4) * mistral.radius;
      const h = world.field.heightAt(x, z);
      if (h > bh) { bh = h; bx = x; bz = z; }
    }
    const tower = new THREE.Group();
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(2.2, 3.4, 22, 10),
      new THREE.MeshStandardMaterial({ color: 0xd9d2c4, roughness: 0.8 }),
    );
    shaft.position.y = 11;
    shaft.castShadow = true;
    tower.add(shaft);
    const cap = new THREE.Mesh(
      new THREE.ConeGeometry(2.6, 3, 10),
      new THREE.MeshStandardMaterial({ color: 0x7e2a1e, roughness: 0.6 }),
    );
    cap.position.y = 24.6;
    tower.add(cap);
    beaconLamp = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 10, 10),
      new THREE.MeshStandardMaterial({
        color: 0xfff2c0, emissive: 0xffdf90, emissiveIntensity: 0.2,
      }),
    );
    beaconLamp.position.y = 22.4;
    tower.add(beaconLamp);
    tower.position.set(bx, bh - 0.5, bz);
    group.add(tower);
  }

  return {
    group,
    update(dt) {
      const t = ctx.time.t;
      const ocean = ctx.ocean;
      for (const f of floaters) {
        const m = f.mesh;
        const h = ocean ? ocean.getHeight(m.position.x, m.position.z) : 0;
        m.position.y = h - f.draft + Math.sin(t * 0.8 + f.phase) * 0.05;
        m.rotation.x += Math.sin(t * 0.5 + f.phase) * 0.0006;
      }
      // dive glints shimmer
      for (const spot of world.diveSpots) {
        if (spot.glint) {
          spot.glint.visible = !spot.looted;
          spot.glint.material.opacity = 0.5 + Math.sin(t * 2.4) * 0.35;
        }
      }
      // lighthouse pulses at night
      if (beaconLamp) {
        const night = 1 - Math.min(1, Math.max(0, ((ctx.sky?.sunDir.y ?? 1) + 0.12) / 0.22));
        beaconLamp.material.emissiveIntensity = 0.2 + night * (2.2 + Math.sin(t * 1.8) * 1.6);
      }
    },
  };
}
