// Shared articulated humanoid rig + pure pose helpers (player & NPCs).
import * as THREE from 'three';

const DEFAULT_PALETTE = {
  skin: 0xc9976b, coat: 0x3d4a5c, trousers: 0x2c2820, hat: 0x241c12, accent: 0xc9a24b,
};

/**
 * Builds a ~1.75m humanoid. Returns { group, bones }.
 * bones: root, torso, head, armL, armR, foreL, foreR, legL, legR, shinL, shinR, handR
 * All pose helpers write rotations only — compose them every frame.
 */
export function buildHumanoid(opts = {}) {
  const pal = { ...DEFAULT_PALETTE, ...(opts.palette ?? {}) };
  const build = opts.build ?? 1;
  const mats = {
    skin: new THREE.MeshStandardMaterial({ color: pal.skin, roughness: 0.8 }),
    coat: new THREE.MeshStandardMaterial({ color: pal.coat, roughness: 0.85 }),
    trousers: new THREE.MeshStandardMaterial({ color: pal.trousers, roughness: 0.9 }),
    hat: new THREE.MeshStandardMaterial({ color: pal.hat, roughness: 0.85 }),
    accent: new THREE.MeshStandardMaterial({ color: pal.accent, roughness: 0.6, metalness: 0.3 }),
  };

  const group = new THREE.Group();
  group.scale.setScalar(build);

  const root = new THREE.Group();  // pelvis pivot
  root.position.y = 0.94;
  group.add(root);

  // torso
  const torso = new THREE.Group();
  torso.position.y = 0.12;
  root.add(torso);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.52, 0.24), mats.coat);
  chest.position.y = 0.32;
  chest.castShadow = true;
  torso.add(chest);
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.09, 0.24), mats.accent);
  belt.position.y = 0.03;
  torso.add(belt);
  if (opts.coat !== false) {
    const tails = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.2), mats.coat);
    tails.position.set(0, -0.14, -0.03);
    torso.add(tails);
  }

  // head
  const head = new THREE.Group();
  head.position.y = 0.66;
  torso.add(head);
  const skull = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 0.24), mats.skin);
  skull.position.y = 0.13;
  skull.castShadow = true;
  head.add(skull);
  const hat = opts.hat ?? 'tricorne';
  if (hat === 'tricorne') {
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.23, 0.05, 3), mats.hat);
    brim.position.y = 0.27;
    brim.rotation.y = Math.PI / 6;
    head.add(brim);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.14, 8), mats.hat);
    crown.position.y = 0.32;
    head.add(crown);
  } else if (hat === 'bandana') {
    const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.14, 0.09, 8), mats.accent);
    wrap.position.y = 0.24;
    head.add(wrap);
  } else if (hat === 'hood') {
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.26, 8), mats.coat);
    hood.position.y = 0.28;
    head.add(hood);
  }

  // arms: shoulder pivots
  function arm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.26 * side, 0.52, 0);
    torso.add(shoulder);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.32, 0.11), mats.coat);
    upper.position.y = -0.16;
    upper.castShadow = true;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.32;
    shoulder.add(elbow);
    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.3, 0.09), mats.skin);
    fore.position.y = -0.15;
    elbow.add(fore);
    const hand = new THREE.Group();
    hand.position.y = -0.32;
    elbow.add(hand);
    return { shoulder, elbow, hand };
  }
  const armRparts = arm(1);
  const armLparts = arm(-1);

  // legs: hip pivots
  function leg(side) {
    const hip = new THREE.Group();
    hip.position.set(0.12 * side, 0, 0);
    root.add(hip);
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.42, 0.14), mats.trousers);
    thigh.position.y = -0.21;
    thigh.castShadow = true;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.44;
    hip.add(knee);
    const shin = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.44, 0.12), mats.trousers);
    shin.position.y = -0.22;
    knee.add(shin);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, 0.2), mats.hat);
    boot.position.set(0, -0.46, 0.04);
    knee.add(boot);
    return { hip, knee };
  }
  const legRparts = leg(1);
  const legLparts = leg(-1);

  const bones = {
    root, torso, head,
    armL: armLparts.shoulder, armR: armRparts.shoulder,
    foreL: armLparts.elbow, foreR: armRparts.elbow,
    handL: armLparts.hand, handR: armRparts.hand,
    legL: legLparts.hip, legR: legRparts.hip,
    shinL: legLparts.knee, shinR: legRparts.knee,
  };
  return { group, bones, mats };
}

/** Zero out pose rotations before composing helpers. */
export function resetPose(b) {
  for (const key of ['torso', 'head', 'armL', 'armR', 'foreL', 'foreR', 'legL', 'legR', 'shinL', 'shinR']) {
    b[key].rotation.set(0, 0, 0);
  }
  b.root.position.y = 0.94;
  b.root.rotation.x = 0;
  b.root.rotation.z = 0;
}

export function animIdle(b, t) {
  const breath = Math.sin(t * 1.7) * 0.02;
  b.torso.rotation.x += breath;
  b.armL.rotation.z += 0.06 + breath;
  b.armR.rotation.z += -0.06 - breath;
  b.foreL.rotation.x += -0.12;
  b.foreR.rotation.x += -0.12;
}

export function animWalk(b, phase, speed01) {
  const amp = 0.55 * speed01 + 0.15;
  const s = Math.sin(phase);
  const c = Math.sin(phase + Math.PI);
  b.legL.rotation.x += s * amp;
  b.legR.rotation.x += c * amp;
  b.shinL.rotation.x += Math.max(0, -s) * amp * 1.2;
  b.shinR.rotation.x += Math.max(0, -c) * amp * 1.2;
  b.armL.rotation.x += c * amp * 0.7;
  b.armR.rotation.x += s * amp * 0.7;
  b.foreL.rotation.x += -0.2 - Math.max(0, c) * 0.3 * speed01;
  b.foreR.rotation.x += -0.2 - Math.max(0, s) * 0.3 * speed01;
  b.torso.rotation.y += s * 0.06 * speed01;
  b.torso.rotation.x += 0.08 * speed01;
  b.root.position.y += Math.abs(Math.cos(phase)) * 0.05 * speed01;
}

export function animSwim(b, t) {
  b.torso.rotation.x += 1.15;
  b.head.rotation.x += -0.7;
  const s = Math.sin(t * 5);
  b.armL.rotation.x += -2.4 + s * 0.9;
  b.armR.rotation.x += -2.4 - s * 0.9;
  b.legL.rotation.x += Math.sin(t * 7) * 0.4 + 1.0;
  b.legR.rotation.x += -Math.sin(t * 7) * 0.4 + 1.0;
}

/** k: 0 windup → 0.55 strike → 1 recover. */
export function animAttack(b, k, heavy = false) {
  const wind = Math.min(k / 0.4, 1);
  const strike = Math.max(0, Math.min((k - 0.4) / 0.25, 1));
  const power = heavy ? 1.35 : 1;
  b.armR.rotation.x += (-2.1 * wind + 2.9 * strike) * power;
  b.armR.rotation.z += -0.5 * wind + 0.4 * strike;
  b.foreR.rotation.x += -0.5 * wind + 0.2 * strike;
  b.torso.rotation.y += (-0.5 * wind + 0.9 * strike) * power;
  b.torso.rotation.x += 0.25 * strike * power;
}

export function animBlock(b, k) {
  b.armR.rotation.x += -1.5 * k;
  b.armR.rotation.z += 0.9 * k;
  b.foreR.rotation.x += -1.2 * k;
  b.torso.rotation.y += -0.25 * k;
}

export function animHit(b, k) {
  const kick = Math.sin(Math.min(k, 1) * Math.PI);
  b.torso.rotation.x += -0.4 * kick;
  b.head.rotation.x += -0.3 * kick;
}

export function animDeath(b, k) {
  const fall = Math.min(k, 1);
  b.root.rotation.x = -fall * (Math.PI / 2) * 0.96;
  b.root.position.y = 0.94 - fall * 0.72;
  b.armL.rotation.z += fall * 0.7;
  b.armR.rotation.z += -fall * 0.5;
}

/** A curved cutlass for the right hand. */
export function buildCutlass() {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xb8c0c8, roughness: 0.3, metalness: 0.85 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a24b, roughness: 0.4, metalness: 0.7 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.62, 0.09), steel);
  blade.position.y = -0.42;
  blade.rotation.x = 0.12;
  group.add(blade);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 4), steel);
  tip.position.set(0, -0.76, 0.045);
  tip.rotation.x = Math.PI + 0.12;
  group.add(tip);
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.016, 6, 10, Math.PI), brass);
  guard.position.y = -0.06;
  guard.rotation.z = Math.PI / 2;
  group.add(guard);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.12, 6), brass);
  grip.position.y = -0.05;
  group.add(grip);
  group.rotation.x = Math.PI; // blade points down from the hand at rest
  return group;
}
