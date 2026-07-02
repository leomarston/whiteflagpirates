// Title screen, pause, settings, death, credits.

export class Menus {
  constructor(ctx, ui) {
    this.ctx = ctx;
    this.ui = ui;
    this._buildTitle();
    this._buildDeath();
    this._waveT = 0;

    ctx.events?.on('player:death', () => this._showDeath());
    ctx.events?.on('game:start', () => {
      this.title.classList.add('hidden');
    });
  }

  _buildTitle() {
    this.title = document.createElement('div');
    this.title.id = 'title-screen';
    this.title.innerHTML = `
      <canvas id="title-sea"></canvas>
      <div class="flagmark">⚑</div>
      <h1>WhiteFlagPirates</h1>
      <div class="tagline">No masters. No surrender. The Verge is free.</div>
      <div id="title-menu">
        <button class="primary" data-act="new">New Voyage</button>
        <button data-act="continue">Continue</button>
        <button data-act="settings">Settings</button>
        <button data-act="credits">Credits</button>
      </div>
      <div class="version">the Meridian Verge · v0.1</div>
    `;
    this.ui.root.appendChild(this.title);
    this.seaCanvas = this.title.querySelector('#title-sea');

    this.title.querySelector('[data-act="new"]').onclick = () => {
      if (this.ctx.state.hasSave()) {
        if (!window.confirm('Start a fresh voyage? Your saved game will be replaced.')) return;
      }
      this._start(true);
    };
    const cont = this.title.querySelector('[data-act="continue"]');
    cont.disabled = !this.ctx.state.hasSave();
    cont.onclick = () => this._start(false);
    this.title.querySelector('[data-act="settings"]').onclick = () => this.openSettings();
    this.title.querySelector('[data-act="credits"]').onclick = () => this.openCredits();
  }

  _start(fresh) {
    this.title.classList.add('hidden');
    this.ctx.time.paused = false;
    this.ctx.events?.emit('game:start', { fresh });
  }

  _buildDeath() {
    this.death = document.createElement('div');
    this.death.id = 'death-overlay';
    this.death.className = 'hidden';
    this.death.innerHTML = `
      <h2>The sea keeps what it takes.</h2>
      <div style="opacity:0.6;font-style:italic">…but not you. Not today.</div>
      <button class="primary" id="respawn-btn">Wash ashore</button>
    `;
    this.ui.root.appendChild(this.death);
    this.death.querySelector('#respawn-btn').onclick = () => {
      this.death.classList.add('hidden');
      this.death.classList.remove('show');
      this.ctx.events?.emit('player:respawn', {});
    };
  }

  _showDeath() {
    this.death.classList.remove('hidden');
    requestAnimationFrame(() => this.death.classList.add('show'));
  }

  openPause() {
    this.ui.openScreen('pause', (panel) => {
      panel.insertAdjacentHTML('beforeend', `
        <h2>Becalmed</h2>
        <div class="sub">The Verge waits on your word, Captain.</div>
        <div class="menu-col"></div>
      `);
      const col = panel.querySelector('.menu-col');
      const mk = (label, fn, cls = '') => {
        const b = document.createElement('button');
        if (cls) b.className = cls;
        b.textContent = label;
        b.onclick = fn;
        col.appendChild(b);
      };
      mk('Resume', () => this.ui.closeScreen(), 'primary');
      mk('Settings', () => this.openSettings());
      mk('Save Voyage', () => {
        this.ctx.state.save();
        this.ui.toast('Voyage saved to the log.', 'info');
      });
      mk('Save & Return to Title', () => {
        this.ctx.state.save();
        window.location.reload();
      }, 'danger');
    });
  }

  openSettings() {
    const ctx = this.ctx;
    this.ui.openScreen('settings', (panel) => {
      const s = ctx.state.settings;
      panel.insertAdjacentHTML('beforeend', `
        <h2>Settings</h2>
        <div class="sub">Rig the ship to your liking.</div>
        <div class="set-row"><label>Quality</label>
          <select id="set-quality">
            <option value="low">Low — calm harbor</option>
            <option value="medium">Medium — trade winds</option>
            <option value="high">High — full sail</option>
          </select></div>
        <div class="set-row"><label>Master volume</label><input type="range" id="set-master" min="0" max="1" step="0.05"></div>
        <div class="set-row"><label>Music</label><input type="range" id="set-music" min="0" max="1" step="0.05"></div>
        <div class="set-row"><label>Effects</label><input type="range" id="set-sfx" min="0" max="1" step="0.05"></div>
        <div class="set-row"><label>Field of view</label><input type="range" id="set-fov" min="45" max="90" step="1"></div>
        <div class="set-row"><label>Invert look Y</label><input type="checkbox" id="set-invert"></div>
      `);
      const q = panel.querySelector('#set-quality');
      q.value = s.quality;
      q.onchange = () => {
        s.quality = q.value;
        ctx.engine.setQuality(q.value);
        ctx.state.saveSettings();
      };
      const bind = (id, key, fn) => {
        const el = panel.querySelector(id);
        el.value = s[key];
        el.oninput = () => {
          s[key] = parseFloat(el.value);
          fn?.(s[key]);
          ctx.state.saveSettings();
        };
      };
      bind('#set-master', 'volumeMaster', () => ctx.audio?.setVolumes?.(s));
      bind('#set-music', 'volumeMusic', () => ctx.audio?.setVolumes?.(s));
      bind('#set-sfx', 'volumeSfx', () => ctx.audio?.setVolumes?.(s));
      bind('#set-fov', 'fov', (v) => ctx.engine.setFov(v));
      const inv = panel.querySelector('#set-invert');
      inv.checked = !!s.invertY;
      inv.onchange = () => { s.invertY = inv.checked; ctx.state.saveSettings(); };
    });
    // settings can be opened from the title screen — don't pause-flag there
    if (this.ctx.mode === 'menu') this.ctx.time.paused = true;
  }

  openCredits() {
    const credits = this.ctx.data.lore.credits;
    this.ui.openScreen('credits', (panel) => {
      panel.insertAdjacentHTML('beforeend', `
        <h2>${credits.title}</h2>
        <div style="max-width:520px;line-height:1.9;font-size:15px;font-style:italic;color:var(--parchment-dark)">
          ${credits.lines.map((l) => `<p>${l}</p>`).join('')}
        </div>
      `);
    });
  }

  update(dt) {
    // animated title seascape
    if (this.title.classList.contains('hidden')) return;
    this._waveT += dt;
    const c = this.seaCanvas;
    if (c.width !== c.clientWidth) {
      c.width = c.clientWidth || window.innerWidth;
      c.height = c.clientHeight || window.innerHeight;
    }
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const horizon = c.height * 0.68;
    // moon glow
    const mg = g.createRadialGradient(c.width * 0.72, c.height * 0.2, 8, c.width * 0.72, c.height * 0.2, 130);
    mg.addColorStop(0, 'rgba(232,228,218,0.8)');
    mg.addColorStop(0.12, 'rgba(220,225,235,0.35)');
    mg.addColorStop(1, 'rgba(220,225,235,0)');
    g.fillStyle = mg;
    g.fillRect(0, 0, c.width, c.height);
    // sea bands
    for (let i = 0; i < 14; i++) {
      const y = horizon + i * ((c.height - horizon) / 14);
      const alpha = 0.05 + i * 0.012;
      g.strokeStyle = `rgba(120,160,180,${alpha})`;
      g.lineWidth = 1 + i * 0.3;
      g.beginPath();
      for (let x = 0; x <= c.width; x += 14) {
        const yy = y + Math.sin(x * 0.011 + this._waveT * (0.6 + i * 0.07) + i * 2.2) * (2 + i * 0.8);
        x === 0 ? g.moveTo(x, yy) : g.lineTo(x, yy);
      }
      g.stroke();
    }
    // distant ship silhouette
    const sx = c.width * 0.28 + Math.sin(this._waveT * 0.22) * 10;
    const sy = horizon - 4 + Math.sin(this._waveT * 0.5) * 2.5;
    g.fillStyle = 'rgba(8,14,20,0.9)';
    g.beginPath();
    g.moveTo(sx - 44, sy);
    g.quadraticCurveTo(sx, sy + 15, sx + 46, sy);
    g.lineTo(sx + 36, sy - 8);
    g.lineTo(sx - 38, sy - 8);
    g.closePath();
    g.fill();
    g.fillRect(sx - 20, sy - 55, 2.5, 48);
    g.fillRect(sx + 8, sy - 44, 2, 37);
    // white sails
    g.fillStyle = 'rgba(216,212,200,0.85)';
    g.beginPath();
    g.moveTo(sx - 18, sy - 52);
    g.quadraticCurveTo(sx - 2, sy - 40, sx - 18, sy - 16);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(sx + 10, sy - 40);
    g.quadraticCurveTo(sx + 24, sy - 28, sx + 10, sy - 12);
    g.closePath();
    g.fill();
  }
}
