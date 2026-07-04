// The world chart: parchment canvas, island silhouettes, waypoints.
import { fbm2, SimplexNoise, wrapAngle } from '../core/utils.js';
import { WORLD } from '../core/constants.js';

export class MapScreen {
  constructor(ctx, ui) {
    this.ctx = ctx;
    this.ui = ui;
    this._islandShapes = null; // cached blob outlines
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    // stable parchment mottling (fractional coords, generated once)
    this._blotches = [];
    for (let i = 0; i < 26; i++) {
      this._blotches.push({
        x: Math.random(), y: Math.random(),
        r: 0.05 + Math.random() * 0.16,
        a: 0.03 + Math.random() * 0.05,
      });
    }
  }

  _shapes() {
    if (this._islandShapes) return this._islandShapes;
    this._islandShapes = this.ctx.data.islands.map((isl) => {
      const noise = new SimplexNoise(isl.seed);
      const pts = [];
      const N = 44;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const r = isl.radius * (0.82 + 0.3 * fbm2(noise, Math.cos(a) * 1.6 + 10.7, Math.sin(a) * 1.6 + 3.1, 3));
        pts.push([isl.position[0] + Math.cos(a) * r, isl.position[1] + Math.sin(a) * r]);
      }
      return { isl, pts };
    });
    return this._islandShapes;
  }

  open() {
    const panel = this.ui.openScreen('map', (p) => {
      p.insertAdjacentHTML('beforeend', `
        <h2>Chart of the Meridian Verge</h2>
        <div class="sub">Click to set a waypoint · scroll to zoom · drag to pan</div>
        <canvas id="map-canvas"></canvas>
        <div class="map-hint">Uncharted waters hide their names until you've seen their shores.</div>
      `);
      this.canvas = p.querySelector('#map-canvas');
      const size = Math.min(window.innerWidth * 0.7, window.innerHeight * 0.62, 720);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this._w = Math.round(size * 1.35);
      this._h = Math.round(size);
      this.canvas.width = this._w * dpr;
      this.canvas.height = this._h * dpr;
      this.canvas.style.width = this._w + 'px';
      this.canvas.style.height = this._h + 'px';
      this._dpr = dpr;

      this.canvas.addEventListener('click', (e) => this._onClick(e));
      this.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.zoom = Math.min(4, Math.max(0.8, this.zoom * (e.deltaY < 0 ? 1.15 : 0.87)));
        this._draw();
      }, { passive: false });
      let dragging = false, lx = 0, ly = 0;
      this.canvas.addEventListener('mousedown', (e) => { dragging = true; this._dragged = false; lx = e.clientX; ly = e.clientY; });
      window.addEventListener('mouseup', () => { dragging = false; });
      this.canvas.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        this.panX += (e.clientX - lx);
        this.panY += (e.clientY - ly);
        lx = e.clientX; ly = e.clientY;
        this._dragged = true;
        this._draw();
      });
      this._draw();
    });
    return panel;
  }

  _transform() {
    const W = this._w, H = this._h;
    const scale = (Math.min(W, H) / WORLD.SEA_SIZE) * 0.92 * this.zoom;
    return {
      toX: (wx) => W / 2 + wx * scale + this.panX,
      toY: (wz) => H / 2 + wz * scale + this.panY,
      fromX: (px) => (px - W / 2 - this.panX) / scale,
      fromY: (py) => (py - H / 2 - this.panY) / scale,
      scale,
    };
  }

  _onClick(e) {
    if (this._dragged) { this._dragged = false; return; } // don't set waypoint after a pan
    const rect = this.canvas.getBoundingClientRect();
    const { fromX, fromY } = this._transform();
    const wx = fromX((e.clientX - rect.left) * (this._w / rect.width));
    const wz = fromY((e.clientY - rect.top) * (this._h / rect.height));
    const wp = this.ctx.state.data.waypoint;
    if (wp && Math.hypot(wp[0] - wx, wp[1] - wz) < 300 / this.zoom) {
      this.ctx.state.data.waypoint = null;
      this.ui.toast('Waypoint cleared.', 'info');
    } else {
      this.ctx.state.data.waypoint = [Math.round(wx), Math.round(wz)];
      this.ui.toast('Waypoint set. Watch your compass.', 'info');
    }
    this._draw();
  }

  _draw() {
    const g = this.canvas.getContext('2d');
    const W = this._w, H = this._h;
    g.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    const { toX, toY, scale } = this._transform();
    const discovered = this.ctx.state.data.discovered ?? [];

    // parchment base
    g.fillStyle = '#e5d7b5';
    g.fillRect(0, 0, W, H);
    // warm mottling
    for (const b of this._blotches) {
      const bx = b.x * W, by = b.y * H, br = b.r * Math.min(W, H);
      const bg = g.createRadialGradient(bx, by, 0, bx, by, br);
      bg.addColorStop(0, `rgba(120,86,36,${b.a})`);
      bg.addColorStop(1, 'rgba(120,86,36,0)');
      g.fillStyle = bg;
      g.fillRect(bx - br, by - br, br * 2, br * 2);
    }
    // aged edge burn
    const grad = g.createRadialGradient(W / 2, H / 2, H * 0.22, W / 2, H / 2, H * 0.9);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.75, 'rgba(90,60,20,0.12)');
    grad.addColorStop(1, 'rgba(70,44,14,0.42)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);

    // rhumb lines from centre
    g.strokeStyle = 'rgba(90,60,20,0.1)';
    g.lineWidth = 1;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      g.beginPath();
      g.moveTo(W / 2, H / 2);
      g.lineTo(W / 2 + Math.cos(a) * W, H / 2 + Math.sin(a) * W);
      g.stroke();
    }

    // decorative chart frame
    g.strokeStyle = 'rgba(60,40,15,0.5)';
    g.lineWidth = 2;
    g.strokeRect(7, 7, W - 14, H - 14);
    g.lineWidth = 1;
    g.strokeRect(12, 12, W - 24, H - 24);

    // islands
    for (const { isl, pts } of this._shapes()) {
      const known = discovered.includes(isl.id);
      g.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = toX(pts[i][0]), y = toY(pts[i][1]);
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.closePath();
      if (known) {
        const cx = toX(isl.position[0]), cy = toY(isl.position[1]);
        const cr = isl.radius * scale;
        // shallows halo (outer, drawn first so it reads as a ring)
        g.save();
        g.strokeStyle = 'rgba(29,111,109,0.32)';
        g.lineWidth = 6;
        g.stroke();
        g.restore();
        // land fill
        g.fillStyle = '#cbb488';
        g.fill();
        // elevation shading (lighter uplands at centre)
        g.save();
        g.clip();
        const relief = g.createRadialGradient(cx - cr * 0.2, cy - cr * 0.2, cr * 0.1, cx, cy, cr);
        relief.addColorStop(0, 'rgba(232,214,170,0.75)');
        relief.addColorStop(0.6, 'rgba(180,150,96,0.15)');
        relief.addColorStop(1, 'rgba(120,90,50,0.35)');
        g.fillStyle = relief;
        g.fillRect(cx - cr, cy - cr, cr * 2, cr * 2);
        g.restore();
        // coastline
        g.strokeStyle = 'rgba(60,40,15,0.72)';
        g.lineWidth = 1.6;
        g.stroke();

        // label
        g.font = `${Math.max(12, 13 * Math.min(this.zoom, 1.6))}px Georgia`;
        g.textAlign = 'center';
        const ly = cy + cr + 15;
        g.fillStyle = 'rgba(240,230,205,0.85)';
        g.fillText(isl.name, cx + 0.6, ly + 0.6);
        g.fillStyle = '#3a2c18';
        g.fillText(isl.name, cx, ly);
        // port dot
        if (isl.port) {
          g.fillStyle = '#7e2a1e';
          g.beginPath();
          g.arc(cx, cy, 3.5, 0, Math.PI * 2);
          g.fill();
          g.strokeStyle = 'rgba(126,42,30,0.4)';
          g.lineWidth = 4;
          g.beginPath();
          g.arc(cx, cy, 5.5, 0, Math.PI * 2);
          g.stroke();
        }
      } else {
        // fog of war: faint hatched blob
        g.save();
        g.clip();
        g.fillStyle = 'rgba(120,90,50,0.06)';
        g.fillRect(0, 0, W, H);
        g.strokeStyle = 'rgba(60,40,15,0.16)';
        g.lineWidth = 1;
        for (let x = -W; x < W * 2; x += 7) {
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x + H, H); g.stroke();
        }
        g.restore();
        g.strokeStyle = 'rgba(60,40,15,0.28)';
        g.lineWidth = 1;
        g.stroke();
      }
    }

    // treasure map X marks (only when the island is discovered)
    g.font = `${16 * Math.max(Math.min(this.zoom, 1.6) * 0.9, 1)}px Georgia`;
    g.textAlign = 'center';
    for (const map of this.ctx.state.data.maps ?? []) {
      if (map.found || !discovered.includes(map.islandId)) continue;
      g.fillStyle = 'rgba(126,42,30,0.35)';
      g.fillText('✕', toX(map.x) + 0.5, toY(map.z) + 6.5);
      g.fillStyle = '#7e2a1e';
      g.fillText('✕', toX(map.x), toY(map.z) + 6);
    }

    // waypoint
    const wp = this.ctx.state.data.waypoint;
    if (wp) {
      const x = toX(wp[0]), y = toY(wp[1]);
      g.strokeStyle = '#8a6f33';
      g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 8, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(x - 13, y); g.lineTo(x + 13, y); g.stroke();
      g.beginPath(); g.moveTo(x, y - 13); g.lineTo(x, y + 13); g.stroke();
      g.fillStyle = 'rgba(138,111,51,0.9)';
      g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
      // distance readout from the ship
      const ship = this.ctx.playerShip?.ship;
      if (ship) {
        const nm = Math.hypot(wp[0] - ship.position.x, wp[1] - ship.position.z) / 1852;
        g.font = '11px Georgia';
        g.textAlign = 'left';
        g.fillStyle = '#5a4a22';
        g.fillText(`${nm.toFixed(1)} nm`, x + 12, y - 10);
      }
    }

    // compass rose (drawn late so it sits atop the sea)
    g.save();
    g.translate(W - 78, 80);
    g.strokeStyle = 'rgba(60,40,15,0.6)';
    g.fillStyle = 'rgba(60,40,15,0.6)';
    g.lineWidth = 1.4;
    g.beginPath(); g.arc(0, 0, 32, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(0, 0, 26, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const len = i % 2 === 0 ? 26 : 15;
      g.lineWidth = i % 2 === 0 ? 1.6 : 1;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.sin(a) * len, -Math.cos(a) * len); g.stroke();
    }
    g.fillStyle = '#7e2a1e';
    g.beginPath(); g.moveTo(0, -26); g.lineTo(-4, -6); g.lineTo(4, -6); g.closePath(); g.fill();
    g.font = '13px Georgia';
    g.textAlign = 'center';
    g.fillStyle = '#3a2c18';
    g.fillText('N', 0, -38);
    g.restore();

    // player ship marker
    const ship = this.ctx.playerShip?.ship;
    if (ship) {
      const x = toX(ship.position.x), y = toY(ship.position.z);
      const h = this.ctx.playerShip.heading;
      g.save();
      g.translate(x, y);
      g.rotate(Math.PI - h); // world heading → canvas orientation
      // glow
      g.fillStyle = 'rgba(30,47,68,0.25)';
      g.beginPath(); g.arc(0, 0, 11, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#1c2f44';
      g.strokeStyle = 'rgba(240,230,205,0.7)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, -10); g.lineTo(6, 8); g.lineTo(0, 4.5); g.lineTo(-6, 8);
      g.closePath();
      g.fill();
      g.stroke();
      g.restore();
    }
  }
}
