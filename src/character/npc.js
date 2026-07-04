// NPCs: living port folk with roles & factions, wandering civilians on real
// paths, patrolling guards that watch the player, and hostiles with telegraphed
// combat (windup → strike → block → stagger on parry → retreat).
//
// Public API (contract — do not rename/remove):
//   NPCManager(ctx): interactables (getter), hostiles[], npcs[],
//     spawnHostile(pos, kind) -> NPC, update(dt)
//   port population by proximity; listens 'guards:aggro'
//   emits 'npc:interact' {npc}, 'npc:say' {npc, text}, 'npc:killed' {npc},
//         'prompt' {id:'npc', text}, 'toast'
//   NPC entity exposes: position, alive, hostile, hostileKind, hp, role,
//     portName, name, state, applyDamage(n, fromDir), stagger()
import * as THREE from 'three';
import {
  angleDamp, clamp, clamp01, damp, randRange, randInt, wrapAngle, TAU,
} from '../core/utils.js';
import {
  animAttack, animBlock, animDeath, animHit, animIdle, animWalk,
  buildHumanoid, buildCutlass, resetPose,
} from './humanoid.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// Hard cap on simultaneously-live NPCs so a big capital never tanks the frame.
const MAX_NPCS = 30;

const ROLE_STYLE = {
  tavernkeep: { hat: 'bandana', coat: 0x6e3a2a, label: 'Tavernkeep' },
  shipwright: { hat: 'none', coat: 0x5c4028, label: 'Shipwright' },
  merchant: { hat: 'tricorne', coat: 0x7e2a1e, label: 'Merchant' },
  questgiver: { hat: 'tricorne', coat: 0x3d4a5c, label: 'Harbormaster' },
  civilian: { hat: 'bandana', coat: 0x4a5548, label: '' },
  dockworker: { hat: 'none', coat: 0x55483a, label: '' },
  guard: { hat: 'tricorne', coat: 0x1e3a6e, label: 'Crown Marine' },
};

const HOSTILE_STYLE = {
  brigand: { coat: 0x4a3a2c, hat: 'bandana', hp: 45, dmg: [8, 13], moveSpeed: 2.9, windup: 0.52, blockChance: 0.26 },
  drowned: { coat: 0x37524e, hat: 'none', hp: 60, dmg: [10, 15], skin: 0x7c9488, moveSpeed: 2.3, windup: 0.62, blockChance: 0.12 },
  marine: { coat: 0x1e3a6e, hat: 'tricorne', hp: 55, dmg: [9, 14], moveSpeed: 2.7, windup: 0.46, blockChance: 0.42 },
};

// Faction wardrobe — tints civilians/dockworkers so each port reads distinct.
const FACTION_LOOK = {
  corsairs: { coats: [0x4a5548, 0x5a4a3a, 0x6e5a44, 0x3d4436, 0x5c5148], accent: 0xcdbfa0, hats: ['bandana', 'bandana', 'tricorne', 'none'] },
  crown: { coats: [0x2a3f6e, 0x33477e, 0x263a63, 0x40474f], accent: 0xd8dde8, hats: ['tricorne', 'none', 'bandana'] },
  concern: { coats: [0x7a2a24, 0x8a3a1e, 0x612a2a, 0x6e3a24], accent: 0xc9a24b, hats: ['tricorne', 'bandana', 'none'] },
  tidebound: { coats: [0x1f5d5a, 0x2a6f66, 0x356b60, 0x4a6b58], accent: 0xd8cdb0, hats: ['hood', 'bandana', 'none'] },
};
const SKIN_TONES = [0xc9976b, 0xb07a4e, 0x8a5a38, 0xd8a578, 0x9c6a44, 0xe0b088];

const GREETINGS = [
  'Fair winds, Captain.', 'Mind the tide.', 'White flag flies here, friend.',
  'Sea keeps the rest, aye.', 'Watch your purse in this crowd.',
  'You look like weather coming.', 'Room at the Lantern tonight.',
  'Any word from the strait?', 'Shares for all, that\'s the code.',
];
const MUTTERS = [
  'Rigging won\'t mend itself…', 'Rain in it, I\'d wager.',
  'Ledger men everywhere.', 'Not enough rum in the Verge.',
  'Prices up again. Figures.', 'Gulls are restless.',
];
const BARKS = ['You\'ll swing for that!', 'No quarter!', 'On the pirate!', 'Cut \'em down!'];

// ---- local pose modifiers (additive; never touch humanoid.js) --------------
// All write rotations on top of the base idle/walk pose composed each frame.

function poseHeadLook(b, yaw, pitch) {
  b.head.rotation.y += clamp(yaw, -1.05, 1.05);
  b.head.rotation.x += clamp(pitch, -0.45, 0.4);
}

// k: 0 → 1 gesture progress. Bell envelope so it eases in and out.
function poseGesture(b, kind, k) {
  const e = Math.sin(clamp01(k) * Math.PI);
  if (e <= 0.001) return;
  switch (kind) {
    case 'wave':
      b.armR.rotation.x += -1.7 * e;
      b.armR.rotation.z += -0.9 * e;
      b.foreR.rotation.x += -0.5 * e + Math.sin(k * 22) * 0.45 * e;
      b.torso.rotation.y += 0.06 * e;
      break;
    case 'point':
      b.armR.rotation.x += -1.35 * e;
      b.foreR.rotation.x += 0.15 * e;
      b.torso.rotation.y += -0.16 * e;
      b.head.rotation.y += 0.2 * e;
      break;
    case 'talk': {
      const g = Math.sin(k * 13) * 0.4 * e;
      b.armR.rotation.x += -0.55 * e + g;
      b.armL.rotation.x += -0.5 * e - g;
      b.foreR.rotation.x += -0.75 * e;
      b.foreL.rotation.x += -0.7 * e;
      b.head.rotation.x += Math.sin(k * 9) * 0.06 * e;
      break;
    }
    case 'shrug':
      b.armL.rotation.z += 0.55 * e;
      b.armR.rotation.z += -0.55 * e;
      b.foreL.rotation.z += 0.45 * e;
      b.foreR.rotation.z += -0.45 * e;
      b.head.rotation.x += -0.06 * e;
      break;
    case 'drink':
      b.armR.rotation.x += -2.2 * e;
      b.foreR.rotation.x += -1.5 * e;
      b.head.rotation.x += 0.32 * e;
      break;
    case 'beckon':
      b.armR.rotation.x += -1.6 * e;
      b.foreR.rotation.x += -0.7 - Math.sin(k * 17) * 0.55 * e;
      break;
    case 'sweep': {
      const s = Math.sin(k * 8) * e;
      b.armR.rotation.x += -0.9 * e;
      b.armL.rotation.x += -0.7 * e;
      b.foreR.rotation.x += -0.6 * e;
      b.torso.rotation.y += s * 0.18;
      b.torso.rotation.x += 0.12 * e;
      break;
    }
  }
}

// Standing personality: gentle weight shift & breathing beyond the base idle.
function poseIdleFlavor(b, t, seed, kind) {
  const sway = Math.sin(t * 0.55 + seed) * 0.028;
  b.torso.rotation.z += sway;
  b.root.rotation.z += -sway * 0.6;
  b.root.position.y += Math.sin(t * 0.8 + seed) * 0.006;
  if (kind === 'lean') {
    b.torso.rotation.x += 0.05 + Math.sin(t * 0.4 + seed) * 0.02;
    b.head.rotation.x += -0.05;
    b.armR.rotation.z += -0.12;
  } else if (kind === 'crossed') {
    b.armL.rotation.x += -0.9; b.armR.rotation.x += -0.9;
    b.armL.rotation.z += 0.35; b.armR.rotation.z += -0.35;
    b.foreL.rotation.x += -1.2; b.foreR.rotation.x += -1.2;
  } else if (kind === 'watch') {
    b.head.rotation.y += Math.sin(t * 0.35 + seed) * 0.4;
  }
}

// Combat ready-stance overlay so hostiles read as dangerous even between swings.
function poseGuardStance(b, k) {
  b.torso.rotation.y += -0.22 * k;
  b.armR.rotation.x += -0.5 * k;
  b.armR.rotation.z += 0.12 * k;
  b.foreR.rotation.x += -0.7 * k;
  b.armL.rotation.x += -0.35 * k;
  b.foreL.rotation.x += -0.9 * k;
}

class NPC {
  constructor(ctx, { role, name, pos, heading = 0, hostileKind = null, portName = null, look = null }) {
    this.ctx = ctx;
    this.role = role;
    this.name = name;
    this.portName = portName;
    this.hostileKind = hostileKind;
    const style = hostileKind ? HOSTILE_STYLE[hostileKind] : (ROLE_STYLE[role] ?? ROLE_STYLE.civilian);

    const coat = look?.coat ?? style.coat;
    const skin = look?.skin ?? style.skin ?? 0xc9976b;
    const accent = look?.accent ?? 0xc9a24b;
    const hat = look?.hat ?? style.hat ?? 'tricorne';
    const build = look?.build ?? 1;

    this.rig = buildHumanoid({
      palette: { coat, skin, accent, trousers: look?.trousers ?? 0x2c2820 },
      hat, build,
    });
    this.rig.group.position.copy(pos);
    ctx.scene.add(this.rig.group);
    if (hostileKind || role === 'guard') {
      this.sword = buildCutlass();
      this.rig.bones.handR.add(this.sword);
    }

    this.position = this.rig.group.position;
    this.facing = heading;
    this.alive = true;
    this.hostile = !!hostileKind;
    this.hp = style.hp ?? 40;
    this.hpMax = this.hp;
    this.staggered = 0;
    this.state = 'idle';
    this.dmg = style.dmg ?? [7, 11];
    this.moveSpeed = style.moveSpeed ?? 2.7;
    this.windup = style.windup ?? 0.5;
    this.blockChance = style.blockChance ?? 0.2;

    // motion / animation
    this._walkPhase = Math.random() * 6;
    this._speed01 = 0;
    this._headYaw = 0;
    this._headPitch = 0;

    // combat timers
    this._attackT = -1;
    this._struck = false;
    this._hitT = 9;
    this._deathT = -1;
    this._blockT = 0;
    this._retreatT = 0;
    this._reposeT = 0;
    this._strafeDir = Math.random() < 0.5 ? 1 : -1;
    this._lunge = 0;

    // wander / paths
    this.home = pos.clone();
    this._wander = pos.clone();
    this._wanderWait = randRange(Math.random, 0.5, 4);
    this._patrol = null;
    this._patrolIdx = 0;

    // personality
    this._seed = Math.random() * TAU;
    this._idleKind = ['watch', 'lean', 'crossed', 'stand', 'stand'][randInt(Math.random, 0, 4)];
    this._gestureT = -1;
    this._gestureKind = 'talk';
    this._gestureWait = randRange(Math.random, 5, 16);
    this._sayCooldown = randRange(Math.random, 4, 14);
    this._greeted = false;
  }

  _startGesture(kind) {
    if (this._gestureT >= 0) return;
    this._gestureKind = kind;
    this._gestureT = 0;
  }

  applyDamage(n, fromDir) {
    if (!this.alive) return;
    // stateful block: a raised guard soaks most of the blow; loose foes get a
    // small reflexive parry chance.
    if (this._blockT > 0) {
      n *= 0.25;
      this.ctx.effects?.sparks(_v.copy(this.position).setY(this.position.y + 1.2), 6);
      this.ctx.events?.emit('shake', { amount: 0.06 });
    } else if (this.hostile && this._attackT < 0 && Math.random() < this.blockChance * 0.5) {
      n *= 0.45;
      this.ctx.effects?.sparks(this.position, 5);
    }
    this.hp -= n;
    this._hitT = 0;
    if (!this.hostile && this.role !== 'guard') {
      this.state = 'flee';
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this._deathT = 0;
      if (this.hostile) {
        const gold = Math.round(randRange(Math.random, 5, 20));
        this.ctx.state?.addGold(gold);
        this.ctx.events?.emit('toast', { text: `+${gold} sovereigns`, kind: 'gold' });
        this.ctx.events?.emit('npc:killed', { npc: this });
      }
    } else if (this.hostile) {
      this.state = 'combat';
      // getting hit mid-windup can break the swing; the wounded briefly give ground
      if (this.hp < this.hpMax * 0.32 && Math.random() < 0.5) {
        this._retreatT = randRange(Math.random, 0.5, 1.1);
        this._attackT = -1;
      }
    }
  }

  stagger() {
    this.staggered = 1.25;
    this._attackT = -1;
    this._blockT = 0;
    this._lunge = 0;
    this.ctx.effects?.sparks(_v.copy(this.position).setY(this.position.y + 1.3), 8);
    this.ctx.events?.emit('shake', { amount: 0.12 });
    this._retreatT = 0.8;
  }

  _moveAlong(angle, speed, dt, factor = 1) {
    this.position.x += Math.sin(angle) * speed * dt * factor;
    this.position.z += Math.cos(angle) * speed * dt * factor;
  }

  update(dt) {
    const ctx = this.ctx;
    const b = this.rig.bones;

    if (!this.alive) {
      this._deathT += dt;
      resetPose(b);
      animDeath(b, this._deathT * 1.5);
      const fade = clamp(1 - (this._deathT - 3) / 3, 0, 1);
      if (this._deathT > 3) {
        this.rig.group.traverse((o) => {
          if (o.material && o.material.transparent !== undefined) {
            o.material.transparent = true;
            o.material.opacity = fade;
          }
        });
      }
      return this._deathT > 6; // true = remove
    }

    const player = ctx.character;
    const playerActive = player?.alive && ctx.mode === 'foot';
    const pDist = playerActive ? this.position.distanceTo(player.position) : Infinity;

    // LOD: far NPCs sleep entirely.
    if (pDist > 140) return false;

    let moving = false;
    let speed = 1.6;

    // decay timers
    if (this._blockT > 0) this._blockT -= dt;

    if (this.staggered > 0) {
      this.staggered -= dt;
    } else if (this._retreatT > 0 && this.hostile && player?.alive) {
      // give ground, still facing the player (backpedal)
      this._retreatT -= dt;
      const toPlayer = Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z);
      this.facing = angleDamp(this.facing, toPlayer, 7, dt);
      moving = true;
      speed = this.moveSpeed * 0.75;
      this._moveAlong(toPlayer + Math.PI, speed, dt);
    } else if (this.hostile && this.state !== 'flee') {
      moving = this._updateCombat(dt, player, pDist);
      speed = this.moveSpeed;
    } else if (this.state === 'flee' && player) {
      const away = Math.atan2(this.position.x - player.position.x, this.position.z - player.position.z);
      this.facing = angleDamp(this.facing, away, 8, dt);
      moving = true;
      speed = 3.4;
      this._moveAlong(away, speed, dt);
      if (pDist > 42) { this.state = 'idle'; this._wanderWait = 0.5; }
    } else if (this.role === 'guard') {
      moving = this._updatePatrol(dt, pDist, player);
      speed = 1.35;
    } else if (this.role === 'civilian' || this.role === 'dockworker') {
      moving = this._updateWander(dt, pDist, player);
      speed = this.role === 'dockworker' ? 1.15 : 1.05;
    } else if (pDist < 6) {
      // shopkeepers face the approaching player and greet
      const toPlayer = Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z);
      this.facing = angleDamp(this.facing, toPlayer, 5, dt);
      this._maybeGreet(pDist, 'beckon');
    }

    // stick to the ground (deck / dock / terrain)
    this.position.y = ctx.world?.getWalkHeight?.(this.position.x, this.position.z) ?? 0;

    // ---- animation (LOD-gated) ----
    if (pDist < 90) this._animate(dt, b, moving, speed, playerActive, player, pDist);
    this._hitT += dt;
    return false;
  }

  // -- hostile brain: approach → telegraphed windup → strike → block → circle --
  _updateCombat(dt, player, pDist) {
    if (!player?.alive) return false;
    const range = 2.25;
    const toPlayer = Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z);
    // turn faster while winding up (commit the swing), slower while circling
    this.facing = angleDamp(this.facing, toPlayer, this._attackT >= 0 ? 11 : 7, dt);

    if (pDist < 24) this.state = 'combat';
    if (this._reposeT > 0) this._reposeT -= dt;

    if (this._attackT >= 0) {
      // swing in progress: windup → strike (at windup s) → recover
      this._attackT += dt;
      const strikeAt = this.windup;
      const endAt = this.windup + 0.42;
      // short forward lunge that fires as the blade comes down
      if (this._lunge > 0) {
        this._lunge -= dt;
        this._moveAlong(this.facing, this.moveSpeed * 1.35, dt);
      }
      if (!this._struck && this._attackT > strikeAt) {
        this._struck = true;
        this._lunge = 0.12;
        this.ctx.effects?.sparks(_v.copy(this.position).addScaledVector(_v2.set(Math.sin(this.facing), 0, Math.cos(this.facing)), 1.1).setY(this.position.y + 1.1), 3);
        if (pDist < range + 0.6) {
          const result = player.applyDamage(randRange(Math.random, this.dmg[0], this.dmg[1]), toPlayer);
          if (result === 'parried') this.stagger();
          else if (result === 'dodged') this._reposeT = 0.5; // whiffed, brief opening
        }
      }
      if (this._attackT > endAt) {
        this._attackT = -1;
        this._reposeT = randRange(Math.random, 0.25, 0.7);
        // sometimes reset spacing after a swing
        if (Math.random() < 0.4) this._retreatT = randRange(Math.random, 0.3, 0.7);
        if (Math.random() < 0.5) this._strafeDir *= -1;
      }
      return true;
    }

    // raise guard reactively when the player is swinging in our face
    const playerSwinging = player.sword?.attacking;
    if (this._blockT <= 0 && playerSwinging && pDist < range + 0.9 && this._reposeT <= 0 &&
        Math.random() < this.blockChance * dt * 20) {
      this._blockT = randRange(Math.random, 0.35, 0.6);
      return false;
    }
    if (this._blockT > 0) return false;

    if (pDist > range) {
      // close the distance, weaving slightly so it isn't a straight line
      const weave = Math.sin(this.ctx.time.t * 2 + this._seed) * 0.25;
      this._moveAlong(toPlayer + weave, this.moveSpeed, dt);
      return true;
    }

    // in range: commit to a swing, or circle for an opening
    if (this._reposeT <= 0 && Math.random() < dt * 1.1) {
      this._attackT = 0;
      this._struck = false;
      this._lunge = 0;
      if (Math.random() < 0.14) this.ctx.events?.emit('npc:say', { npc: this, text: BARKS[randInt(Math.random, 0, BARKS.length - 1)] });
      return false;
    }
    // circle-strafe around the player
    const strafe = toPlayer + this._strafeDir * (Math.PI / 2);
    this._moveAlong(strafe, this.moveSpeed * 0.5, dt);
    // ease toward preferred spacing
    if (pDist < range - 0.4) this._moveAlong(toPlayer + Math.PI, this.moveSpeed * 0.4, dt);
    return true;
  }

  // -- guard patrol loop; pauses to scan, tracks the player when close --------
  _updatePatrol(dt, pDist, player) {
    if (this._patrol && this._patrol.length) {
      const tgt = this._patrol[this._patrolIdx];
      const d = Math.hypot(tgt.x - this.position.x, tgt.z - this.position.z);
      if (d > 1.4) {
        const to = Math.atan2(tgt.x - this.position.x, tgt.z - this.position.z);
        this.facing = angleDamp(this.facing, to, 5, dt);
        this._moveAlong(this.facing, 1.35, dt);
        return true;
      }
      // reached a node: pause and scan before moving on
      this._wanderWait -= dt;
      if (this._wanderWait <= 0) {
        this._wanderWait = randRange(Math.random, 2.5, 5.5);
        this._patrolIdx = (this._patrolIdx + 1) % this._patrol.length;
      }
    } else {
      // no route — loose wander like a civilian
      return this._updateWander(dt, pDist, player);
    }
    // watch the player when they wander into view
    if (pDist < 12 && player?.alive) {
      const toP = Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z);
      this.facing = angleDamp(this.facing, toP, 3, dt);
    }
    return false;
  }

  // -- civilians walk between port waypoints, then loiter --------------------
  _updateWander(dt, pDist, player) {
    this._wanderWait -= dt;
    const d = Math.hypot(this._wander.x - this.position.x, this._wander.z - this.position.z);
    if (d > 1.2) {
      const to = Math.atan2(this._wander.x - this.position.x, this._wander.z - this.position.z);
      this.facing = angleDamp(this.facing, to, 6, dt);
      this._moveAlong(this.facing, this.role === 'dockworker' ? 1.15 : 1.05, dt);
      return true;
    }
    if (this._wanderWait <= 0) {
      this._pickWanderTarget();
      this._wanderWait = randRange(Math.random, 3, 9);
    }
    // loitering: chatter + greet passers-by
    this._maybeChatter(dt, pDist);
    this._maybeGreet(pDist, 'wave');
    return false;
  }

  _pickWanderTarget() {
    const nodes = this._nodes;
    if (nodes && nodes.length && Math.random() < 0.75) {
      const n = nodes[Math.floor(Math.random() * nodes.length)];
      this._wander.set(n.x + randRange(Math.random, -2.5, 2.5), 0, n.z + randRange(Math.random, -2.5, 2.5));
    } else {
      const range = 14;
      this._wander.set(
        this.home.x + randRange(Math.random, -range, range), 0,
        this.home.z + randRange(Math.random, -range, range),
      );
    }
  }

  _maybeChatter(dt, pDist) {
    this._sayCooldown -= dt;
    if (this._sayCooldown > 0) return;
    if (this.role !== 'civilian') { this._sayCooldown = randRange(Math.random, 14, 30); return; }
    this._sayCooldown = randRange(Math.random, 20, 44);
    if (pDist < 9) {
      const useRumor = Math.random() < 0.5;
      const lines = useRumor ? (this.ctx.data?.lore?.rumors ?? MUTTERS) : MUTTERS;
      this._startGesture(Math.random() < 0.5 ? 'talk' : 'shrug');
      this.ctx.events?.emit('npc:say', { npc: this, text: lines[Math.floor(Math.random() * lines.length)] });
    }
  }

  _maybeGreet(pDist, gesture) {
    if (pDist < 5.5 && !this._greeted) {
      this._greeted = true;
      this._startGesture(gesture);
      if (Math.random() < 0.55) {
        this.ctx.events?.emit('npc:say', { npc: this, text: GREETINGS[Math.floor(Math.random() * GREETINGS.length)] });
      }
    } else if (pDist > 10) {
      this._greeted = false;
    }
  }

  _animate(dt, b, moving, speed, playerActive, player, pDist) {
    const t = this.ctx.time.t;
    this._speed01 = clamp(this._speed01 + ((moving ? speed / 3 : 0) - this._speed01) * dt * 8, 0, 1);
    if (moving) this._walkPhase += dt * (4 + speed * 1.6);

    resetPose(b);
    animIdle(b, t + this._walkPhase);

    if (this._speed01 > 0.03) {
      animWalk(b, this._walkPhase, this._speed01);
    } else if (!this.hostile) {
      // idle personality only when actually standing still
      poseIdleFlavor(b, t, this._seed, this._idleKind);
    }

    // gestures (roll them off over ~1.1s)
    if (this._gestureT >= 0) {
      this._gestureT += dt / 1.15;
      poseGesture(b, this._gestureKind, this._gestureT);
      if (this._gestureT >= 1) this._gestureT = -1;
    } else if (!this.hostile && this._speed01 < 0.1) {
      this._gestureWait -= dt;
      if (this._gestureWait <= 0) {
        this._gestureWait = randRange(Math.random, 7, 20);
        const pool = this._idleKind === 'lean'
          ? ['drink', 'talk', 'shrug'] : ['wave', 'talk', 'shrug', 'point', 'sweep'];
        this._startGesture(pool[randInt(Math.random, 0, pool.length - 1)]);
      }
    }

    // head look-at: track the player when they are close and we aren't sprinting
    let targetYaw = 0, targetPitch = 0;
    if (playerActive && pDist < 13 && this._speed01 < 0.6 && this._retreatT <= 0) {
      const toP = Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z);
      targetYaw = wrapAngle(toP - this.facing);
      targetPitch = clamp((player.position.y + 1.5 - (this.position.y + 1.6)) / Math.max(pDist, 1.2), -0.4, 0.35);
    }
    this._headYaw = damp(this._headYaw, targetYaw, 6, dt);
    this._headPitch = damp(this._headPitch, targetPitch, 6, dt);
    poseHeadLook(b, this._headYaw, this._headPitch);

    // combat overlays
    if (this._attackT >= 0) {
      const k = clamp01(this._attackT / (this.windup + 0.42));
      animAttack(b, k, false);
    } else if (this._blockT > 0) {
      animBlock(b, clamp01(this._blockT / 0.5));
    } else if (this.hostile && this.state === 'combat') {
      poseGuardStance(b, 0.85);
    }

    if (this.staggered > 0) animHit(b, 1 - this.staggered / 1.25);
    else if (this._hitT < 0.4) animHit(b, this._hitT / 0.4);

    this.rig.group.rotation.y = this.facing;
  }

  dispose() {
    this.ctx.scene.remove(this.rig.group);
    this.rig.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else o.material.dispose?.();
      }
    });
  }
}

export class NPCManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.npcs = [];
    this.hostiles = [];
    this._populatedPort = null;
    this._promptShown = false;
    this._nodes = null;
    this._panicAcc = 0;

    ctx.events?.on('guards:aggro', () => {
      for (const npc of this.npcs) {
        if (npc.role === 'guard' && npc.alive) {
          npc.hostile = true;
          npc.hostileKind = 'marine';
          npc.state = 'combat';
          const s = HOSTILE_STYLE.marine;
          npc.dmg = s.dmg; npc.moveSpeed = s.moveSpeed; npc.windup = s.windup; npc.blockChance = s.blockChance;
          if (!this.hostiles.includes(npc)) this.hostiles.push(npc);
        }
      }
    });
  }

  get interactables() {
    const out = [];
    for (const npc of this.npcs) {
      if (!npc.alive || npc.hostile) continue;
      const style = ROLE_STYLE[npc.role];
      if (npc.role === 'tavernkeep' || npc.role === 'shipwright' || npc.role === 'merchant' || npc.role === 'questgiver') {
        out.push({ position: npc.position, label: `Talk — ${npc.name}, ${style.label}`, npc });
      } else if (npc.role === 'civilian') {
        out.push({ position: npc.position, label: `Talk — ${npc.name}`, npc });
      }
    }
    return out;
  }

  spawnHostile(pos, kind = 'brigand') {
    const names = this.ctx.data?.names;
    const npc = new NPC(this.ctx, {
      role: 'hostile', hostileKind: kind,
      name: names?.npcName?.(Math.random) ?? 'Cutthroat',
      pos: pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y ?? 0, pos.z),
    });
    npc.state = 'combat';
    this.npcs.push(npc);
    this.hostiles.push(npc);
    return npc;
  }

  // Build a set of walkable "hangout" nodes across the port so civilians travel
  // real paths (pier ↔ market ↔ tavern ↔ homes) instead of jittering in place.
  _buildNodes(port) {
    const nodes = [];
    if (port.dockPosition) nodes.push(port.dockPosition.clone());
    if (port.position) nodes.push(port.position.clone());
    for (const b of port.buildings ?? []) {
      const p = b.doorPosition ?? b.position;
      if (p) nodes.push(p.clone());
    }
    // a couple of midpoints to make the crossings feel like streets
    if (nodes.length >= 2) {
      const a = nodes[0], b = nodes[Math.min(2, nodes.length - 1)];
      nodes.push(new THREE.Vector3((a.x + b.x) / 2, 0, (a.z + b.z) / 2));
    }
    this._nodes = nodes;
    return nodes;
  }

  _lookFor(faction, role) {
    const fac = FACTION_LOOK[faction] ?? FACTION_LOOK.corsairs;
    if (role === 'guard') return null; // guards keep their crown-marine style
    const coat = fac.coats[Math.floor(Math.random() * fac.coats.length)];
    const hat = fac.hats[Math.floor(Math.random() * fac.hats.length)];
    const skin = SKIN_TONES[Math.floor(Math.random() * SKIN_TONES.length)];
    return { coat, hat, skin, accent: fac.accent, build: randRange(Math.random, 0.94, 1.08) };
  }

  _populate(island) {
    const port = island.port;
    if (!port) return;
    this._populatedPort = port;
    const names = this.ctx.data?.names;
    const rng = Math.random;
    const faction = port.faction ?? island.def?.faction ?? 'corsairs';
    const nodes = this._buildNodes(port);

    const budgetLeft = () => MAX_NPCS - this.npcs.length;

    const roleFor = { tavern: 'tavernkeep', shipwright: 'shipwright', market: 'merchant', questboard: 'questgiver' };
    for (const b of port.buildings) {
      if (budgetLeft() <= 0) break;
      const role = roleFor[b.kind];
      if (!role || !b.doorPosition) continue;
      const npc = new NPC(this.ctx, {
        role, name: names?.npcName?.(rng) ?? 'Keeper',
        pos: b.doorPosition.clone(), portName: port.name,
        heading: Math.atan2(port.position.x - b.doorPosition.x, port.position.z - b.doorPosition.z),
      });
      npc._nodes = nodes;
      this.npcs.push(npc);
    }

    const civWant = port.size === 'capital' ? 9 : port.size === 'village' ? 4 : 6;
    const civs = Math.min(civWant, budgetLeft());
    for (let i = 0; i < civs; i++) {
      const start = nodes.length ? nodes[Math.floor(rng() * nodes.length)] : port.position;
      const pos = start.clone();
      pos.x += randRange(rng, -8, 8);
      pos.z += randRange(rng, -8, 8);
      const role = i === 0 ? 'dockworker' : 'civilian';
      const npc = new NPC(this.ctx, {
        role, name: names?.npcName?.(rng) ?? 'Deckhand',
        pos, portName: port.name, look: this._lookFor(faction, role),
      });
      npc._nodes = nodes;
      this.npcs.push(npc);
    }

    if (faction === 'crown') {
      const gWant = port.size === 'capital' ? 4 : 2;
      const guards = Math.min(gWant, budgetLeft());
      const wanted = (this.ctx.state?.data?.reputation?.crown ?? 0) < -40;
      for (let i = 0; i < guards; i++) {
        const pos = port.position.clone();
        pos.x += randRange(rng, -24, 24);
        pos.z += randRange(rng, -24, 24);
        const guard = new NPC(this.ctx, {
          role: 'guard', name: names?.npcName?.(rng) ?? 'Marine',
          pos, portName: port.name,
        });
        // assign a patrol loop of 2-3 town nodes
        if (nodes.length >= 2) {
          const route = [];
          const count = Math.min(3, nodes.length);
          for (let k = 0; k < count; k++) route.push(nodes[(i + k) % nodes.length]);
          guard._patrol = route;
        }
        this.npcs.push(guard);
        if (wanted) {
          guard.hostile = true;
          guard.hostileKind = 'marine';
          guard.state = 'combat';
          const s = HOSTILE_STYLE.marine;
          guard.dmg = s.dmg; guard.moveSpeed = s.moveSpeed; guard.windup = s.windup; guard.blockChance = s.blockChance;
          this.hostiles.push(guard);
        }
      }
    }
  }

  _depopulate() {
    for (const npc of this.npcs) npc.dispose();
    this.npcs.length = 0;
    this.hostiles.length = 0;
    this._populatedPort = null;
    this._nodes = null;
  }

  // Civilians scatter when a fight breaks out near them (throttled).
  _panic(dt) {
    this._panicAcc -= dt;
    if (this._panicAcc > 0 || !this.hostiles.length) return;
    this._panicAcc = 0.4;
    for (const npc of this.npcs) {
      if (npc.hostile || !npc.alive || npc.state === 'flee' || npc.role === 'guard') continue;
      for (const h of this.hostiles) {
        if (!h.alive) continue;
        if (npc.position.distanceToSquared(h.position) < 196) { npc.state = 'flee'; break; }
      }
    }
  }

  update(dt) {
    const ctx = this.ctx;
    if (ctx.mode === 'menu') return;

    // port population by proximity
    const focus = ctx.mode === 'foot' ? ctx.character?.position : ctx.playerShip?.ship?.position;
    if (focus) {
      const near = ctx.world?.getNearestPort?.(focus);
      if (near && near.distance < 260 && this._populatedPort !== near.port) {
        this._depopulate();
        this._populate(near.island);
      } else if (this._populatedPort && (!near || near.distance > 420)) {
        this._depopulate();
      }
    }

    this._panic(dt);

    // update all
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const npc = this.npcs[i];
      const remove = npc.update(dt);
      if (remove) {
        npc.dispose();
        this.npcs.splice(i, 1);
        const hi = this.hostiles.indexOf(npc);
        if (hi >= 0) this.hostiles.splice(hi, 1);
      }
    }

    // interaction prompt + E handling (foot mode) — iterate directly to avoid
    // building the interactables array every frame.
    if (ctx.mode === 'foot' && ctx.character?.alive && !ctx.time.paused) {
      const cp = ctx.character.position;
      let best = null, bestD = 2.6;
      for (const npc of this.npcs) {
        if (!npc.alive || npc.hostile) continue;
        const r = npc.role;
        const talkable = r === 'tavernkeep' || r === 'shipwright' || r === 'merchant' || r === 'questgiver' || r === 'civilian';
        if (!talkable) continue;
        const d = npc.position.distanceTo(cp);
        if (d < bestD) { bestD = d; best = npc; }
      }
      if (best) {
        this._promptShown = true;
        const style = ROLE_STYLE[best.role];
        const label = style?.label ? `${best.name}, ${style.label}` : best.name;
        ctx.events?.emit('prompt', { id: 'npc', text: `E — Talk — ${label}` });
        if (ctx.input.wasPressed('KeyE')) {
          if (best.role === 'civilian') {
            const lines = ctx.data?.lore?.rumors ?? ['Fair winds, stranger.'];
            best._startGesture('talk');
            ctx.events?.emit('npc:say', { npc: best, text: lines[Math.floor(Math.random() * lines.length)] });
          } else {
            ctx.events?.emit('npc:interact', { npc: best });
          }
        }
      } else if (this._promptShown) {
        this._promptShown = false;
        ctx.events?.emit('prompt', { id: 'npc', text: null });
      }
    } else if (this._promptShown) {
      this._promptShown = false;
      ctx.events?.emit('prompt', { id: 'npc', text: null });
    }
  }
}
