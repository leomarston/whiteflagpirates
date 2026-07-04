// HUD: compass ribbon, ship instruments, foot vitals, gold, prompts, reticle.
import { Vector3 } from 'three';
import { clamp01, wrapAngle } from '../core/utils.js';

const _dir = new Vector3();
// scratch reused for world→screen projection of nav beacons (alloc ONCE)
const _proj = new Vector3();
const _rel = new Vector3();
const _camDir = new Vector3();
const _objPos = new Vector3();

const AMMO_NAMES = { round: 'ROUND SHOT', chain: 'CHAIN SHOT', grape: 'GRAPE SHOT' };

// faction accent colours (target panel tint + port beacon dots)
const FACTION_COLORS = {
  corsairs: '#e6ddc4',
  crown: '#c96a5a',
  concern: '#d08a3c',
  tidebound: '#5fb0a4',
  pirate: '#c9a24b',
};

const BEACON_POOL = 12;    // hard cap on simultaneous markers
const PORT_BEACON_RANGE = 3000; // m

const CARDINALS = [[0, 'N'], [Math.PI / 2, 'E'], [Math.PI, 'S'], [-Math.PI / 2, 'W']];
const INTERCARDINALS = [
  [Math.PI / 4, 'NE'], [3 * Math.PI / 4, 'SE'],
  [-3 * Math.PI / 4, 'SW'], [-Math.PI / 4, 'NW'],
];

export class HUD {
  constructor(ctx, ui) {
    this.ctx = ctx;
    this.ui = ui;
    const root = ui.root;

    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div id="compass-wrap"><canvas id="compass"></canvas></div>
      <div id="objective"></div>
      <div id="toasts"></div>
      <div id="ship-panel" class="hidden">
        <div id="speed-knots"><span class="v">0.0</span><small>KNOTS</small></div>
        <div class="gauge-row"><span class="lbl">Sail</span><div class="bar sail"><i></i></div></div>
        <div class="gauge-row"><span class="lbl">Hull</span><div class="bar hull"><i></i></div></div>
        <div class="reload-pips">
          <div class="side">PORT <span class="pip"><i class="pl"></i></span></div>
          <div class="side">STAR <span class="pip"><i class="pr"></i></span></div>
        </div>
        <div id="anchor-ind" class="hidden">⚓ ANCHORED</div>
      </div>
      <div id="foot-panel" class="hidden">
        <div class="gauge-row"><span class="lbl">Vigor</span><div class="bar hp"><i></i></div></div>
        <div class="gauge-row"><span class="lbl">Wind</span><div class="bar stam"><i></i></div></div>
        <div class="gauge-row"><span class="lbl">Pistol</span><div class="bar sail"><i class="pistol"></i></div></div>
      </div>
      <div id="status-panel">
        <div id="gold-readout">0 s</div>
        <div id="day-readout">Day 1 · morning</div>
      </div>
      <div id="prompt"></div>
      <div id="saybubble" style="opacity:0"></div>
      <div id="reticle" class="hidden">
        <div class="ring"></div>
        <div class="rbar"><i></i></div>
        <div class="ammo">ROUND SHOT</div>
      </div>
      <div id="vignette"></div>
      <div id="lowhull"></div>
    `;
    root.appendChild(this.el);

    // element refs (cached to avoid per-frame querySelector churn)
    this.compass = this.el.querySelector('#compass');
    this.toasts = this.el.querySelector('#toasts');
    this.promptEl = this.el.querySelector('#prompt');
    this.sayEl = this.el.querySelector('#saybubble');
    this.objective = this.el.querySelector('#objective');
    this.shipPanel = this.el.querySelector('#ship-panel');
    this.footPanel = this.el.querySelector('#foot-panel');
    this.reticle = this.el.querySelector('#reticle');
    this.vignette = this.el.querySelector('#vignette');
    this.lowhull = this.el.querySelector('#lowhull');
    this.speedV = this.el.querySelector('#speed-knots .v');
    this.sailFill = this.el.querySelector('.bar.sail i');
    this.hullBar = this.el.querySelector('.bar.hull');
    this.hullFill = this.el.querySelector('.bar.hull i');
    const pips = this.el.querySelectorAll('.reload-pips .pip');
    this.plPip = pips[0];
    this.prPip = pips[1];
    this.plFill = this.el.querySelector('.pl');
    this.prFill = this.el.querySelector('.pr');
    this.anchorInd = this.el.querySelector('#anchor-ind');
    this.hpFill = this.el.querySelector('.bar.hp i');
    this.stamFill = this.el.querySelector('.bar.stam i');
    this.pistolFill = this.el.querySelector('.pistol');
    this.goldEl = this.el.querySelector('#gold-readout');
    this.dayEl = this.el.querySelector('#day-readout');
    this.ammoEl = this.reticle.querySelector('.ammo');
    this.rbarFill = this.reticle.querySelector('.rbar i');

    // DPR-crisp compass canvas
    this._cw = 700;
    this._ch = 56;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.compass.width = this._cw * dpr;
    this.compass.height = this._ch * dpr;
    this.compass.style.width = this._cw + 'px';
    this.compass.style.height = this._ch + 'px';
    this.cctx = this.compass.getContext('2d');
    this.cctx.scale(dpr, dpr);
    // cache the ribbon gradient once (constant geometry — no per-frame alloc)
    const rg = this.cctx.createLinearGradient(0, 14, 0, 44);
    rg.addColorStop(0, 'rgba(12,22,32,0.58)');
    rg.addColorStop(0.5, 'rgba(9,17,25,0.82)');
    rg.addColorStop(1, 'rgba(5,11,17,0.7)');
    this._ribbonGrad = rg;

    this._cache = {};
    this._aim = { side: null };
    this._vignetteT = 0;
    this._hullHit = false;
    this._pulse = 0;

    ctx.events?.on('aim:update', (a) => { this._aim = a; });
    ctx.events?.on('player:hurt', () => { this._vignetteT = 1; });
    ctx.events?.on('ship:hit', ({ onPlayer }) => { if (onPlayer) { this._vignetteT = 0.7; this._hullHit = true; } });
    ctx.events?.on('gold:change', () => {
      this.goldEl.classList.remove('flash');
      void this.goldEl.offsetWidth;
      this.goldEl.classList.add('flash');
    });

    this._buildWave3();
  }

  // Feature C: enemy target panel + world-space nav beacons. Styles are injected
  // from JS (a single <style id="hud-wave3-style">) so this stays to one file and
  // never touches styles.css.
  _buildWave3() {
    if (!document.getElementById('hud-wave3-style')) {
      const st = document.createElement('style');
      st.id = 'hud-wave3-style';
      st.textContent = `
        #target-panel{position:absolute;left:50%;top:82px;transform:translateX(-50%);
          min-width:210px;max-width:320px;padding:7px 12px 8px;
          background:linear-gradient(180deg,rgba(12,22,32,0.72),rgba(6,12,18,0.82));
          border:1px solid rgba(208,169,79,0.34);border-radius:8px;
          font-family:Georgia,serif;color:#e8dcc0;text-align:center;
          box-shadow:0 3px 14px rgba(0,0,0,0.4);pointer-events:none;
          transition:opacity .18s ease;opacity:1;}
        #target-panel.hidden{opacity:0;display:none;}
        #target-panel .tp-head{display:flex;align-items:baseline;justify-content:center;
          gap:8px;line-height:1.1;}
        #target-panel .tp-name{font-size:15px;font-weight:600;letter-spacing:.4px;
          color:#f0e6cc;text-shadow:0 1px 2px rgba(0,0,0,.6);}
        #target-panel .tp-faction{font-size:10px;letter-spacing:1.4px;text-transform:uppercase;
          opacity:.9;}
        #target-panel .tp-hullbar{position:relative;height:7px;margin:6px 0 5px;border-radius:4px;
          background:rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.08);overflow:hidden;}
        #target-panel .tp-hullbar i{display:block;height:100%;width:100%;border-radius:3px;
          background:hsl(120,70%,45%);transition:width .18s ease,background .18s ease;}
        #target-panel .tp-stats{display:flex;justify-content:center;gap:16px;font-size:12px;
          color:#c9b98f;letter-spacing:.5px;}
        #target-panel .tp-board{margin-top:5px;font-size:11px;font-weight:600;letter-spacing:1px;
          color:#f0c869;text-shadow:0 0 8px rgba(240,200,105,.55);
          animation:tp-board-pulse 1.1s ease-in-out infinite;}
        #target-panel .tp-board.hidden{display:none;}
        @keyframes tp-board-pulse{0%,100%{opacity:.55;}50%{opacity:1;}}
        #beacon-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;
          z-index:2;}
        #beacon-layer .beacon-marker{position:absolute;left:0;top:0;display:none;
          transform:translate(-50%,-50%);white-space:nowrap;
          font-family:Georgia,serif;text-align:center;will-change:left,top,transform,opacity;}
        #beacon-layer .bm-dot{display:inline-block;font-size:14px;line-height:1;
          filter:drop-shadow(0 0 4px rgba(0,0,0,.7));}
        #beacon-layer .bm-label{display:block;margin-top:1px;font-size:10px;letter-spacing:.6px;
          color:#e8dcc0;text-shadow:0 1px 3px rgba(0,0,0,.85);}
        #beacon-layer .bm-arrow{display:none;font-size:11px;line-height:1;color:inherit;
          filter:drop-shadow(0 0 4px rgba(0,0,0,.7));}
        #beacon-layer .beacon-marker.edge .bm-arrow{display:inline-block;}
        #beacon-layer .beacon-marker.edge .bm-label{display:none;}
        #beacon-layer .beacon-marker.objective .bm-dot{color:#eccb6c;
          filter:drop-shadow(0 0 6px rgba(236,203,108,.75));}
        #beacon-layer .beacon-marker.objective .bm-label{color:#f0dfa0;font-weight:600;}
      `;
      document.head.appendChild(st);
    }

    // target panel (top-centre, under the compass)
    const tp = document.createElement('div');
    tp.id = 'target-panel';
    tp.className = 'hidden';
    tp.innerHTML = `
      <div class="tp-head"><span class="tp-name"></span><span class="tp-faction"></span></div>
      <div class="tp-hullbar"><i></i></div>
      <div class="tp-stats"><span class="tp-crew"></span><span class="tp-dist"></span></div>
      <div class="tp-board hidden">◈ BOARDABLE — close in</div>
    `;
    this.el.appendChild(tp);
    this.targetPanel = tp;
    this.tpName = tp.querySelector('.tp-name');
    this.tpFaction = tp.querySelector('.tp-faction');
    this.tpHullFill = tp.querySelector('.tp-hullbar i');
    this.tpCrew = tp.querySelector('.tp-crew');
    this.tpDist = tp.querySelector('.tp-dist');
    this.tpBoard = tp.querySelector('.tp-board');

    // nav-beacon layer + a reused pool of marker elements (never created per-frame)
    const layer = document.createElement('div');
    layer.id = 'beacon-layer';
    this.el.appendChild(layer);
    this.beaconLayer = layer;
    this._beacons = [];
    this._objLabel = 'Objective';
    for (let i = 0; i < BEACON_POOL; i++) {
      const m = document.createElement('div');
      m.className = 'beacon-marker';
      m.innerHTML = '<span class="bm-arrow">▲</span><span class="bm-dot">◈</span><span class="bm-label"></span>';
      layer.appendChild(m);
      this._beacons.push({
        el: m,
        arrow: m.querySelector('.bm-arrow'),
        dot: m.querySelector('.bm-dot'),
        label: m.querySelector('.bm-label'),
        _x: -1, _y: -1, _s: -1, _op: -1, _rot: null,
        _text: null, _kind: null, _edge: null, _color: null, _vis: false,
      });
    }
  }

  _set(key, el, value) {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    if (el) el.textContent = value;
  }

  _setBar(key, target, frac) {
    const v = Math.round(clamp01(frac) * 100);
    if (this._cache[key] === v) return;
    this._cache[key] = v;
    const el = typeof target === 'string' ? this.el.querySelector(target) : target;
    if (el) el.style.width = `${v}%`;
  }

  update(dt) {
    const ctx = this.ctx;
    const inGame = ctx.mode !== 'menu';
    this.el.style.display = inGame ? '' : 'none';
    if (!inGame) return;

    this._pulse += dt;
    const sail = ctx.mode === 'sail';
    this.shipPanel.classList.toggle('hidden', !sail);
    this.footPanel.classList.toggle('hidden', sail);

    // ship instruments
    const ship = ctx.playerShip?.ship;
    if (sail && ship) {
      this._set('knots', this.speedV, ctx.playerShip.speedKnots.toFixed(1));
      this._setBar('sail', this.sailFill, ctx.playerShip.sailAmount);
      const hullFrac = ship.hull / ship.hullMax;
      this._setBar('hull', this.hullFill, hullFrac);
      const low = hullFrac < 0.3;
      if (this._cache.hullLow !== low) { this._cache.hullLow = low; this.hullBar.classList.toggle('low', low); }
      if (this._hullHit) {
        this._hullHit = false;
        this.hullBar.classList.remove('hit');
        void this.hullBar.offsetWidth;
        this.hullBar.classList.add('hit');
      }
      const rmax = ctx.combat?.reloadTimeFor?.(ship) ?? 6.5;
      const lFrac = 1 - ship.reloadL / rmax;
      const rFrac = 1 - ship.reloadR / rmax;
      this._setBar('pl', this.plFill, lFrac);
      this._setBar('pr', this.prFill, rFrac);
      this._toggle('plReady', this.plPip, 'ready', lFrac >= 0.999);
      this._toggle('prReady', this.prPip, 'ready', rFrac >= 0.999);
      this.anchorInd.classList.toggle('hidden', !ctx.playerShip.anchored);
      this.lowhull.classList.toggle('on', low);
    } else {
      this.lowhull.classList.remove('on');
    }

    // foot vitals
    const ch = ctx.character;
    if (!sail && ch) {
      this._setBar('hp', this.hpFill, ch.hp / ch.hpMax);
      this._setBar('stam', this.stamFill, ch.stamina / 100);
      this._setBar('pistol', this.pistolFill, 1 - (ch.sword?.pistolReload ?? 0) / 6);
    }

    // gold + day
    const gold = ctx.state?.data?.gold ?? 0;
    this._set('gold', this.goldEl, `${gold.toLocaleString('en-US')} s`);
    // Derive the day from persisted play time, not the session-local clock, so
    // "Day N" survives a Continue instead of resetting to Day 1 every load.
    const elapsed = ctx.state?.data?.timePlayed ?? ctx.time.t;
    const day = Math.floor(elapsed / (ctx.time.dayLength || 1)) + 1;
    const frac = ctx.time.dayFrac;
    const phase = frac < 0.2 ? 'small hours' : frac < 0.3 ? 'dawn' : frac < 0.45 ? 'morning'
      : frac < 0.58 ? 'midday' : frac < 0.72 ? 'afternoon' : frac < 0.82 ? 'dusk' : 'night';
    this._set('day', this.dayEl, `Day ${day} · ${phase}`);

    // objective tracker
    const active = ctx.quests?.activeDefs?.() ?? [];
    const first = active[0];
    const objText = first ? `<div class="qtitle">${first.title}</div>${ctx.quests.objectiveText(first)}` : '';
    if (this._cache.obj !== objText) {
      this._cache.obj = objText;
      this.objective.innerHTML = objText;
    }

    // reticle
    const aim = this._aim;
    this.reticle.classList.toggle('hidden', !aim.side);
    if (aim.side) {
      this.reticle.classList.toggle('ready', !!aim.ready);
      this._set('ammo', this.ammoEl,
        `${aim.side === 'L' ? 'PORT' : 'STARBOARD'} · ${AMMO_NAMES[aim.ammo] ?? 'ROUND SHOT'}`);
      this.rbarFill.style.width =
        `${Math.round((1 - (aim.reload ?? 0) / (aim.reloadMax || 1)) * 100)}%`;
    }

    // damage vignette
    if (this._vignetteT > 0) {
      this._vignetteT -= dt * 1.4;
      this.vignette.style.opacity = String(Math.max(this._vignetteT, 0));
    }

    this._updateTarget();
    this._updateBeacons();

    this._drawCompass();
  }

  // Enemy target panel: driven by the naval agent's ctx.combat.currentTarget.
  _updateTarget() {
    const ctx = this.ctx;
    const tgt = ctx.mode === 'sail' ? ctx.combat?.currentTarget : null;
    const show = !!tgt;
    if (this._cache.tpShow !== show) {
      this._cache.tpShow = show;
      this.targetPanel.classList.toggle('hidden', !show);
    }
    if (!tgt) return;

    this._set('tpName', this.tpName, tgt.name ?? 'Unknown Sail');
    const fac = tgt.faction ?? '';
    if (this._cache.tpFac !== fac) {
      this._cache.tpFac = fac;
      this.tpFaction.textContent = fac ? fac.toUpperCase() : '';
      this.tpFaction.style.color = FACTION_COLORS[fac] ?? '#c9b98f';
    }
    const frac = clamp01(tgt.hullFrac ?? 0);
    const pct = Math.round(frac * 100);
    if (this._cache.tpHull !== pct) {
      this._cache.tpHull = pct;
      this.tpHullFill.style.width = `${pct}%`;
      // green (120°) → red (0°) as hull drops
      this.tpHullFill.style.background = `hsl(${Math.round(frac * 120)},72%,45%)`;
    }
    this._set('tpCrew', this.tpCrew, `⚔ ${tgt.crewCount ?? 0}`);
    const dist = tgt.distance;
    this._set('tpDist', this.tpDist, dist != null ? `${Math.round(dist)} m` : '—');
    const board = !!tgt.boardable;
    if (this._cache.tpBoard !== board) {
      this._cache.tpBoard = board;
      this.tpBoard.classList.toggle('hidden', !board);
    }
  }

  // World position of the first active quest's target, if one is derivable.
  // Returns the shared _objPos scratch or null (never invents data).
  _questTargetPos() {
    const ctx = this.ctx;
    const defs = ctx.quests?.activeDefs?.() ?? [];
    const def = defs[0];
    const o = def?.objective;
    if (!o) return null;
    const islands = ctx.world?.islands ?? [];
    let isl = null;
    if (o.type === 'visit') isl = islands.find((i) => i.def?.id === o.islandId);
    else if (o.type === 'deliver') isl = islands.find((i) => i.port?.name === o.toPort);
    else if (o.type === 'talk') isl = islands.find((i) => i.port?.name === o.port);
    if (!isl) return null;
    const dp = isl.port?.dockPosition;
    if (dp) _objPos.copy(dp);
    else if (isl.def?.position) _objPos.set(isl.def.position[0], 8, isl.def.position[1]);
    else return null;
    this._objLabel = def.title ?? 'Objective';
    return _objPos;
  }

  // Project world targets to screen and drive the reused marker pool.
  _updateBeacons() {
    const ctx = this.ctx;
    const cam = ctx.camera;
    const pool = this._beacons;
    if (!pool) return;
    const active = cam && ctx.mode === 'sail';
    if (!active) {
      if (!this._cache.beaconsOff) {
        this._cache.beaconsOff = true;
        for (const b of pool) this._hideBeacon(b);
      }
      return;
    }
    this._cache.beaconsOff = false;

    const W = window.innerWidth || 1;
    const H = window.innerHeight || 1;
    const shipPos = ctx.playerShip?.ship?.position ?? cam.position;
    cam.getWorldDirection(_camDir);
    let idx = 0;

    // objective beacon first (always drawn strong)
    const objPos = this._questTargetPos();
    if (objPos && idx < pool.length) {
      const d = Math.hypot(objPos.x - shipPos.x, objPos.z - shipPos.z);
      if (this._placeBeacon(pool[idx], objPos, 'objective', this._objLabel, '#eccb6c', d, cam, W, H)) idx++;
    }

    // nearby port beacons (sail mode only, within range, capped by pool size)
    for (const isl of ctx.world?.islands ?? []) {
      if (idx >= pool.length) break;
      const port = isl.port;
      const dp = port?.dockPosition;
      if (!dp) continue;
      // skip the port that the objective beacon already marks (avoid a doubled dot)
      if (objPos && Math.hypot(dp.x - objPos.x, dp.z - objPos.z) < 2) continue;
      const d = Math.hypot(dp.x - shipPos.x, dp.z - shipPos.z);
      if (d > PORT_BEACON_RANGE) continue;
      const color = FACTION_COLORS[port.faction] ?? '#c9a24b';
      if (this._placeBeacon(pool[idx], dp, 'port', port.name ?? '', color, d, cam, W, H)) idx++;
    }

    for (let i = idx; i < pool.length; i++) this._hideBeacon(pool[i]);
  }

  _hideBeacon(b) {
    if (b._vis) { b._vis = false; b.el.style.display = 'none'; }
  }

  _placeBeacon(b, worldPos, kind, text, color, dist, cam, W, H) {
    _rel.copy(worldPos).sub(cam.position);
    const inFront = _rel.dot(_camDir) > 0;
    _proj.copy(worldPos).project(cam);
    let sx = (_proj.x * 0.5 + 0.5) * W;
    let sy = (-_proj.y * 0.5 + 0.5) * H;
    if (!inFront) { sx = W - sx; sy = H - sy; } // mirror back in front of us

    const cx = W * 0.5, cy = H * 0.5;
    const m = 30;
    let edge = !inFront || sx < m || sx > W - m || sy < m || sy > H - m;
    let rot = 0;
    if (edge) {
      let vx = sx - cx, vy = sy - cy;
      if (vx === 0 && vy === 0) vy = -1;
      const maxX = cx - m, maxY = cy - m;
      const scale = Math.min(maxX / Math.max(Math.abs(vx), 1e-3), maxY / Math.max(Math.abs(vy), 1e-3));
      sx = cx + vx * scale;
      sy = cy + vy * scale;
      rot = Math.atan2(vy, vx) * 180 / Math.PI + 90; // ▲ points up by default
    }

    // fade + scale by distance so near ports read stronger
    const t = clamp01(1 - dist / PORT_BEACON_RANGE);
    const op = kind === 'objective' ? 0.95 : (0.32 + 0.63 * t);
    const s = kind === 'objective' ? 1.05 : (0.82 + 0.32 * t);

    if (!b._vis) { b._vis = true; b.el.style.display = 'block'; }
    if (b._kind !== kind) {
      b._kind = kind;
      b.el.classList.toggle('objective', kind === 'objective');
      b.el.classList.toggle('port', kind === 'port');
    }
    if (b._edge !== edge) { b._edge = edge; b.el.classList.toggle('edge', edge); }
    if (b._text !== text) { b._text = text; b.label.textContent = text; }
    if (b._color !== color) {
      b._color = color;
      b.dot.style.color = color;
      b.arrow.style.color = color;
    }
    const rx = Math.round(sx), ry = Math.round(sy);
    if (b._x !== rx) { b._x = rx; b.el.style.left = `${rx}px`; }
    if (b._y !== ry) { b._y = ry; b.el.style.top = `${ry}px`; }
    const opr = Math.round(op * 100) / 100;
    if (b._op !== opr) { b._op = opr; b.el.style.opacity = String(opr); }
    const sr = Math.round(s * 100) / 100;
    if (b._s !== sr) { b._s = sr; b.el.style.transform = `translate(-50%,-50%) scale(${sr})`; }
    if (edge) {
      const rr = Math.round(rot);
      if (b._rot !== rr) { b._rot = rr; b.arrow.style.transform = `rotate(${rr}deg)`; }
    }
    return true;
  }

  _toggle(key, el, cls, on) {
    if (this._cache[key] === on) return;
    this._cache[key] = on;
    if (el) el.classList.toggle(cls, on);
  }

  _edgeFade(x, W) {
    // fade elements out over the last ~64px near either edge
    const m = 64;
    const d = Math.min(x, W - x);
    return clamp01((d - 6) / m);
  }

  _drawCompass() {
    const ctx = this.ctx;
    const g = this.cctx;
    const W = this._cw, H = this._ch;
    g.clearRect(0, 0, W, H);

    const bandY = 14, bandH = 30;

    // translucent ribbon body (gradient cached in constructor)
    g.beginPath();
    g.roundRect(0.5, bandY, W - 1, bandH, 8);
    g.fillStyle = this._ribbonGrad;
    g.fill();
    // brass frame
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(208,169,79,0.42)';
    g.stroke();
    // inner top highlight
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.beginPath();
    g.moveTo(4, bandY + 1.5); g.lineTo(W - 4, bandY + 1.5);
    g.stroke();

    // camera azimuth → ribbon mapping
    const cam = ctx.camera;
    cam.getWorldDirection(_dir);
    const az = Math.atan2(_dir.x, _dir.z);
    const span = Math.PI; // visible field
    const toX = (angle) => W / 2 + (wrapAngle(angle - az) / span) * W;

    g.textAlign = 'center';
    g.textBaseline = 'middle';

    // degree ticks every 15°
    for (let d = 0; d < 360; d += 15) {
      const a = (d * Math.PI) / 180;
      const x = toX(a);
      if (x < 6 || x > W - 6) continue;
      const fade = this._edgeFade(x, W);
      if (fade <= 0) continue;
      const major = d % 45 === 0;
      g.globalAlpha = fade * (major ? 0.55 : 0.32);
      g.fillStyle = '#e8dcc0';
      g.fillRect(x - 0.5, bandY + 5, 1, major ? 11 : 6);
    }
    g.globalAlpha = 1;

    // intercardinals (smaller)
    g.font = '11px Georgia';
    for (const [a, label] of INTERCARDINALS) {
      const x = toX(a);
      if (x < 12 || x > W - 12) continue;
      const fade = this._edgeFade(x, W);
      if (fade <= 0) continue;
      g.globalAlpha = fade * 0.7;
      g.fillStyle = '#c9b98f';
      g.fillText(label, x, bandY + 22);
    }
    g.globalAlpha = 1;

    // cardinals (large)
    g.font = '600 16px Georgia';
    for (const [a, label] of CARDINALS) {
      const x = toX(a);
      if (x < 12 || x > W - 12) continue;
      const fade = this._edgeFade(x, W);
      if (fade <= 0) continue;
      g.globalAlpha = fade;
      g.fillStyle = label === 'N' ? '#e58a6a' : '#f0e6cc';
      g.fillText(label, x, bandY + 22);
    }
    g.globalAlpha = 1;

    // wind chevron (from-direction of the wind), teal
    const wind = ctx.weather?.wind;
    if (wind) {
      const x = toX(wind.angle);
      if (x > 6 && x < W - 6) {
        g.globalAlpha = this._edgeFade(x, W);
        g.fillStyle = '#6fb3a8';
        g.beginPath();
        g.moveTo(x, 4); g.lineTo(x - 5, 11); g.lineTo(x + 5, 11);
        g.closePath();
        g.fill();
        g.globalAlpha = 1;
      }
    }

    const shipPos = ctx.playerShip?.ship?.position ?? cam.position;

    // nearby port markers (below the band)
    for (const isl of ctx.world?.islands ?? []) {
      if (!isl.port) continue;
      const dx = isl.port.dockPosition.x - shipPos.x;
      const dz = isl.port.dockPosition.z - shipPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 2600) continue;
      const a = Math.atan2(dx, dz);
      const x = toX(a);
      if (x < 6 || x > W - 6) continue;
      g.globalAlpha = this._edgeFade(x, W) * 0.9;
      g.fillStyle = '#c9a24b';
      g.beginPath();
      g.arc(x, bandY + bandH + 6, 3, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }

    // waypoint diamond (gold)
    const wp = ctx.state?.data?.waypoint;
    if (wp) {
      const a = Math.atan2(wp[0] - shipPos.x, wp[1] - shipPos.z);
      const x = toX(a);
      if (x > 6 && x < W - 6) {
        const pulse = 0.75 + 0.25 * Math.sin(this._pulse * 4);
        g.globalAlpha = this._edgeFade(x, W) * pulse;
        g.fillStyle = '#eccb6c';
        g.save();
        g.translate(x, bandY + bandH + 6);
        g.rotate(Math.PI / 4);
        g.fillRect(-4, -4, 8, 8);
        g.restore();
        g.globalAlpha = 1;
      }
    }

    // fixed heading marker at centre
    g.fillStyle = '#eccb6c';
    g.beginPath();
    g.moveTo(W / 2, bandY - 1);
    g.lineTo(W / 2 - 6, bandY - 9);
    g.lineTo(W / 2 + 6, bandY - 9);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(236,203,108,0.85)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(W / 2, bandY);
    g.lineTo(W / 2, bandY + bandH);
    g.stroke();
  }
}
