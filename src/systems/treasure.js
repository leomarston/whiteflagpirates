// Treasure: maps with riddles, digging, wreck diving.
import * as THREE from 'three';
import { mulberry32, pick, randRange } from '../core/utils.js';

let _mapSeq = 0;
const _v = new THREE.Vector3();

const DIRECTIONS = [
  'a pistol-shot north of', 'two ship-lengths east of', 'in the shadow of',
  'a short walk west of', 'up the rise south of', 'where the gulls argue over',
];

// -- diving breath / drowning tuning ----------------------------------------
const BREATH_MAX = 18;      // seconds of air on a full breath
const BREATH_REFILL = 4;    // seconds to refill fully at the surface
const DROWN_TICK = 1.0;     // seconds between drowning-damage ticks
const DROWN_DMG = 6;        // hp lost per drowning tick
const BREATH_RISE = 2.8;    // m/s the out-of-air diver is nudged back upward
const BREATH_LOW = 0.3;     // ratio at which the lungs-burning warning fires

// -- buried-treasure "pace it out" tuning -----------------------------------
const SENSE_RADIUS = 48;    // warmer/colder guidance begins on the right island
const REVEAL_RADIUS = 24;   // the search-zone ring becomes visible this close
const DIG_RADIUS = 6;       // digging can be performed inside this

export class Treasure {
  constructor(ctx) {
    this.ctx = ctx;
    this._digging = null; // {map, t}
    this._promptOn = false;

    // ---- diving breath meter ----------------------------------------------
    this._breath = 1;          // 0..1 remaining air
    this._drownT = 0;          // accumulator between drowning ticks
    this._drownLatched = false; // one "out of air" toast per drowning episode
    this._breathLowLatched = false; // one "lungs burning" toast per dive
    this._breathEl = null;
    this._breathFill = null;
    this._breathVisible = false;
    this._buildBreathUI();

    // ---- treasure map-reading: warmer/colder sense + a search-zone ring
    //      that only reveals when the diver/walker paces into the area -------
    this._senseMap = null;
    this._senseLastDist = Infinity;
    this._senseTrend = 0;      // +1 warmer, -1 colder, 0 undecided
    this._senseSampleT = 0;
    this._ring = null;
    this._buildSearchRing();
  }

  // A flat, pulsing ground ring built once and parked off-scene; it only becomes
  // visible when the player is close, so it marks a search AREA rather than a
  // permanent pin on the exact dig coordinate.
  _buildSearchRing() {
    const ctx = this.ctx;
    if (!ctx?.scene) return;
    const geo = new THREE.RingGeometry(3.4, 5.2, 40);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xe6c15a, transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.frustumCulled = false;
    ring.renderOrder = 3;
    ring.visible = false;
    ctx.scene.add(ring);
    this._ring = ring;
  }

  // Self-contained breath overlay (scoped <style> + a body-level bar). Shown
  // only while underwater. Mirrors how other systems inject their own DOM
  // instead of editing the shared HUD.
  _buildBreathUI() {
    if (typeof document === 'undefined') return;
    if (!document.getElementById('wf-breath-style')) {
      const st = document.createElement('style');
      st.id = 'wf-breath-style';
      st.textContent = `
        #wf-breath{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);
          width:212px;padding:6px 10px 7px;pointer-events:none;z-index:6;
          background:linear-gradient(180deg,rgba(8,20,30,0.68),rgba(4,10,16,0.8));
          border:1px solid rgba(120,190,220,0.34);border-radius:8px;
          font-family:Georgia,serif;text-align:center;
          box-shadow:0 3px 14px rgba(0,0,0,0.4);
          transition:opacity .25s ease;opacity:1;}
        #wf-breath.hidden{opacity:0;display:none;}
        #wf-breath .wf-breath-lbl{font-size:10px;letter-spacing:2px;
          text-transform:uppercase;color:#bfe2f2;opacity:.85;margin-bottom:4px;}
        #wf-breath .wf-breath-bar{position:relative;height:8px;border-radius:4px;
          background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.08);
          overflow:hidden;}
        #wf-breath .wf-breath-bar i{display:block;height:100%;width:100%;
          border-radius:3px;background:linear-gradient(90deg,#3fb6e6,#8fe0ff);
          transition:width .12s linear,background .2s ease;}
        #wf-breath.low .wf-breath-bar i{background:linear-gradient(90deg,#e6a83f,#f0d060);}
        #wf-breath.low{border-color:rgba(230,168,63,0.5);
          animation:wf-breath-pulse 1s ease-in-out infinite;}
        #wf-breath.empty .wf-breath-bar i{background:linear-gradient(90deg,#c0342a,#e06050);}
        #wf-breath.empty{border-color:rgba(224,80,60,0.65);
          animation:wf-breath-pulse .5s ease-in-out infinite;}
        @keyframes wf-breath-pulse{0%,100%{box-shadow:0 3px 14px rgba(0,0,0,0.4);}
          50%{box-shadow:0 0 16px rgba(224,120,60,0.55);}}
      `;
      document.head.appendChild(st);
    }
    const el = document.createElement('div');
    el.id = 'wf-breath';
    el.className = 'hidden';
    el.innerHTML = '<div class="wf-breath-lbl">Breath</div>' +
      '<div class="wf-breath-bar"><i></i></div>';
    (document.body ?? document.documentElement).appendChild(el);
    this._breathEl = el;
    this._breathFill = el.querySelector('.wf-breath-bar i');
  }

  _renderBreath(show, ratio) {
    const el = this._breathEl, fill = this._breathFill;
    if (!el || !fill) return;
    if (show !== this._breathVisible) {
      this._breathVisible = show;
      el.classList.toggle('hidden', !show);
    }
    if (!show) return;
    const pct = Math.max(0, Math.min(1, ratio));
    fill.style.width = (pct * 100).toFixed(1) + '%';
    el.classList.toggle('low', pct > 0 && pct <= BREATH_LOW);
    el.classList.toggle('empty', pct <= 0);
  }

  // Drain air while underwater; refill (faster) at the surface. Out of air →
  // drowning damage + a gentle upward nudge toward the surface.
  _updateBreath(dt) {
    const ctx = this.ctx;
    const ch = ctx.character;
    const diving = ctx.mode === 'foot' && !!ch?.alive && !!ch.underwater && !ctx.time?.paused;
    if (diving) {
      this._breath = Math.max(0, this._breath - dt / BREATH_MAX);
      if (this._breath <= 0) {
        if (ch.position) ch.position.y += BREATH_RISE * dt; // nudge toward air
        if (!this._drownLatched) {
          this._drownLatched = true;
          ctx.events?.emit('toast', { text: 'Out of air — surface now or drown!', kind: 'warn' });
        }
        this._drownT += dt;
        if (this._drownT >= DROWN_TICK) {
          this._drownT -= DROWN_TICK;
          ch.applyDamage?.(DROWN_DMG, ch.facing ?? 0);
          ctx.events?.emit('shake', { amount: 0.16 });
        }
      } else {
        this._drownT = 0;
        if (!this._breathLowLatched && this._breath <= BREATH_LOW) {
          this._breathLowLatched = true;
          ctx.events?.emit('toast', { text: 'Lungs burning — head for the surface!', kind: 'warn' });
        }
      }
    } else {
      this._breath = Math.min(1, this._breath + dt / BREATH_REFILL);
      this._drownT = 0;
      this._drownLatched = false;
      if (this._breath > 0.55) this._breathLowLatched = false;
    }
    this._renderBreath(diving, this._breath);
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

  // Clear all dig guidance (prompt line + search ring) in one place.
  _clearDigGuidance() {
    if (this._promptOn) {
      this._promptOn = false;
      this.ctx.events?.emit('prompt', { id: 'dig', text: null });
    }
    this._digging = null;
    this._senseMap = null;
    if (this._ring) this._ring.visible = false;
  }

  update(dt) {
    const ctx = this.ctx;
    this._updateBreath(dt);
    if (ctx.mode !== 'foot' || !ctx.character?.alive || ctx.time.paused) {
      this._clearDigGuidance();
      return;
    }
    const pos = ctx.character.position;

    // buried-treasure map reading (warmer/colder + reveal-on-approach)
    this._updateMapReading(dt, pos);

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

  // Turn buried treasure from a GPS ping into a "pace it out" hunt: the exact
  // dig spot stays internal, but guidance only appears when the player is on the
  // mapped island, warmer/colder near the mark, and a visible search circle only
  // once they are close. Digging (and its payout) is unchanged inside DIG_RADIUS.
  _updateMapReading(dt, pos) {
    const ctx = this.ctx;

    // nearest un-found map whose island the player is actually standing on
    let sensed = null, sensedDist = Infinity;
    for (const map of this.maps) {
      if (map.found) continue;
      const isl = ctx.data.islands.find((i) => i.id === map.islandId);
      if (!isl) continue;
      const toCenter = Math.hypot(pos.x - isl.position[0], pos.z - isl.position[1]);
      if (toCenter > isl.radius * 1.15) continue; // not on this island → no sense
      const d = Math.hypot(pos.x - map.x, pos.z - map.z);
      if (d < sensedDist) { sensedDist = d; sensed = map; }
    }

    if (!sensed || sensedDist > SENSE_RADIUS) {
      this._clearDigGuidance();
      return;
    }

    // warmer/colder trend, sampled a few times a second
    if (this._senseMap !== sensed) {
      this._senseMap = sensed;
      this._senseLastDist = sensedDist;
      this._senseTrend = 0;
      this._senseSampleT = 0;
    }
    this._senseSampleT -= dt;
    if (this._senseSampleT <= 0) {
      this._senseSampleT = 0.35;
      const delta = this._senseLastDist - sensedDist;
      if (Math.abs(delta) > 0.15) this._senseTrend = delta > 0 ? 1 : -1;
      this._senseLastDist = sensedDist;
    }

    // search-zone ring: only revealed once the player has paced into the area
    if (this._ring) {
      const reveal = sensedDist < REVEAL_RADIUS;
      this._ring.visible = reveal;
      if (reveal) {
        const gy = ctx.world?.getWalkHeight?.(sensed.x, sensed.z) ?? 0;
        this._ring.position.set(sensed.x, gy + 0.06, sensed.z);
        this._ring.material.opacity = 0.34 + Math.sin(ctx.time.t * 3) * 0.16;
      }
    }

    // inside the tight zone → the real dig (unchanged mechanic + payout)
    if (sensedDist < DIG_RADIUS) {
      this._promptOn = true;
      if (ctx.input.isDown('KeyE')) {
        this._digging = this._digging?.map === sensed ? this._digging : { map: sensed, t: 0 };
        this._digging.t += dt;
        const pct = Math.min(100, Math.round((this._digging.t / 1.6) * 100));
        ctx.events?.emit('prompt', { id: 'dig', text: `Digging… ${pct}%` });
        if (this._digging.t >= 1.6) {
          this._digging = null;
          ctx.events?.emit('prompt', { id: 'dig', text: null });
          this._promptOn = false;
          if (this._ring) this._ring.visible = false;
          this._dig(sensed);
        }
      } else {
        this._digging = null;
        ctx.events?.emit('prompt', { id: 'dig', text: 'Hold E — Dig here' });
      }
      return;
    }

    // within the search area but not yet on the mark → riddle guidance only
    this._digging = null;
    this._promptOn = true;
    let text;
    if (sensedDist < REVEAL_RADIUS) {
      text = 'The riddle fits this ground — search the marked circle.';
    } else {
      text = this._senseTrend > 0 ? 'The map warms — the mark draws near…'
        : this._senseTrend < 0 ? 'The trail cools — you have strayed.'
          : 'The old map itches — the buried mark is close.';
    }
    ctx.events?.emit('prompt', { id: 'dig', text });
  }
}
