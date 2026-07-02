// Treasure: maps with riddles, digging, wreck diving.
import * as THREE from 'three';
import { mulberry32, pick, randRange } from '../core/utils.js';

let _mapSeq = 0;
const _v = new THREE.Vector3();

const DIRECTIONS = [
  'a pistol-shot north of', 'two ship-lengths east of', 'in the shadow of',
  'a short walk west of', 'up the rise south of', 'where the gulls argue over',
];

export class Treasure {
  constructor(ctx) {
    this.ctx = ctx;
    this._digging = null; // {map, t}
    this._promptOn = false;
  }

  get maps() {
    return (this.ctx.state.data.maps ??= []);
  }

  grantRandomMap(source = 'tavern') {
    const ctx = this.ctx;
    const candidates = ctx.data.islands.filter((i) => !i.port);
    const island = candidates[Math.floor(Math.random() * candidates.length)];
    const rng = mulberry32(island.seed + this.maps.length * 101 + 5);

    // find a dry spot
    let x = island.position[0], z = island.position[1];
    for (let i = 0; i < 60; i++) {
      const tx = island.position[0] + randRange(rng, -0.7, 0.7) * island.radius;
      const tz = island.position[1] + randRange(rng, -0.7, 0.7) * island.radius;
      const h = ctx.world?.getTerrainHeight?.(tx, tz) ?? 0;
      if (h > 1.5 && h < 40) { x = tx; z = tz; break; }
    }
    const hint = pick(rng, island.loreHints ?? ['the old stories']);
    const riddle = `On ${island.name}: ${pick(rng, DIRECTIONS)} the place where "${hint.slice(0, 60)}…" — dig where the shadows cross.`;
    const map = {
      id: `map${++_mapSeq}:${Date.now() % 100000}`,
      islandId: island.id,
      x: Math.round(x), z: Math.round(z),
      riddle,
      found: false,
      source,
    };
    this.maps.push(map);
    ctx.events?.emit('toast', { text: `Treasure map acquired — ${island.name}`, kind: 'discover' });
    ctx.state.addLog(`Came by a map of ${island.name}. ${source === 'tavern' ? 'The barkeep swears it is true.' : ''}`);
    return map;
  }

  buyMap(portName, price = 90) {
    const ctx = this.ctx;
    if ((ctx.state.data.gold ?? 0) < price) return { ok: false, why: 'Not enough gold' };
    ctx.state.addGold(-price);
    const map = this.grantRandomMap('tavern');
    return { ok: true, map };
  }

  _dig(map) {
    const ctx = this.ctx;
    map.found = true;
    const gullhaven = ctx.data.islands.find((i) => i.id === 'gullhaven');
    const dist = Math.hypot(map.x - gullhaven.position[0], map.z - gullhaven.position[1]);
    let value = Math.round(150 + (dist / 8000) * 450 * (0.8 + Math.random() * 0.4));
    value = Math.round(value * (ctx.progression?.getMod?.('goldFind') ?? 1));
    ctx.state.addGold(value);

    const pos = ctx.character.position;
    ctx.effects?.sparks(pos, 14);
    ctx.events?.emit('treasure:dug', { value });
    ctx.events?.emit('toast', { text: `Treasure! ${value} sovereigns dug from the sand.`, kind: 'gold' });
    ctx.state.addLog(`Dug up an old hoard — ${value} sovereigns and a fistful of stories.`);

    // sometimes a relic, sometimes trouble
    if (Math.random() < 0.2) {
      const cargo = ctx.state.data.cargo;
      cargo.relics = (cargo.relics ?? 0) + 1;
      ctx.events?.emit('toast', { text: 'Among the coins: a Tide Relic.', kind: 'discover' });
    }
    if (Math.random() < 0.25 && ctx.npcs) {
      ctx.events?.emit('toast', { text: 'The dead do not care for shovels…', kind: 'warn' });
      for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
        _v.set(pos.x + randRange(Math.random, -8, 8), 0, pos.z + randRange(Math.random, -8, 8));
        _v.y = ctx.world?.getWalkHeight?.(_v.x, _v.z) ?? 0;
        ctx.npcs.spawnHostile(_v, 'drowned');
      }
    }
  }

  update(dt) {
    const ctx = this.ctx;
    if (ctx.mode !== 'foot' || !ctx.character?.alive || ctx.time.paused) {
      if (this._promptOn) {
        this._promptOn = false;
        ctx.events?.emit('prompt', { id: 'dig', text: null });
      }
      this._digging = null;
      return;
    }
    const pos = ctx.character.position;

    // dig spots
    let near = null;
    for (const map of this.maps) {
      if (map.found) continue;
      const island = ctx.data.islands.find((i) => i.id === map.islandId);
      if (!island) continue;
      if (Math.hypot(pos.x - map.x, pos.z - map.z) < 6) { near = map; break; }
    }

    if (near) {
      this._promptOn = true;
      if (ctx.input.isDown('KeyE')) {
        this._digging = this._digging?.map === near ? this._digging : { map: near, t: 0 };
        this._digging.t += dt;
        const pct = Math.min(100, Math.round((this._digging.t / 1.6) * 100));
        ctx.events?.emit('prompt', { id: 'dig', text: `Digging… ${pct}%` });
        if (this._digging.t >= 1.6) {
          this._digging = null;
          ctx.events?.emit('prompt', { id: 'dig', text: null });
          this._promptOn = false;
          this._dig(near);
        }
      } else {
        this._digging = null;
        ctx.events?.emit('prompt', { id: 'dig', text: 'Hold E — Dig here' });
      }
    } else if (this._promptOn) {
      this._promptOn = false;
      this._digging = null;
      ctx.events?.emit('prompt', { id: 'dig', text: null });
    }

    // wreck diving
    if (ctx.character.underwater) {
      for (const spot of ctx.world?.diveSpots ?? []) {
        if (spot.looted) continue;
        if (spot.position.distanceTo(pos) < 4) {
          spot.looted = true;
          const value = Math.round(randRange(Math.random, 180, 420));
          ctx.state.addGold(value);
          const cargo = ctx.state.data.cargo;
          cargo.pearls = (cargo.pearls ?? 0) + 1;
          ctx.events?.emit('treasure:dug', { value, dive: true });
          ctx.events?.emit('toast', { text: `Wreck salvage: ${value} sovereigns and pearls!`, kind: 'gold' });
          ctx.state.addLog('Went down to a dead ship and came up richer. The sea math works out.');
        }
      }
    }
  }
}
