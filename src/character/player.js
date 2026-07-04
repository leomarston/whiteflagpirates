// Third-person on-foot character: momentum movement, terrain-following, a
// spring/collision follow camera, responsive sprint/dodge/jump, and swimming.
import * as THREE from 'three';
import { PLAYER } from '../core/constants.js';
import { angleDamp, clamp, damp, lerp } from '../core/utils.js';
import {
  animAttack, animBlock, animDeath, animHit, animIdle, animLand, animSwim, animWalk,
  buildHumanoid, resetPose,
} from './humanoid.js';
import { SwordCombat } from './sword.js';

const _camPos = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _camProbe = new THREE.Vector3();
const _move = new THREE.Vector3();

export class Character {
  constructor(ctx) {
    this.ctx = ctx;
    this.rig = buildHumanoid({
      palette: { coat: 0x44525f, trousers: 0x2c2820, accent: 0xc9a24b },
      hat: 'tricorne',
    });
    this.rig.group.visible = false;
    ctx.scene.add(this.rig.group);

    this.position = this.rig.group.position;
    this.velY = 0;
    this.facing = 0;
    this.hpMax = PLAYER.HP_MAX;
    this.hp = this.hpMax;
    this.stamina = PLAYER.STAMINA_MAX;
    this.alive = true;
    this.isSwimming = false;
    this.underwater = false;
    this.grounded = true;
    this.animFreeze = 0;

    this._velX = 0;
    this._velZ = 0;
    this._walkPhase = 0;
    this._camYaw = 0;
    this._camPitch = 0.18;
    this._camDist = 4.6;
    this._hitT = 2;
    this._deathT = -1;
    this._speed01 = 0;
    this._stepAcc = 0;
    this._coyote = 0;
    this._jumpBuf = 0;
    this._landT = -1;

    this.sword = new SwordCombat(ctx, this);

    ctx.events?.on('mode:change', ({ mode }) => {
      this.rig.group.visible = mode === 'foot';
      if (mode === 'foot') {
        this._camYaw = this.facing + Math.PI;
        this._velX = 0;
        this._velZ = 0;
      }
    });
  }

  spawnAt(pos, heading = 0) {
    this.position.set(pos.x, pos.y ?? 0, pos.z);
    const ground = this.ctx.world?.getWalkHeight?.(pos.x, pos.z) ?? 0;
    this.position.y = Math.max(pos.y ?? ground, ground);
    this.facing = heading;
    this._camYaw = heading + Math.PI;
    this.velY = 0;
    this._velX = 0;
    this._velZ = 0;
    this.grounded = true;
    this.alive = true;
    this._deathT = -1;
    this._landT = -1;
    this.sword?.reset?.(); // clear any frozen mid-swing attack/trail from death
    if (this.hp <= 0) this.hp = this.hpMax;
  }

  /** Returns 'parried' | 'blocked' | 'dodged' | 'hit'. */
  applyDamage(n, fromDir) {
    if (!this.alive) return 'hit';
    const defended = this.sword.tryDefend();
    if (defended === 'parried' || defended === 'dodged') return defended;
    if (defended === 'blocked') n *= 0.45;
    this.hp -= n;
    this._hitT = 0;
    this.ctx.events?.emit('player:hurt', { hp: this.hp, hpMax: this.hpMax });
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this._deathT = 0;
      this.ctx.events?.emit('player:death', {});
    }
    return 'hit';
  }

  // Move by (dx, dz) honouring walls / steps; slides along blocked axes and
  // kills the blocked velocity component so we don't mush into geometry.
  _tryMove(dx, dz, maxStep) {
    const world = this.ctx.world;
    const y = this.position.y;
    const px = this.position.x, pz = this.position.z;
    const nx = px + dx, nz = pz + dz;
    if (this.isSwimming || (world?.getWalkHeight?.(nx, nz) ?? 0) - y < maxStep) {
      this.position.x = nx; this.position.z = nz; return;
    }
    if ((world?.getWalkHeight?.(nx, pz) ?? 0) - y < maxStep) { this.position.x = nx; this._velZ = 0; return; }
    if ((world?.getWalkHeight?.(px, nz) ?? 0) - y < maxStep) { this.position.z = nz; this._velX = 0; return; }
    this._velX = 0; this._velZ = 0;
  }

  update(dt) {
    const ctx = this.ctx;
    if (ctx.mode !== 'foot') return;

    if (this.animFreeze > 0) {
      this.animFreeze -= dt;
      return;
    }

    const input = ctx.input;
    const paused = ctx.time.paused;

    if (!this.alive) {
      this._deathT += dt;
      resetPose(this.rig.bones);
      animDeath(this.rig.bones, this._deathT * 1.4);
      return;
    }

    // --- camera orbit ---
    if (!paused) {
      const dragging = input.pointerLocked || input.mouse.pressed(0) || input.mouse.pressed(2);
      if (dragging && (input.mouse.dx || input.mouse.dy)) {
        const invert = ctx.state?.settings?.invertY ? -1 : 1;
        this._camYaw -= input.mouse.dx * 0.0034;
        this._camPitch = clamp(this._camPitch + input.mouse.dy * 0.0028 * invert, -0.6, 1.2);
      }
      if (input.mouse.wheel) {
        this._camDist = clamp(this._camDist * (1 + input.mouse.wheel * 0.14), 2.2, 9);
      }
      if (input.mouse.wasPressed(0) && !input.pointerLocked) {
        input.requestPointerLock(ctx.engine.canvas);
      }
    }

    // --- desired move (camera-relative) ---
    const axis = paused ? { x: 0, z: 0 } : input.moveAxis();
    _move.set(0, 0, 0);
    if (axis.z !== 0 || axis.x !== 0) {
      const fx = Math.sin(this._camYaw + Math.PI), fz = Math.cos(this._camYaw + Math.PI);
      const rx = Math.sin(this._camYaw + Math.PI / 2), rz = Math.cos(this._camYaw + Math.PI / 2);
      _move.x = fx * -axis.z + rx * -axis.x;
      _move.z = fz * -axis.z + rz * -axis.x;
      _move.normalize();
    }

    const sprint = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    const moving = _move.lengthSq() > 0.01;

    // --- environment sample (pre-move) ---
    const world = ctx.world;
    const ocean = ctx.ocean;
    const groundHere = world?.getWalkHeight?.(this.position.x, this.position.z) ?? 0;
    const waterHere = ocean?.getHeight(this.position.x, this.position.z) ?? -100;
    const inWater = waterHere - groundHere > 1.05 && this.position.y < waterHere + 0.4;
    this.isSwimming = inWater;

    let speed = this.isSwimming ? PLAYER.SWIM_SPEED
      : sprint && this.stamina > 1 ? PLAYER.RUN_SPEED : PLAYER.WALK_SPEED;
    speed *= this.sword.blocking ? 0.45 : 1;

    // stamina
    if (sprint && moving && !this.isSwimming) this.stamina -= 12 * dt;
    else if (this.isSwimming) this.stamina -= 4 * dt;
    else this.stamina += 16 * dt * (ctx.crew?.regenBonus?.() ?? 1);
    this.stamina = clamp(this.stamina, 0, PLAYER.STAMINA_MAX);
    if (this.stamina <= 0 && sprint) speed = PLAYER.WALK_SPEED;

    // dodge trigger
    if (!paused && input.wasPressed('Space') && moving && this.grounded && !this.isSwimming) {
      this.sword.startDodge(_move.x, _move.z);
    }

    // --- horizontal movement ---
    if (this.sword.dodging) {
      const dv = 10 * Math.max(0, 1 - this.sword.dodgeT / 0.42);
      this._tryMove(this.sword.dodgeDir.x * dv * dt, this.sword.dodgeDir.z * dv * dt, 0.65);
      this._velX = this.sword.dodgeDir.x * dv * 0.4;
      this._velZ = this.sword.dodgeDir.z * dv * 0.4;
    } else {
      const tvx = moving ? _move.x * speed : 0;
      const tvz = moving ? _move.z * speed : 0;
      // snappy to accelerate, a little glide on release = momentum
      const accel = this.isSwimming ? (moving ? 5 : 3.5) : (moving ? 15 : 9);
      this._velX = damp(this._velX, tvx, accel, dt);
      this._velZ = damp(this._velZ, tvz, accel, dt);
      const climbing = input.isDown('Space');
      this._tryMove(this._velX * dt, this._velZ * dt, climbing ? 1.6 : 0.65);
      const hs = Math.hypot(this._velX, this._velZ);
      if (hs > 0.6 && !this.sword.attacking && !this.sword.blocking) {
        this.facing = angleDamp(this.facing, Math.atan2(this._velX, this._velZ), 12, dt);
      }
    }
    // attacks / blocks face where the camera looks
    if (this.sword.attacking || this.sword.blocking) {
      this.facing = angleDamp(this.facing, this._camYaw + Math.PI, 14, dt);
    }

    // --- vertical ---
    const groundNow = world?.getWalkHeight?.(this.position.x, this.position.z) ?? 0;
    const waterNow = ocean?.getHeight(this.position.x, this.position.z) ?? -100;

    if (this.isSwimming) {
      const dive = input.isDown('KeyC');
      const targetY = dive
        ? Math.max(this.position.y - 2.4 * dt, groundNow + 0.6)
        : waterNow - 0.42 + Math.sin(ctx.time.t * 1.5) * 0.08;
      this.position.y = dive ? targetY : damp(this.position.y, targetY, 4, dt);
      this.velY = 0;
      this.grounded = false;
      this._landT = -1;
      this.underwater = this.position.y < waterNow - 1.1;
    } else {
      this.underwater = false;
      const wasGrounded = this.grounded;
      this._coyote = wasGrounded ? 0.1 : Math.max(0, this._coyote - dt);
      if (!paused && input.wasPressed('Space') && !moving) this._jumpBuf = 0.12;
      else this._jumpBuf = Math.max(0, this._jumpBuf - dt);
      if (this._jumpBuf > 0 && (wasGrounded || this._coyote > 0) && !this.sword.dodging) {
        this.velY = PLAYER.JUMP_SPEED;
        this.grounded = false;
        this._coyote = 0;
        this._jumpBuf = 0;
      }

      if (this.grounded) {
        const diff = groundNow - this.position.y;
        if (diff > 0.02) {
          this.position.y = damp(this.position.y, groundNow, 22, dt); // smooth step-up
        } else if (-diff <= 0.45) {
          this.position.y = damp(this.position.y, groundNow, 18, dt); // follow small drops
        } else {
          this.grounded = false; // walked off a ledge
        }
        this.velY = 0;
      } else {
        // variable-height jump: extra gravity while rising with Space released
        const rising = this.velY > 0;
        const g = 9.81 * 2.0 * (rising && !input.isDown('Space') ? 1.7 : 1);
        this.velY -= g * dt;
        this.position.y += this.velY * dt;
        if (this.position.y <= groundNow) {
          const impact = this.velY;
          this.position.y = groundNow;
          this.velY = 0;
          this.grounded = true;
          if (impact < -13) this.applyDamage((-impact - 13) * 3, this.facing);
          if (impact < -7) {
            this._landT = 0;
            if (impact < -11) ctx.events?.emit('shake', { amount: 0.16 });
          }
        }
      }
    }

    // hp regen out of combat
    if (this._hitT > 5) {
      this.hp = Math.min(this.hpMax, this.hp + 2.4 * dt * (ctx.crew?.regenBonus?.() ?? 1));
    }
    this._hitT += dt;
    if (this._landT >= 0) {
      this._landT += dt;
      if (this._landT > 0.32) this._landT = -1;
    }

    // --- animation ---
    const hspeed = Math.hypot(this._velX, this._velZ);
    const targetSpeed01 = (this.isSwimming || this.sword.dodging) ? 0 : clamp(hspeed / PLAYER.RUN_SPEED, 0, 1);
    this._speed01 = damp(this._speed01, targetSpeed01, 10, dt);
    if (hspeed > 0.4 && !this.isSwimming && !this.sword.dodging) {
      this._walkPhase += dt * (5.5 + this._speed01 * 5.5);
    }

    const b = this.rig.bones;
    resetPose(b);
    if (this.isSwimming) {
      animSwim(b, ctx.time.t);
    } else {
      animIdle(b, ctx.time.t);
      if (this._speed01 > 0.04) animWalk(b, this._walkPhase, this._speed01);
      if (this._landT >= 0) animLand(b, this._landT / 0.32);
      if (this.sword.dodging) {
        b.root.rotation.x = -this.sword.dodgeT / 0.45 * Math.PI * 2;
      }
    }
    if (this.sword.attacking) {
      animAttack(b, this.sword.attackT / this.sword.attackDur, this.sword.heavy);
    } else if (this.sword.blocking) {
      animBlock(b, 1);
    }
    if (this._hitT < 0.4) animHit(b, this._hitT / 0.4);
    this.rig.group.rotation.y = this.facing;

    // footstep events
    if (hspeed > 0.5 && this.grounded && !this.isSwimming) {
      this._stepAcc += dt * (1.4 + this._speed01 * 2.2);
      if (this._stepAcc > 1) {
        this._stepAcc = 0;
        const onDeck = groundNow > (world?.getTerrainHeight?.(this.position.x, this.position.z) ?? -100) + 0.3;
        ctx.events?.emit('footstep', { surface: onDeck ? 'wood' : 'sand' });
      }
    }

    this.sword.update(dt);
    this._updateCamera(dt);
  }

  _updateCamera(dt) {
    const ctx = this.ctx;
    const cam = ctx.camera;
    const pitch = this._camPitch;
    const dist = this._camDist;
    const ch = Math.cos(pitch);
    const headY = this.position.y + (this.isSwimming ? 1.15 : 1.5);
    _camTarget.set(this.position.x, headY, this.position.z);

    _camPos.set(
      this.position.x + Math.sin(this._camYaw) * ch * dist,
      headY + Math.sin(pitch) * dist,
      this.position.z + Math.cos(this._camYaw) * ch * dist,
    );

    // subtle collision: shorten the boom if it would pass through terrain
    _camDir.subVectors(_camPos, _camTarget);
    const boomLen = _camDir.length() || 1;
    _camDir.divideScalar(boomLen);
    let maxLen = boomLen;
    for (let i = 1; i <= 5; i++) {
      const d = boomLen * (i / 5);
      _camProbe.copy(_camTarget).addScaledVector(_camDir, d);
      const g = (ctx.world?.getWalkHeight?.(_camProbe.x, _camProbe.z) ?? -1e4) + 0.5;
      if (_camProbe.y < g) { maxLen = Math.max(1.5, d - 0.35); break; }
    }
    _camPos.copy(_camTarget).addScaledVector(_camDir, maxLen);

    // keep the camera out of the water
    if (!this.underwater) {
      const waterY = ctx.ocean?.getHeight(_camPos.x, _camPos.z) ?? -100;
      if (_camPos.y < waterY + 0.4) _camPos.y = waterY + 0.4;
    }

    const k = 1 - Math.exp(-dt * 12);
    cam.position.lerp(_camPos, k);
    cam.lookAt(_camTarget);

    // fov: gentle speed kick over the user's setting
    const baseFov = ctx.state?.settings?.fov ?? 60;
    const hspeed = Math.hypot(this._velX, this._velZ);
    const kick = this.isSwimming ? 0
      : clamp((hspeed - PLAYER.WALK_SPEED) / (PLAYER.RUN_SPEED - PLAYER.WALK_SPEED), 0, 1) * 6;
    const targetFov = baseFov + kick;
    if (Math.abs(cam.fov - targetFov) > 0.05) {
      cam.fov = lerp(cam.fov, targetFov, 1 - Math.exp(-dt * 6));
      cam.updateProjectionMatrix();
    }
  }
}
