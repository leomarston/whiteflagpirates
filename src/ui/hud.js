// HUD: compass ribbon, ship instruments, foot vitals, gold, prompts, reticle.
import { Vector3 } from 'three';
import { clamp01, wrapAngle } from '../core/utils.js';

const _dir = new Vector3();

const AMMO_NAMES = { round: 'ROUND SHOT', chain: 'CHAIN SHOT', grape: 'GRAPE SHOT' };

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

    this._drawCompass();
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
