// Third-person on-foot character: movement, swimming, camera, health.
import * as THREE from 'three';
import { PLAYER } from '../core/constants.js';
import { angleDamp, clamp, damp, lerp, wrapAngle } from '../core/utils.js';
import {
  animAttack, animBlock, animDeath, animHit, animIdle, animSwim, animWalk,
  buildHumanoid, resetPose,
} from './humanoid.js';
import { SwordCombat } from './sword.js';

const _camPos = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
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

    this._walkPhase = 0;
    this._camYaw = 0;
    this._camPitch = 0.18;
    this._camDist = 4.6;
    this._hitT = 2;
    this._deathT = -1;
    this._speed01 = 0;
    this._stepAcc = 0;

    this.sword = new SwordCombat(ctx, this);

    ctx.events?.on('mode:change', ({ mode }) => {
      this.rig.group.visible = mode === 'foot';
      if (mode === 'foot') {
        this._camYaw = this.facing + Math.PI;
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
    this.alive = true;
    this._deathT = -1;
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

    // --- movement (camera-relative) ---
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

    const world = ctx.world;
    const ocean = ctx.ocean;
    const ground = world?.getWalkHeight?.(this.position.x, this.position.z) ?? 0;
    const waterY = ocean?.getHeight(this.position.x, this.position.z) ?? -100;
    const inWater = waterY - ground > 1.05 && this.position.y < waterY + 0.4;
    this.isSwimming = inWater;

    let speed = this.isSwimming ? PLAYER.SWIM_SPEED
      : sprint && this.stamina > 1 ? PLAYER.RUN_SPEED : PLAYER.WALK_SPEED;
    speed *= this.sword.blocking ? 0.45 : 1;
    if (this.sword.dodging) speed = 0;

    // stamina
    if (sprint && moving && !this.isSwimming) this.stamina -= 12 * dt;
    else if (this.isSwimming) this.stamina -= 4 * dt;
    else this.stamina += 16 * dt * (ctx.crew?.regenBonus?.() ?? 1);
    this.stamina = clamp(this.stamina, 0, PLAYER.STAMINA_MAX);
    if (this.stamina <= 0 && sprint) speed = PLAYER.WALK_SPEED;

    // dodge roll
    if (!paused && input.wasPressed('Space') && moving && this.grounded && !this.isSwimming) {
      this.sword.startDodge(_move.x, _move.z);
    }
    if (this.sword.dodging) {
      this.position.x += this.sword.dodgeDir.x * 7.5 * dt;
      this.position.z += this.sword.dodgeDir.z * 7.5 * dt;
    } else if (moving && !paused) {
      const nx = this.position.x + _move.x * speed * dt;
      const nz = this.position.z + _move.z * speed * dt;
      const ng = world?.getWalkHeight?.(nx, nz) ?? 0;
      // blocked by walls/steep steps unless climbing (forward+jump held)
      const step = ng - this.position.y;
      const climbing = input.isDown('Space');
      if (this.isSwimming || step < 0.65 || (climbing && step < 1.6)) {
        this.position.x = nx;
        this.position.z = nz;
      }
      this.facing = angleDamp(this.facing, Math.atan2(_move.x, _move.z), 12, dt);
    }
    // attacks face the camera direction
    if (this.sword.attacking || this.sword.blocking) {
      this.facing = angleDamp(this.facing, this._camYaw + Math.PI, 14, dt);
    }

    // --- vertical ---
    if (this.isSwimming) {
      const dive = input.isDown('KeyC');
      const targetY = dive
        ? Math.max(this.position.y - 2.4 * dt, ground + 0.6)
        : waterY - 0.45 + Math.sin(ctx.time.t * 1.6) * 0.08;
      this.position.y = dive ? targetY : damp(this.position.y, targetY, 4, dt);
      this.velY = 0;
      this.grounded = false;
      this.underwater = this.position.y < waterY - 1.1;
    } else {
      this.underwater = false;
      if (!paused && input.wasPressed('Space') && this.grounded && !moving) {
        this.velY = PLAYER.JUMP_SPEED;
        this.grounded = false;
      }
      this.velY -= 9.81 * dt * 2.0;
      this.position.y += this.velY * dt;
      if (this.position.y <= ground) {
        if (this.velY < -13) {
          this.applyDamage((-this.velY - 13) * 3, this.facing);
        }
        this.position.y = ground;
        this.velY = 0;
        this.grounded = true;
      }
    }

    // hp regen out of combat
    if (this._hitT > 5) {
      this.hp = Math.min(this.hpMax, this.hp + 2.4 * dt * (ctx.crew?.regenBonus?.() ?? 1));
    }
    this._hitT += dt;

    // --- animation ---
    const targetSpeed01 = moving ? (sprint ? 1 : 0.55) : 0;
    this._speed01 = damp(this._speed01, targetSpeed01, 8, dt);
    if (moving) this._walkPhase += dt * (sprint ? 11 : 7.5);

    const b = this.rig.bones;
    resetPose(b);
    if (this.isSwimming) {
      animSwim(b, ctx.time.t);
    } else {
      animIdle(b, ctx.time.t);
      if (this._speed01 > 0.03) animWalk(b, this._walkPhase, this._speed01);
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
    if (moving && this.grounded && !this.isSwimming) {
      this._stepAcc += dt * (sprint ? 3.4 : 2.4);
      if (this._stepAcc > 1) {
        this._stepAcc = 0;
        const onDeck = ground > (world?.getTerrainHeight?.(this.position.x, this.position.z) ?? -100) + 0.3;
        ctx.events?.emit('footstep', { surface: onDeck ? 'wood' : 'sand' });
      }
    }

    this.sword.update(dt);
    this._updateCamera(dt);
  }

  _updateCamera(dt) {
    const cam = this.ctx.camera;
    const pitch = this._camPitch;
    const dist = this._camDist;
    const ch = Math.cos(pitch);
    const headY = this.position.y + 1.55;

    _camPos.set(
      this.position.x + Math.sin(this._camYaw) * ch * dist,
      headY + Math.sin(pitch) * dist,
      this.position.z + Math.cos(this._camYaw) * ch * dist,
    );
    // keep the camera out of the ground
    const camGround = (this.ctx.world?.getWalkHeight?.(_camPos.x, _camPos.z) ?? 0) + 0.35;
    if (_camPos.y < camGround) _camPos.y = camGround;
    if (!this.underwater) {
      const waterY = this.ctx.ocean?.getHeight(_camPos.x, _camPos.z) ?? -100;
      if (_camPos.y < waterY + 0.4) _camPos.y = waterY + 0.4;
    }

    const k = 1 - Math.exp(-dt * 11);
    cam.position.lerp(_camPos, k);
    _camTarget.set(this.position.x, headY, this.position.z);
    cam.lookAt(_camTarget);

    if (Math.abs(cam.fov - (this.ctx.state?.settings?.fov ?? 60)) > 0.5) {
      cam.fov = lerp(cam.fov, this.ctx.state?.settings?.fov ?? 60, 1 - Math.exp(-dt * 6));
      cam.updateProjectionMatrix();
    }
  }
}
