// Player melee: light combos, heavy, parry/block, dodge, pistol.
import * as THREE from 'three';
import { COMBAT } from '../core/constants.js';
import { wrapAngle } from '../core/utils.js';
import { buildCutlass } from './humanoid.js';

const _dir = new THREE.Vector3();

export class SwordCombat {
  constructor(ctx, character) {
    this.ctx = ctx;
    this.ch = character;

    this.attackT = -1;      // -1 idle; else 0..duration
    this.attackDur = 0.5;
    this.combo = 0;
    this.heavy = false;
    this.struck = false;
    this.queued = false;

    this.blockHeld = false;
    this.parryT = -1;       // time since RMB press (parry window 0.35s)

    this.dodgeT = -1;
    this.dodgeDir = new THREE.Vector3();

    this.pistolReload = 0;

    this.sword = buildCutlass();
    character.rig.bones.handR.add(this.sword);

    // pistol at the hip
    const pistol = new THREE.Group();
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.03, 0.24, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a3a3e, metalness: 0.7, roughness: 0.4 }),
    );
    barrel.rotation.x = Math.PI / 2;
    pistol.add(barrel);
    pistol.position.set(-0.2, 0.02, 0.1);
    pistol.rotation.z = 0.5;
    character.rig.bones.root.add(pistol);
  }

  get attacking() { return this.attackT >= 0; }
  get dodging() { return this.dodgeT >= 0 && this.dodgeT < 0.45; }
  get parryActive() { return this.blockHeld && this.parryT >= 0 && this.parryT < 0.35; }
  get blocking() { return this.blockHeld; }

  /** Called by NPC attacks. Returns 'parried' | 'blocked' | null. */
  tryDefend() {
    if (this.dodging) return 'dodged';
    if (this.parryActive) {
      this.ctx.effects?.sparks(this.ch.position, 10);
      this.ctx.events?.emit('parry', {});
      return 'parried';
    }
    if (this.blocking) return 'blocked';
    return null;
  }

  startAttack(heavy) {
    this.attackT = 0;
    this.attackDur = heavy ? 0.72 : 0.42;
    this.heavy = heavy;
    this.struck = false;
    if (!heavy) this.combo = (this.combo % 3) + 1;
    else this.combo = 0;
  }

  _strike() {
    const ctx = this.ctx;
    const ch = this.ch;
    const hostiles = ctx.npcs?.hostiles ?? [];
    let base = this.heavy ? COMBAT.SWORD_HEAVY_DMG
      : COMBAT.SWORD_LIGHT_DMG * (this.combo === 3 ? 1.4 : 1);
    base *= ctx.progression?.getMod?.('swordDamage') ?? 1;

    const facing = ch.facing;
    let hitAny = false;
    for (const h of hostiles) {
      if (!h.alive) continue;
      _dir.subVectors(h.position, ch.position);
      const dist = _dir.length();
      if (dist > 2.35) continue;
      const ang = Math.atan2(_dir.x, _dir.z);
      if (Math.abs(wrapAngle(ang - facing)) > 0.95) continue;
      h.applyDamage(base * (0.9 + Math.random() * 0.2), facing);
      hitAny = true;
      ctx.effects?.sparks(h.position, 4);
    }
    if (hitAny) {
      ctx.events?.emit('sword:hit', { heavy: this.heavy });
      ch.animFreeze = 0.06; // hit-stop
    } else {
      ctx.events?.emit('sword:swing', {});
    }
  }

  firePistol() {
    const ctx = this.ctx;
    const ch = this.ch;
    if (this.pistolReload > 0) {
      ctx.events?.emit('toast', { text: 'Pistol reloading…', kind: 'info' });
      return;
    }
    this.pistolReload = 6;
    const muzzle = ch.position.clone();
    muzzle.y += 1.4;
    _dir.set(Math.sin(ch.facing), 0, Math.cos(ch.facing));
    ctx.effects?.muzzleFlash(muzzle, _dir);
    ctx.events?.emit('pistol:fire', {});

    let best = null, bestD = 18;
    for (const h of ctx.npcs?.hostiles ?? []) {
      if (!h.alive) continue;
      _dir.subVectors(h.position, ch.position);
      const dist = _dir.length();
      if (dist > 18) continue;
      const ang = Math.atan2(_dir.x, _dir.z);
      if (Math.abs(wrapAngle(ang - ch.facing)) > 0.26) continue;
      if (dist < bestD) { bestD = dist; best = h; }
    }
    if (best) {
      const dmg = COMBAT.PISTOL_DMG * (this.ctx.progression?.getMod?.('pistolDamage') ?? 1);
      best.applyDamage(dmg, ch.facing);
      this.ctx.effects?.sparks(best.position, 6);
    }
  }

  update(dt) {
    const ctx = this.ctx;
    const input = ctx.input;
    const ch = this.ch;
    if (ctx.mode !== 'foot' || ctx.time.paused || !ch.alive) return;

    this.pistolReload = Math.max(0, this.pistolReload - dt);

    // block / parry
    const rmb = input.mouse.pressed(2);
    if (rmb && !this.blockHeld) this.parryT = 0;
    if (rmb) this.parryT += dt;
    this.blockHeld = rmb && !ch.isSwimming;

    // dodge
    if (this.dodgeT >= 0) {
      this.dodgeT += dt;
      if (this.dodgeT > 0.55) this.dodgeT = -1;
    }

    // attacks
    if (this.attackT >= 0) {
      this.attackT += dt;
      const k = this.attackT / this.attackDur;
      if (!this.struck && k >= 0.55) {
        this.struck = true;
        this._strike();
      }
      if (k >= 1) {
        this.attackT = -1;
        if (this.queued) {
          this.queued = false;
          this.startAttack(false);
        }
      }
    }

    if (ch.isSwimming || this.blockHeld) return;

    if (input.mouse.wasPressed(0) && !ctx.ui?.pointerOverUI) {
      if (this.attackT < 0) this.startAttack(false);
      else if (this.attackT / this.attackDur > 0.4) this.queued = true;
    }
    // heavy: hold LMB — detect long press
    if (input.mouse.pressed(0)) {
      this._lmbHold = (this._lmbHold ?? 0) + dt;
      if (this._lmbHold > 0.42 && this.attackT < 0) {
        this.startAttack(true);
        this._lmbHold = 0;
      }
    } else {
      this._lmbHold = 0;
    }

    if (input.wasPressed('KeyF')) this.firePistol();
  }

  startDodge(dirX, dirZ) {
    if (this.dodgeT >= 0 || this.ch.stamina < 20) return false;
    this.dodgeT = 0;
    this.dodgeDir.set(dirX, 0, dirZ).normalize();
    this.ch.stamina -= 20;
    return true;
  }
}
