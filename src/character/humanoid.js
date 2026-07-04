// Shared articulated humanoid rig + pure pose helpers (player & NPCs).
// The rig is deliberately low-poly with a readable pirate silhouette: a
// V-tapered coat, rolled sleeves, boots, tricorne. All motion is math on the
// bones each frame (no allocation) so it scales to a portful of NPCs.
import * as THREE from 'three';

const DEFAULT_PALETTE = {
  skin: 0xc9976b, coat: 0x3d4a5c, trousers: 0x2c2820, hat: 0x241c12, accent: 0xc9a24b,
};

/**
 * Builds a ~1.75m humanoid. Returns { group, bones, mats }.
 * bones: root, torso, head, armL, armR, foreL, foreR, handL, handR,
 *        legL, legR, shinL, shinR
 * The pelvis (`root`) rests at y=0.94 with the feet grounded near y=0; every
 * pose helper writes rotations *additively* — compose them each frame after
 * resetPose(). Bone names & the anim* exports are a contract (npc.js imports
 * them) — do not rename or remove.
 */
export function buildHumanoid(opts = {}) {
  const pal = { ...DEFAULT_PALETTE, ...(opts.palette ?? {}) };
  const build = opts.build ?? 1;
  const mats = {
    skin: new THREE.MeshStandardMaterial({ color: pal.skin, roughness: 0.72 }),
    coat: new THREE.MeshStandardMaterial({ color: pal.coat, roughness: 0.82 }),
    trousers: new THREE.MeshStandardMaterial({ color: pal.trousers, roughness: 0.9 }),
    hat: new THREE.MeshStandardMaterial({ color: pal.hat, roughness: 0.8 }),
    accent: new THREE.MeshStandardMaterial({ color: pal.accent, roughness: 0.5, metalness: 0.35 }),
    boot: new THREE.MeshStandardMaterial({ color: 0x241b12, roughness: 0.7 }),
  };

  const group = new THREE.Group();
  group.scale.setScalar(build);

  const root = new THREE.Group();  // pelvis pivot
  root.position.y = 0.94;
  group.add(root);

  // --- torso: narrow waist → broad chest for a coat-y V taper ----------------
  const torso = new THREE.Group();
  torso.position.y = 0.12;
  root.add(torso);
  const abdomen = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.26, 0.22), mats.coat);
  abdomen.position.y = 0.13;
  torso.add(abdomen);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.32, 0.25), mats.coat);
  chest.position.y = 0.42;
  chest.castShadow = true;
  torso.add(chest);
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.09, 0.235), mats.accent);
  belt.position.y = 0.0;
  torso.add(belt);
  if (opts.coat !== false) {
    const tails = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.34, 0.17), mats.coat);
    tails.position.set(0, -0.16, -0.035);
    torso.add(tails);
  }

  // neck
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.075, 0.12, 6), mats.skin);
  neck.position.y = 0.62;
  torso.add(neck);

  // --- head ------------------------------------------------------------------
  const head = new THREE.Group();
  head.position.y = 0.66;
  torso.add(head);
  const skull = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.24, 0.22), mats.skin);
  skull.position.y = 0.12;
  skull.castShadow = true;
  head.add(skull);
  const hat = opts.hat ?? 'tricorne';
  if (hat === 'tricorne') {
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.045, 3), mats.hat);
    brim.position.y = 0.255;
    brim.rotation.y = Math.PI / 6;
    head.add(brim);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.145, 0.14, 8), mats.hat);
    crown.position.y = 0.31;
    head.add(crown);
  } else if (hat === 'bandana') {
    const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.14, 0.1, 8), mats.accent);
    wrap.position.y = 0.235;
    head.add(wrap);
    const knot = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.12), mats.accent);
    knot.position.set(-0.11, 0.22, -0.05);
    head.add(knot);
  } else if (hat === 'hood') {
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.28, 8), mats.coat);
    hood.position.y = 0.28;
    head.add(hood);
  } else {
    // bare head — give it hair so it doesn't read bald
    const hair = new THREE.Mesh(new THREE.BoxGeometry(0.215, 0.1, 0.235), mats.hat);
    hair.position.y = 0.21;
    head.add(hair);
  }

  // --- arms: shoulder → elbow → hand ----------------------------------------
  function arm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.25 * side, 0.51, 0);
    torso.add(shoulder);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.13, 0.15), mats.coat);
    cap.position.y = -0.02;
    shoulder.add(cap);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.3, 0.115), mats.coat);
    upper.position.y = -0.18;
    upper.castShadow = true;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.32;
    shoulder.add(elbow);
    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.088, 0.28, 0.092), mats.skin);
    fore.position.y = -0.15;
    elbow.add(fore);
    const hand = new THREE.Group();
    hand.position.y = -0.32;
    elbow.add(hand);
    const fist = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.1, 0.1), mats.skin);
    fist.position.y = -0.04;
    hand.add(fist);
    return { shoulder, elbow, hand };
  }
  const armRparts = arm(1);
  const armLparts = arm(-1);

  // --- legs: hip → knee ------------------------------------------------------
  function leg(side) {
    const hip = new THREE.Group();
    hip.position.set(0.11 * side, 0, 0);
    root.add(hip);
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.15), mats.trousers);
    thigh.position.y = -0.21;
    thigh.castShadow = true;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.44;
    hip.add(knee);
    const shin = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.42, 0.13), mats.trousers);
    shin.position.y = -0.21;
    knee.add(shin);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.12, 0.27), mats.boot);
    boot.position.set(0, -0.45, 0.05);
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

const POSE_BONES = [
  'torso', 'head', 'armL', 'armR', 'foreL', 'foreR',
  'handL', 'handR', 'legL', 'legR', 'shinL', 'shinR',
];

/** Zero out pose rotations before composing helpers. */
export function resetPose(b) {
  for (let i = 0; i < POSE_BONES.length; i++) b[POSE_BONES[i]].rotation.set(0, 0, 0);
  b.root.rotation.set(0, 0, 0);
  b.root.position.set(0, 0.94, 0);
}

export function animIdle(b, t) {
  const breath = Math.sin(t * 1.5);
  const sway = Math.sin(t * 0.8);
  b.torso.rotation.x += 0.02 + breath * 0.02;   // relaxed forward + chest rise
  b.torso.rotation.z += sway * 0.02;            // weight rocks side to side
  b.root.rotation.z += sway * 0.014;            // pelvis follows a touch
  b.head.rotation.z += -sway * 0.03;
  b.head.rotation.y += Math.sin(t * 0.53) * 0.06;
  b.head.rotation.x += breath * 0.015;
  b.armL.rotation.z += 0.09 + breath * 0.015;   // arms hang, ease off the body
  b.armR.rotation.z += -0.09 - breath * 0.015;
  b.armL.rotation.x += sway * 0.03;
  b.armR.rotation.x += -sway * 0.03;
  b.foreL.rotation.x += -0.2;
  b.foreR.rotation.x += -0.2;
}

export function animWalk(b, phase, speed01) {
  const amp = 0.5 * speed01 + 0.18;
  const s = Math.sin(phase);
  const c = -s;                       // opposite leg (sin(phase+π))
  // legs swing; shins flex on the back/lift half of the stride
  b.legL.rotation.x += s * amp;
  b.legR.rotation.x += c * amp;
  b.shinL.rotation.x += Math.max(0, -s) * amp * 1.5 + 0.09;
  b.shinR.rotation.x += Math.max(0, -c) * amp * 1.5 + 0.09;
  // arms counter-swing to the legs, elbows trail
  b.armL.rotation.x += c * amp * 0.85;
  b.armR.rotation.x += s * amp * 0.85;
  b.foreL.rotation.x += -0.24 - Math.max(0, c) * 0.35 * speed01;
  b.foreR.rotation.x += -0.24 - Math.max(0, s) * 0.35 * speed01;
  // torso: lean into the pace, twist with the arms, roll for weight
  b.torso.rotation.x += 0.05 + 0.13 * speed01;
  b.torso.rotation.y += s * 0.08 * speed01;
  b.torso.rotation.z += s * 0.05 * speed01;
  // pelvis lists toward the stance leg and yaws with the stride
  b.root.rotation.z += -s * 0.055 * speed01;
  b.root.rotation.y += s * 0.04 * speed01;
  b.head.rotation.z += s * 0.02 * speed01;
  // vertical bob — rise as the legs pass, never sink below the stance
  b.root.position.y += Math.abs(Math.cos(phase)) * 0.05 * speed01;
}

export function animSwim(b, t) {
  const stroke = t * 3.2;
  const aL = Math.sin(stroke);
  const aR = Math.sin(stroke + Math.PI);
  const roll = aL * 0.35;
  b.torso.rotation.x += 1.22;                 // pitch into the water
  b.torso.rotation.z += roll * 0.5;           // body roll with the pull
  b.head.rotation.x += -0.85;
  b.head.rotation.y += -roll * 0.4;
  // alternating overhead crawl
  b.armL.rotation.x += -2.5 + aL * 1.4;
  b.armR.rotation.x += -2.5 + aR * 1.4;
  b.armL.rotation.z += 0.3 + Math.max(0, aL) * 0.4;
  b.armR.rotation.z += -0.3 - Math.max(0, aR) * 0.4;
  b.foreL.rotation.x += -0.5;
  b.foreR.rotation.x += -0.5;
  // flutter kick
  const kick = Math.sin(t * 8);
  b.legL.rotation.x += 0.9 + kick * 0.5;
  b.legR.rotation.x += 0.9 - kick * 0.5;
  b.shinL.rotation.x += 0.2 + Math.max(0, kick) * 0.35;
  b.shinR.rotation.x += 0.2 + Math.max(0, -kick) * 0.35;
}

/** k: 0 windup → ~0.5 strike → 1 recover. `heavy` widens the arc. */
export function animAttack(b, k, heavy = false) {
  const power = heavy ? 1.4 : 1;
  const wind = Math.min(k / 0.32, 1);
  const strike = Math.max(0, Math.min((k - 0.32) / 0.26, 1));
  const recover = Math.max(0, Math.min((k - 0.6) / 0.4, 1));
  const ease = (x) => x * x * (3 - 2 * x);
  const w = ease(wind), st = ease(strike);
  // right arm cocks back overhead then whips across and down
  b.armR.rotation.x += (-2.3 * w + 3.4 * st) * power - recover * 0.9;
  b.armR.rotation.z += -0.7 * w + 0.7 * st;
  b.armR.rotation.y += 0.25 * w - 0.35 * st;
  b.foreR.rotation.x += -0.9 * w + 0.4 * st;
  // hips and torso drive the cut for weight
  b.torso.rotation.y += (-0.6 * w + 1.05 * st) * power;
  b.torso.rotation.x += 0.1 * w + 0.28 * st * power;
  b.root.rotation.y += (-0.2 * w + 0.32 * st) * power;
  // off arm balances, legs brace the swing
  b.armL.rotation.x += -0.3 * w - 0.2 * st;
  b.armL.rotation.z += 0.3 * w + 0.2 * st;
  b.legL.rotation.x += 0.16 * st;
  b.legR.rotation.x += -0.1 * st;
}

export function animBlock(b, k) {
  b.armR.rotation.x += -1.7 * k;
  b.armR.rotation.z += 0.7 * k;
  b.foreR.rotation.x += -1.5 * k;
  b.armL.rotation.x += -0.6 * k;
  b.armL.rotation.z += 0.5 * k;
  b.torso.rotation.y += -0.3 * k;
  b.torso.rotation.x += 0.08 * k;
  b.root.rotation.z += 0.03 * k;
}

export function animHit(b, k) {
  const kick = Math.sin(Math.min(k, 1) * Math.PI);
  b.torso.rotation.x += -0.45 * kick;
  b.torso.rotation.z += 0.18 * kick;
  b.head.rotation.x += -0.32 * kick;
  b.armL.rotation.z += 0.4 * kick;
  b.armR.rotation.z += -0.28 * kick;
}

/** Landing / crouch squash. k: 0 impact → 1 recovered. */
export function animLand(b, k) {
  const kk = Math.min(Math.max(k, 0), 1);
  const squash = Math.sin(kk * Math.PI) * (1 - kk * 0.3);
  b.root.position.y -= squash * 0.26;
  b.legL.rotation.x += squash * 0.7;
  b.legR.rotation.x += squash * 0.7;
  b.shinL.rotation.x += squash * 1.1;
  b.shinR.rotation.x += squash * 1.1;
  b.torso.rotation.x += squash * 0.34;
  b.armL.rotation.x += -squash * 0.5;
  b.armR.rotation.x += -squash * 0.5;
}

export function animDeath(b, k) {
  const fall = Math.min(k, 1);
  const e = fall * fall * (3 - 2 * fall);
  b.root.rotation.x = -e * (Math.PI / 2) * 0.9;
  b.root.rotation.z = e * 0.24;
  b.root.position.y = 0.94 - e * 0.66;
  b.torso.rotation.x += -e * 0.3;
  b.head.rotation.x += e * 0.5;
  b.armL.rotation.z += fall * 0.8;
  b.armR.rotation.z += -fall * 0.6;
  b.armR.rotation.x += -fall * 0.5;
  b.legL.rotation.x += fall * 0.3;
  b.legR.rotation.x += -fall * 0.2;
}

/** A curved cutlass for the right hand. Held at the group origin; blade points
 *  down/back at rest. `userData.tip`/`userData.base` are empties the sword
 *  module reads for the blade trail (ignored by everyone else). */
export function buildCutlass() {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xc2ccd4, roughness: 0.28, metalness: 0.9 });
  const edge = new THREE.MeshStandardMaterial({ color: 0xe8eef2, roughness: 0.16, metalness: 0.95 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a24b, roughness: 0.38, metalness: 0.75 });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.8 });

  // blade — two segments give a subtle sabre curve
  const blade1 = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.44, 0.085), steel);
  blade1.position.set(0, -0.34, 0.012);
  blade1.rotation.x = 0.06;
  group.add(blade1);
  const blade2 = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.26, 0.066), steel);
  blade2.position.set(0, -0.62, 0.05);
  blade2.rotation.x = 0.16;
  group.add(blade2);
  // bright fuller edge — a hot line for the bloom pipeline to catch
  const edgeStrip = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.64, 0.02), edge);
  edgeStrip.position.set(0, -0.44, 0.05);
  edgeStrip.rotation.x = 0.1;
  group.add(edgeStrip);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.14, 4), steel);
  tip.position.set(0, -0.79, 0.095);
  tip.rotation.set(Math.PI + 0.2, Math.PI / 4, 0);
  group.add(tip);
  // swept knuckle guard + quillon
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.016, 6, 12, Math.PI * 1.15), brass);
  guard.position.y = -0.05;
  guard.rotation.z = Math.PI / 2;
  guard.rotation.x = 0.3;
  group.add(guard);
  const quillon = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.02, 0.03), brass);
  quillon.position.y = -0.05;
  group.add(quillon);
  // wrapped grip + pommel, sitting in the fist at the origin
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.13, 8), gripMat);
  grip.position.y = -0.04;
  group.add(grip);
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), brass);
  pommel.position.y = 0.03;
  group.add(pommel);

  group.rotation.x = Math.PI; // blade points down/back from the hand at rest

  const tipMark = new THREE.Object3D();
  tipMark.position.set(0, -0.83, 0.1);
  group.add(tipMark);
  const baseMark = new THREE.Object3D();
  baseMark.position.set(0, -0.18, 0.02);
  group.add(baseMark);
  group.userData.tip = tipMark;
  group.userData.base = baseMark;

  return group;
}
