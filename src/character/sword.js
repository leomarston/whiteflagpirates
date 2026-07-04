// Player melee: light combos, heavy, parry/block → riposte, dodge i-frames,
// pistol. Weighty hits sell through hit-stop, a swept blade trail, sparks, and
// event-driven camera shake + sfx. Hot paths allocate nothing.
import * as THREE from 'three';
import { COMBAT } from '../core/constants.js';
import { wrapAngle } from '../core/utils.js';
import { buildCutlass } from './humanoid.js';

const _dir = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _tipV = new THREE.Vector3();
const _baseV = new THREE.Vector3();

const TRAIL_SEGS = 14;                 // ribbon cross-sections - 1
const TRAIL_ROWS = TRAIL_SEGS + 1;

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

    this._riposteT = -1;    // open counter window after a parry
    this._riposte = false;  // next strike is an empowered riposte
    this._lmbHold = 0;

    this.sword = buildCutlass();
    character.rig.bones.handR.add(this.sword);
    this._tip = this.sword.userData?.tip ?? this.sword;
    this._base = this.sword.userData?.base ?? this.sword;

    // pistol at the hip
    const pistol = new THREE.Group();
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.03, 0.24, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a3a3e, metalness: 0.7, roughness: 0.4 }),
    );
    barrel.rotation.x = Math.PI / 2;
    pistol.add(barrel);
    const stock = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.12, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.8 }),
    );
    stock.position.set(0, -0.07, -0.08);
    stock.rotation.x = 0.4;
    pistol.add(stock);
    pistol.position.set(-0.2, 0.02, 0.1);
    pistol.rotation.z = 0.5;
    character.rig.bones.root.add(pistol);

    this._buildTrail(ctx);

    ctx.events?.on('mode:change', ({ mode }) => {
      if (mode !== 'foot') this._killTrail();
    });
  }

  get attacking() { return this.attackT >= 0; }
  get dodging() { return this.dodgeT >= 0 && this.dodgeT < 0.45; }
  get parryActive() { return this.blockHeld && this.parryT >= 0 && this.parryT < 0.35; }
  get blocking() { return this.blockHeld; }
  get riposteReady() { return this._riposteT >= 0 && this._riposteT < 0.7; }

  // ---- blade trail (world-space swept ribbon, pooled) ---------------------
  _buildTrail(ctx) {
    const geo = new THREE.BufferGeometry();
    this._trailPos = new Float32Array(TRAIL_ROWS * 2 * 3);
    this._trailCol = new Float32Array(TRAIL_ROWS * 2 * 4);
    this._tipSamples = new Float32Array(TRAIL_ROWS * 3);
    this._baseSamples = new Float32Array(TRAIL_ROWS * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this._trailPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this._trailCol, 4));
    const idx = [];
    for (let i = 0; i < TRAIL_SEGS; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      idx.push(a, b, c, b, d, c);
    }
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this._trail = new THREE.Mesh(geo, mat);
    this._trail.frustumCulled = false;
    this._trail.renderOrder = 7;
    this._trail.visible = false;
    this._trailGeo = geo;
    this._trailFade = 0;
    this._swinging = false;
    this._trailHead = 0.55 * (ctx.engine?.qualityProfile?.particleScale ?? 1);
    ctx.scene?.add(this._trail);
  }

  _seedTrail() {
    this._tip.getWorldPosition(_tipV);
    this._base.getWorldPosition(_baseV);
    for (let i = 0; i < TRAIL_ROWS; i++) {
      const p = i * 3;
      this._tipSamples[p] = _tipV.x; this._tipSamples[p + 1] = _tipV.y; this._tipSamples[p + 2] = _tipV.z;
      this._baseSamples[p] = _baseV.x; this._baseSamples[p + 1] = _baseV.y; this._baseSamples[p + 2] = _baseV.z;
    }
  }

  _pushTrail() {
    this._tip.getWorldPosition(_tipV);
    this._base.getWorldPosition(_baseV);
    // shift samples one row older, then write the newest at row 0
    this._tipSamples.copyWithin(3, 0, (TRAIL_ROWS - 1) * 3);
    this._baseSamples.copyWithin(3, 0, (TRAIL_ROWS - 1) * 3);
    this._tipSamples[0] = _tipV.x; this._tipSamples[1] = _tipV.y; this._tipSamples[2] = _tipV.z;
    this._baseSamples[0] = _baseV.x; this._baseSamples[1] = _baseV.y; this._baseSamples[2] = _baseV.z;
  }

  _writeTrail() {
    const pos = this._trailPos, col = this._trailCol;
    const head = this._trailHead * this._trailFade;
    for (let i = 0; i < TRAIL_ROWS; i++) {
      const s = i * 3;
      const vb = i * 2 * 3, vt = (i * 2 + 1) * 3;
      pos[vb] = this._baseSamples[s]; pos[vb + 1] = this._baseSamples[s + 1]; pos[vb + 2] = this._baseSamples[s + 2];
      pos[vt] = this._tipSamples[s]; pos[vt + 1] = this._tipSamples[s + 1]; pos[vt + 2] = this._tipSamples[s + 2];
      const a = (1 - i / TRAIL_SEGS) * head;
      const cb = i * 2 * 4, ct = (i * 2 + 1) * 4;
      col[cb] = 0.62; col[cb + 1] = 0.72; col[cb + 2] = 0.92; col[cb + 3] = a * 0.5;
      col[ct] = 0.85; col[ct + 1] = 0.92; col[ct + 2] = 1.0; col[ct + 3] = a;
    }
    this._trailGeo.attributes.position.needsUpdate = true;
    this._trailGeo.attributes.color.needsUpdate = true;
  }

  _killTrail() {
    this._swinging = false;
    this._trailFade = 0;
    if (this._trail) this._trail.visible = false;
  }

  /** Clear all combat/trail state — called on respawn so a mid-swing death
   *  doesn't leave the blade trail (and attack state) frozen in the world. */
  reset() {
    this.attackT = -1;
    this.combo = 0;
    this.heavy = false;
    this.struck = false;
    this.queued = false;
    this.blockHeld = false;
    this.parryT = -1;
    this.dodgeT = -1;
    this._riposteT = -1;
    this._riposte = false;
    this._lmbHold = 0;
    this._lmbDown = false;
    this._heavyFired = false;
    this._killTrail();
  }

  _updateTrail(dt, swinging) {
    if (swinging) {
      if (!this._swinging) { this._seedTrail(); this._trailFade = 1; this._trail.visible = true; }
      this._swinging = true;
      this._pushTrail();
      this._writeTrail();
    } else if (this._trail.visible) {
      this._swinging = false;
      this._trailFade -= dt * 7;
      if (this._trailFade <= 0) { this._killTrail(); return; }
      // let the ribbon hang and fade where it last swept
      this._writeTrail();
    }
  }

  /** Called by NPC attacks. Returns 'parried' | 'blocked' | 'dodged' | null. */
  tryDefend() {
    if (this.dodging) return 'dodged';
    if (this.parryActive) {
      _hit.copy(this.ch.position); _hit.y += 1.2;
      this.ctx.effects?.sparks(_hit, 12);
      this.ctx.events?.emit('parry', {});
      this.ctx.events?.emit('shake', { amount: 0.14 });
      this._riposteT = 0;              // open the counter window
      return 'parried';
    }
    if (this.blocking) {
      _hit.copy(this.ch.position); _hit.y += 1.2;
      this.ctx.effects?.sparks(_hit, 5);
      return 'blocked';
    }
    return null;
  }

  startAttack(heavy) {
    this.attackT = 0;
    this.attackDur = heavy ? 0.72 : 0.42;
    this.heavy = heavy;
    this.struck = false;
    this._riposte = this.riposteReady && !heavy;
    if (this._riposte) { this.attackDur = 0.5; this._riposteT = -1; }
    if (!heavy) this.combo = (this.combo % 3) + 1;
    else this.combo = 0;
  }

  _strike() {
    const ctx = this.ctx;
    const ch = this.ch;
    const hostiles = ctx.npcs?.hostiles ?? [];
    const finisher = this.combo === 3;
    let base = this.heavy ? COMBAT.SWORD_HEAVY_DMG
      : COMBAT.SWORD_LIGHT_DMG * (finisher ? 1.4 : 1);
    if (this._riposte) base *= 1.9;
    base *= ctx.progression?.getMod?.('swordDamage') ?? 1;
    const heavyImpact = this.heavy || finisher || this._riposte;

    const facing = ch.facing;
    const reach = this.heavy ? 2.55 : 2.35;
    const arc = this.heavy ? 1.15 : 0.95;
    let hitAny = false;
    for (const h of hostiles) {
      if (!h.alive) continue;
      _dir.subVectors(h.position, ch.position);
      const dist = _dir.length();
      if (dist > reach) continue;
      const ang = Math.atan2(_dir.x, _dir.z);
      if (Math.abs(wrapAngle(ang - facing)) > arc) continue;
      h.applyDamage(base * (0.9 + Math.random() * 0.2), facing);
      if (heavyImpact && h.stagger) h.stagger();
      hitAny = true;
      _hit.copy(h.position); _hit.y += 1.05;
      ctx.effects?.sparks(_hit, heavyImpact ? 9 : 5);
    }

    if (hitAny) {
      ctx.events?.emit('sword:hit', { heavy: heavyImpact });
      // hit-stop: brief global freeze scaled by impact = weight
      ch.animFreeze = this._riposte ? 0.11 : heavyImpact ? 0.09 : 0.05;
      if (this._riposte) ctx.events?.emit('shake', { amount: 0.2 });
    } else {
      ctx.events?.emit('sword:swing', {});
    }
    this._riposte = false;
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
    muzzle.addScaledVector(_dir, 0.4);
    ctx.effects?.muzzleFlash(muzzle, _dir);
    ctx.events?.emit('pistol:fire', {});
    ctx.events?.emit('shake', { amount: 0.14 });

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
      _hit.copy(best.position); _hit.y += 1.05;
      this.ctx.effects?.sparks(_hit, 7);
    }
  }

  update(dt) {
    const ctx = this.ctx;
    const input = ctx.input;
    const ch = this.ch;
    if (ctx.mode !== 'foot' || ctx.time.paused || !ch.alive) return;

    this.pistolReload = Math.max(0, this.pistolReload - dt);
    if (this._riposteT >= 0) {
      this._riposteT += dt;
      if (this._riposteT >= 0.7) this._riposteT = -1;
    }

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
    let swinging = false;
    if (this.attackT >= 0) {
      this.attackT += dt;
      const k = this.attackT / this.attackDur;
      if (!this.struck && k >= 0.5) {
        this.struck = true;
        this._strike();
      }
      // the ribbon lives across the fast part of the swing
      swinging = k >= 0.28 && k <= 0.92;
      if (k >= 1) {
        this.attackT = -1;
        if (this.queued) {
          this.queued = false;
          this.startAttack(false);
        } else {
          this.combo = 0; // chain broken — next light attack starts fresh
        }
      }
    }
    this._updateTrail(dt, swinging);

    if (ch.isSwimming || this.blockHeld) return;

    // Tap = light, hold = heavy. Don't commit on press: hold past the threshold
    // fires a single heavy; release before it fires a light (or buffers the next
    // combo hit). A fresh press is required for each attack — no auto-repeat.
    const HEAVY_HOLD = 0.34;
    const overUI = ctx.ui?.pointerOverUI;
    if (input.mouse.pressed(0) && !overUI) {
      if (!this._lmbDown) { this._lmbDown = true; this._lmbHold = 0; this._heavyFired = false; }
      this._lmbHold += dt;
      if (this._lmbHold >= HEAVY_HOLD && !this._heavyFired && this.attackT < 0) {
        this._heavyFired = true;
        this.startAttack(true);
      }
    } else {
      if (this._lmbDown && !this._heavyFired && this._lmbHold < HEAVY_HOLD) {
        if (this.attackT < 0) this.startAttack(false);
        else if (this.attackT / this.attackDur > 0.38) this.queued = true;
      }
      this._lmbDown = false;
      this._lmbHold = 0;
      this._heavyFired = false;
    }

    if (input.wasPressed('KeyF')) this.firePistol();
  }

  startDodge(dirX, dirZ) {
    if (this.dodgeT >= 0 || this.ch.stamina < 20) return false;
    this.dodgeT = 0;
    this.dodgeDir.set(dirX, 0, dirZ);
    if (this.dodgeDir.lengthSq() < 1e-4) this.dodgeDir.set(Math.sin(this.ch.facing), 0, Math.cos(this.ch.facing));
    this.dodgeDir.normalize();
    this.ch.stamina -= 20;
    return true;
  }
}
