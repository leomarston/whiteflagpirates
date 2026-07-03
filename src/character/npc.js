// NPCs: port folk with roles, wandering civilians, guards, and hostiles.
import * as THREE from 'three';
import { angleDamp, clamp, randRange, wrapAngle } from '../core/utils.js';
import {
  animAttack, animBlock, animDeath, animHit, animIdle, animWalk,
  buildHumanoid, buildCutlass, resetPose,
} from './humanoid.js';

const _v = new THREE.Vector3();

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
  brigand: { coat: 0x4a3a2c, hat: 'bandana', hp: 45, dmg: [8, 13] },
  drowned: { coat: 0x37524e, hat: 'none', hp: 60, dmg: [10, 15], skin: 0x7c9488 },
  marine: { coat: 0x1e3a6e, hat: 'tricorne', hp: 55, dmg: [9, 14] },
};

class NPC {
  constructor(ctx, { role, name, pos, heading = 0, hostileKind = null, portName = null }) {
    this.ctx = ctx;
    this.role = role;
    this.name = name;
    this.portName = portName;
    this.hostileKind = hostileKind;
    const style = hostileKind ? HOSTILE_STYLE[hostileKind] : (ROLE_STYLE[role] ?? ROLE_STYLE.civilian);
    this.rig = buildHumanoid({
      palette: { coat: style.coat, skin: style.skin ?? 0xc9976b },
      hat: style.hat,
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
    this._walkPhase = Math.random() * 6;
    this._speed01 = 0;
    this._attackT = -1;
    this._struck = false;
    this._hitT = 9;
    this._deathT = -1;
    this._wander = pos.clone();
    this._wanderWait = randRange(Math.random, 1, 5);
    this._sayCooldown = randRange(Math.random, 4, 14);
    this.home = pos.clone();
    this.dmg = style.dmg ?? [7, 11];
  }

  applyDamage(n, fromDir) {
    if (!this.alive) return;
    // small block chance for armed foes
    if (this.hostile && this._attackT < 0 && Math.random() < 0.2) {
      n *= 0.4;
      this.ctx.effects?.sparks(this.position, 5);
    }
    this.hp -= n;
    this._hitT = 0;
    if (!this.hostile && this.role !== 'guard') {
      // civilians scatter
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
    }
  }

  stagger() {
    this.staggered = 1.25;
    this._attackT = -1;
  }

  update(dt) {
    const ctx = this.ctx;
    const b = this.rig.bones;

    if (!this.alive) {
      this._deathT += dt;
      resetPose(b);
      animDeath(b, this._deathT * 1.5);
      const fade = clamp(1 - (this._deathT - 3) / 3, 0, 1);
      this.rig.group.traverse((o) => {
        if (o.material?.transparent !== undefined && this._deathT > 3) {
          o.material.transparent = true;
          o.material.opacity = fade;
        }
      });
      return this._deathT > 6; // true = remove
    }

    const player = ctx.character;
    const pDist = player?.alive && ctx.mode === 'foot'
      ? this.position.distanceTo(player.position) : Infinity;

    // LOD: skip logic when far
    if (pDist > 120) return false;

    let moving = false;
    let speed = 1.6;

    if (this.staggered > 0) {
      this.staggered -= dt;
    } else if (this.hostile && this.state !== 'flee') {
      if (pDist < 22) this.state = 'combat';
      if (this.state === 'combat' && player?.alive) {
        const toPlayer = Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z);
        this.facing = angleDamp(this.facing, toPlayer, 8, dt);
        if (this._attackT >= 0) {
          this._attackT += dt;
          if (!this._struck && this._attackT > 0.5) {
            this._struck = true;
            if (pDist < 2.5) {
              const result = player.applyDamage(randRange(Math.random, this.dmg[0], this.dmg[1]), toPlayer);
              if (result === 'parried') this.stagger();
            }
          }
          if (this._attackT > 0.9) this._attackT = -1;
        } else if (pDist > 2.1) {
          moving = true;
          speed = 2.8;
          this.position.x += Math.sin(toPlayer) * speed * dt;
          this.position.z += Math.cos(toPlayer) * speed * dt;
        } else if (Math.random() < dt * 0.9) {
          this._attackT = 0;
          this._struck = false;
        } else {
          // strafe around the player
          const strafe = toPlayer + Math.PI / 2;
          moving = true;
          speed = 1.2;
          this.position.x += Math.sin(strafe) * speed * dt * 0.6;
          this.position.z += Math.cos(strafe) * speed * dt * 0.6;
        }
      }
    } else if (this.state === 'flee' && player) {
      const away = Math.atan2(this.position.x - player.position.x, this.position.z - player.position.z);
      this.facing = angleDamp(this.facing, away, 8, dt);
      moving = true;
      speed = 3.2;
      this.position.x += Math.sin(away) * speed * dt;
      this.position.z += Math.cos(away) * speed * dt;
      if (pDist > 40) this.state = 'idle';
    } else if (this.role === 'civilian' || this.role === 'dockworker' || this.role === 'guard') {
      // wander near home
      this._wanderWait -= dt;
      const d = Math.hypot(this._wander.x - this.position.x, this._wander.z - this.position.z);
      if (d > 1.2) {
        const to = Math.atan2(this._wander.x - this.position.x, this._wander.z - this.position.z);
        this.facing = angleDamp(this.facing, to, 6, dt);
        moving = true;
        speed = this.role === 'guard' ? 1.3 : 1.0;
        this.position.x += Math.sin(this.facing) * speed * dt;
        this.position.z += Math.cos(this.facing) * speed * dt;
      } else if (this._wanderWait <= 0) {
        this._wanderWait = randRange(Math.random, 3, 9);
        const range = this.role === 'guard' ? 28 : 14;
        this._wander.set(
          this.home.x + randRange(Math.random, -range, range), 0,
          this.home.z + randRange(Math.random, -range, range),
        );
      }
      // idle chatter
      this._sayCooldown -= dt;
      if (this.role === 'civilian' && pDist < 6 && this._sayCooldown <= 0) {
        this._sayCooldown = randRange(Math.random, 18, 40);
        const lines = this.ctx.data?.lore?.rumors ?? [];
        if (lines.length) {
          this.ctx.events?.emit('npc:say', {
            npc: this, text: lines[Math.floor(Math.random() * lines.length)],
          });
        }
      }
    } else if (pDist < 5) {
      // role NPCs face the approaching player
      const toPlayer = Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z);
      this.facing = angleDamp(this.facing, toPlayer, 5, dt);
    }

    // stick to the ground
    const ground = ctx.world?.getWalkHeight?.(this.position.x, this.position.z) ?? 0;
    this.position.y = ground;

    // animate (skip when far)
    if (pDist < 70) {
      this._speed01 = clamp(this._speed01 + ((moving ? speed / 3 : 0) - this._speed01) * dt * 8, 0, 1);
      if (moving) this._walkPhase += dt * (4 + speed * 1.6);
      resetPose(b);
      animIdle(b, ctx.time.t + this._walkPhase);
      if (this._speed01 > 0.03) animWalk(b, this._walkPhase, this._speed01);
      if (this._attackT >= 0) animAttack(b, this._attackT / 0.9, false);
      if (this.staggered > 0) animHit(b, 1 - this.staggered / 1.25);
      else if (this._hitT < 0.4) animHit(b, this._hitT / 0.4);
      this.rig.group.rotation.y = this.facing;
    }
    this._hitT += dt;
    return false;
  }

  dispose() {
    this.ctx.scene.remove(this.rig.group);
  }
}

export class NPCManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.npcs = [];
    this.hostiles = [];
    this._populatedPort = null;
    this._promptShown = false;

    ctx.events?.on('guards:aggro', () => {
      for (const npc of this.npcs) {
        if (npc.role === 'guard' && npc.alive) {
          npc.hostile = true;
          npc.hostileKind = 'marine';
          npc.state = 'combat';
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
      if (['tavernkeep', 'shipwright', 'merchant', 'questgiver'].includes(npc.role)) {
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

  _populate(island) {
    const port = island.port;
    if (!port) return;
    this._populatedPort = port;
    const names = this.ctx.data?.names;
    const rng = Math.random;

    const roleFor = { tavern: 'tavernkeep', shipwright: 'shipwright', market: 'merchant', questboard: 'questgiver' };
    for (const b of port.buildings) {
      const role = roleFor[b.kind];
      if (!role || !b.doorPosition) continue;
      this.npcs.push(new NPC(this.ctx, {
        role, name: names?.npcName?.(rng) ?? 'Keeper',
        pos: b.doorPosition.clone(), portName: port.name,
        heading: Math.atan2(port.position.x - b.doorPosition.x, port.position.z - b.doorPosition.z),
      }));
    }
    const civs = port.size === 'capital' ? 7 : port.size === 'village' ? 4 : 5;
    for (let i = 0; i < civs; i++) {
      const pos = port.position.clone();
      pos.x += randRange(rng, -18, 18);
      pos.z += randRange(rng, -18, 18);
      this.npcs.push(new NPC(this.ctx, {
        role: i === 0 ? 'dockworker' : 'civilian',
        name: names?.npcName?.(rng) ?? 'Deckhand',
        pos, portName: port.name,
      }));
    }
    if (port.faction === 'crown') {
      for (let i = 0; i < (port.size === 'capital' ? 4 : 2); i++) {
        const pos = port.position.clone();
        pos.x += randRange(rng, -24, 24);
        pos.z += randRange(rng, -24, 24);
        const guard = new NPC(this.ctx, {
          role: 'guard', name: names?.npcName?.(rng) ?? 'Marine',
          pos, portName: port.name,
        });
        this.npcs.push(guard);
        // hostile crown ports if the player is deeply wanted
        if ((this.ctx.state?.data?.reputation?.crown ?? 0) < -40) {
          guard.hostile = true;
          guard.hostileKind = 'marine';
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

    // interaction prompt + E handling (foot mode)
    if (ctx.mode === 'foot' && ctx.character?.alive && !ctx.time.paused) {
      let best = null, bestD = 2.6;
      for (const it of this.interactables) {
        const d = it.position.distanceTo(ctx.character.position);
        if (d < bestD) { bestD = d; best = it; }
      }
      if (best) {
        this._promptShown = true;
        ctx.events?.emit('prompt', { id: 'npc', text: `E — ${best.label}` });
        if (ctx.input.wasPressed('KeyE')) {
          if (['tavernkeep', 'shipwright', 'merchant', 'questgiver'].includes(best.npc.role)) {
            ctx.events?.emit('npc:interact', { npc: best.npc });
          } else {
            const lines = ctx.data?.lore?.rumors ?? ['Fair winds, stranger.'];
            ctx.events?.emit('npc:say', {
              npc: best.npc, text: lines[Math.floor(Math.random() * lines.length)],
            });
          }
        }
      } else if (this._promptShown) {
        this._promptShown = false;
        ctx.events?.emit('prompt', { id: 'npc', text: null });
      }
    } else if (this._promptShown) {
      // left foot mode (or paused) with a prompt still up — clear it
      this._promptShown = false;
      ctx.events?.emit('prompt', { id: 'npc', text: null });
    }
  }
}
