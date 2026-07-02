// HUD: compass ribbon, ship instruments, foot vitals, gold, prompts, reticle.
import { Vector3 } from 'three';
import { clamp01, wrapAngle } from '../core/utils.js';

const _dir = new Vector3();

const CARDINALS = [[0, 'N'], [Math.PI / 2, 'E'], [Math.PI, 'S'], [-Math.PI / 2, 'W']];

export class HUD {
  constructor(ctx, ui) {
    this.ctx = ctx;
    this.ui = ui;
    const root = ui.root;

    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div id="compass-wrap"><canvas id="compass" width="680" height="52"></canvas></div>
      <div id="objective"></div>
      <div id="toasts"></div>
      <div id="ship-panel" class="hidden">
        <div id="speed-knots">0.0 <small>KNOTS</small></div>
        <div class="gauge-row"><span class="lbl">Sail</span><div class="bar sail"><i></i></div></div>
        <div class="gauge-row"><span class="lbl">Hull</span><div class="bar hull"><i></i></div></div>
        <div class="reload-pips">
          <div class="side">P <span class="pip"><i class="pl"></i></span></div>
          <div class="side">S <span class="pip"><i class="pr"></i></span></div>
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

    this.compass = this.el.querySelector('#compass');
    this.cctx = this.compass.getContext('2d');
    this.toasts = this.el.querySelector('#toasts');
    this.promptEl = this.el.querySelector('#prompt');
    this.sayEl = this.el.querySelector('#saybubble');
    this.objective = this.el.querySelector('#objective');
    this.shipPanel = this.el.querySelector('#ship-panel');
    this.footPanel = this.el.querySelector('#foot-panel');
    this.reticle = this.el.querySelector('#reticle');
    this.vignette = this.el.querySelector('#vignette');
    this.lowhull = this.el.querySelector('#lowhull');

    this._cache = {};
    this._aim = { side: null };
    this._vignetteT = 0;
    this._goldSeen = null;

    ctx.events?.on('aim:update', (a) => { this._aim = a; });
    ctx.events?.on('player:hurt', () => { this._vignetteT = 1; });
    ctx.events?.on('ship:hit', ({ onPlayer }) => { if (onPlayer) this._vignetteT = 0.7; });
    ctx.events?.on('gold:change', (gold) => {
      const el = this.el.querySelector('#gold-readout');
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    });
  }

  _set(key, el, value) {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    el.textContent = value;
  }

  _setBar(key, selector, frac) {
    const v = Math.round(clamp01(frac) * 100);
    if (this._cache[key] === v) return;
    this._cache[key] = v;
    this.el.querySelector(selector).style.width = `${v}%`;
  }

  update(dt) {
    const ctx = this.ctx;
    const inGame = ctx.mode !== 'menu';
    this.el.style.display = inGame ? '' : 'none';
    if (!inGame) return;

    const sail = ctx.mode === 'sail';
    this.shipPanel.classList.toggle('hidden', !sail);
    this.footPanel.classList.toggle('hidden', sail);

    // ship instruments
    const ship = ctx.playerShip?.ship;
    if (sail && ship) {
      this._set('knots', this.el.querySelector('#speed-knots'), `${ctx.playerShip.speedKnots.toFixed(1)} `);
      const small = document.createElement('small');
      small.textContent = 'KNOTS';
      if (!this.el.querySelector('#speed-knots small')) this.el.querySelector('#speed-knots').appendChild(small);
      this._setBar('sail', '.bar.sail i', ctx.playerShip.sailAmount);
      this._setBar('hull', '.bar.hull i', ship.hull / ship.hullMax);
      const rmax = ctx.combat?.reloadTimeFor?.(ship) ?? 6.5;
      this._setBar('pl', '.pip .pl', 1 - ship.reloadL / rmax);
      this._setBar('pr', '.pip .pr', 1 - ship.reloadR / rmax);
      this.el.querySelector('#anchor-ind').classList.toggle('hidden', !ctx.playerShip.anchored);
      this.lowhull.classList.toggle('on', ship.hull < ship.hullMax * 0.3);
    } else {
      this.lowhull.classList.remove('on');
    }

    // foot vitals
    const ch = ctx.character;
    if (!sail && ch) {
      this._setBar('hp', '.bar.hp i', ch.hp / ch.hpMax);
      this._setBar('stam', '.bar.stam i', ch.stamina / 100);
      this._setBar('pistol', '.pistol', 1 - (ch.sword?.pistolReload ?? 0) / 6);
    }

    // gold + day
    const gold = ctx.state?.data?.gold ?? 0;
    this._set('gold', this.el.querySelector('#gold-readout'), `${gold.toLocaleString('en-US')} s`);
    const day = Math.floor(ctx.time.t / ctx.time.dayLength) + 1;
    const frac = ctx.time.dayFrac;
    const phase = frac < 0.2 ? 'small hours' : frac < 0.3 ? 'dawn' : frac < 0.45 ? 'morning'
      : frac < 0.58 ? 'midday' : frac < 0.72 ? 'afternoon' : frac < 0.82 ? 'dusk' : 'night';
    this._set('day', this.el.querySelector('#day-readout'), `Day ${day} · ${phase}`);

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
      const names = { round: 'ROUND SHOT', chain: 'CHAIN SHOT', grape: 'GRAPE SHOT' };
      this._set('ammo', this.reticle.querySelector('.ammo'),
        `${aim.side === 'L' ? 'PORT' : 'STARBOARD'} · ${names[aim.ammo] ?? 'ROUND SHOT'}`);
      this.reticle.querySelector('.rbar i').style.width =
        `${Math.round((1 - (aim.reload ?? 0) / (aim.reloadMax || 1)) * 100)}%`;
    }

    // damage vignette
    if (this._vignetteT > 0) {
      this._vignetteT -= dt * 1.4;
      this.vignette.style.opacity = String(Math.max(this._vignetteT, 0));
    }

    this._drawCompass();
  }

  _drawCompass() {
    const ctx = this.ctx;
    const g = this.cctx;
    const W = this.compass.width, H = this.compass.height;
    g.clearRect(0, 0, W, H);

    // backdrop
    g.fillStyle = 'rgba(9,18,27,0.72)';
    g.beginPath();
    g.roundRect(0, 8, W, 30, 6);
    g.fill();
    g.strokeStyle = 'rgba(201,162,75,0.4)';
    g.strokeRect(0.5, 8.5, W - 1, 29);

    // camera azimuth
    const cam = ctx.camera;
    cam.getWorldDirection(_dir);
    const az = Math.atan2(_dir.x, _dir.z);
    const span = Math.PI; // visible field of the ribbon
    const toX = (angle) => W / 2 + (wrapAngle(angle - az) / span) * W;

    g.textAlign = 'center';
    g.textBaseline = 'middle';

    // degree ticks every 15°
    g.fillStyle = 'rgba(232,220,192,0.4)';
    for (let d = 0; d < 360; d += 15) {
      const a = (d * Math.PI) / 180;
      const x = toX(a);
      if (x < 8 || x > W - 8) continue;
      g.fillRect(x, 12, 1, d % 45 === 0 ? 10 : 5);
    }
    // cardinals
    g.font = '15px Georgia';
    for (const [a, label] of CARDINALS) {
      const x = toX(a);
      if (x < 12 || x > W - 12) continue;
      g.fillStyle = label === 'N' ? '#e07a6a' : '#e8dcc0';
      g.fillText(label, x, 24);
    }

    // wind chevron
    const wind = ctx.weather?.wind;
    if (wind) {
      const x = toX(wind.angle);
      if (x > 8 && x < W - 8) {
        g.fillStyle = '#6fb3a8';
        g.beginPath();
        g.moveTo(x, 2); g.lineTo(x - 5, 9); g.lineTo(x + 5, 9);
        g.closePath();
        g.fill();
      }
    }

    // waypoint diamond
    const wp = ctx.state?.data?.waypoint;
    const shipPos = ctx.playerShip?.ship?.position ?? cam.position;
    if (wp) {
      const a = Math.atan2(wp[0] - shipPos.x, wp[1] - shipPos.z);
      const x = toX(a);
      if (x > 8 && x < W - 8) {
        g.fillStyle = '#e8c860';
        g.save();
        g.translate(x, 43);
        g.rotate(Math.PI / 4);
        g.fillRect(-4, -4, 8, 8);
        g.restore();
      }
    }

    // nearby port markers
    for (const isl of ctx.world?.islands ?? []) {
      if (!isl.port) continue;
      const d = Math.hypot(isl.port.dockPosition.x - shipPos.x, isl.port.dockPosition.z - shipPos.z);
      if (d > 2600) continue;
      const a = Math.atan2(isl.port.dockPosition.x - shipPos.x, isl.port.dockPosition.z - shipPos.z);
      const x = toX(a);
      if (x < 8 || x > W - 8) continue;
      g.fillStyle = 'rgba(201,162,75,0.9)';
      g.beginPath();
      g.arc(x, 43, 3, 0, Math.PI * 2);
      g.fill();
    }
  }
}
