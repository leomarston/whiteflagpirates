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
      this.canvas.width = size * 1.35;
      this.canvas.height = size;

      this.canvas.addEventListener('click', (e) => this._onClick(e));
      this.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.zoom = Math.min(4, Math.max(0.8, this.zoom * (e.deltaY < 0 ? 1.15 : 0.87)));
        this._draw();
      }, { passive: false });
      let dragging = false, lx = 0, ly = 0;
      this.canvas.addEventListener('mousedown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
      window.addEventListener('mouseup', () => { dragging = false; });
      this.canvas.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        this.panX += (e.clientX - lx);
        this.panY += (e.clientY - ly);
        lx = e.clientX; ly = e.clientY;
        this._draw();
      });
      this._draw();
    });
    return panel;
  }

  _transform() {
    const W = this.canvas.width, H = this.canvas.height;
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
    const rect = this.canvas.getBoundingClientRect();
    const { fromX, fromY } = this._transform();
    const wx = fromX((e.clientX - rect.left) * (this.canvas.width / rect.width));
    const wz = fromY((e.clientY - rect.top) * (this.canvas.height / rect.height));
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
    const W = this.canvas.width, H = this.canvas.height;
    const { toX, toY, scale } = this._transform();
    const discovered = this.ctx.state.data.discovered ?? [];

    // parchment
    g.fillStyle = '#e4d6b4';
    g.fillRect(0, 0, W, H);
    const grad = g.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.85);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(90,60,20,0.28)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);

    // rhumb lines
    g.strokeStyle = 'rgba(90,60,20,0.12)';
    g.lineWidth = 1;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      g.beginPath();
      g.moveTo(W / 2, H / 2);
      g.lineTo(W / 2 + Math.cos(a) * W, H / 2 + Math.sin(a) * W);
      g.stroke();
    }
    // compass rose
    g.save();
    g.translate(W - 74, 78);
    g.strokeStyle = 'rgba(60,40,15,0.55)';
    g.fillStyle = 'rgba(60,40,15,0.55)';
    g.lineWidth = 1.4;
    g.beginPath(); g.arc(0, 0, 30, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const len = i % 2 === 0 ? 26 : 15;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.sin(a) * len, -Math.cos(a) * len); g.stroke();
    }
    g.font = '13px Georgia';
    g.textAlign = 'center';
    g.fillText('N', 0, -36);
    g.restore();

    // islands
    g.font = `${Math.max(12, 13 * this.zoom * 0.8)}px Georgia`;
    g.textAlign = 'center';
    for (const { isl, pts } of this._shapes()) {
      const known = discovered.includes(isl.id);
      g.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = toX(pts[i][0]), y = toY(pts[i][1]);
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.closePath();
      if (known) {
        g.fillStyle = '#c9b285';
        g.fill();
        g.strokeStyle = 'rgba(60,40,15,0.7)';
        g.lineWidth = 1.6;
        g.stroke();
        // shallows halo
        g.strokeStyle = 'rgba(29,111,109,0.35)';
        g.lineWidth = 5;
        g.stroke();
        g.fillStyle = '#3a2c18';
        g.fillText(isl.name, toX(isl.position[0]), toY(isl.position[1] + isl.radius) + 16);
        if (isl.port) {
          g.fillStyle = '#7e2a1e';
          g.beginPath();
          g.arc(toX(isl.position[0]), toY(isl.position[1]), 3.5, 0, Math.PI * 2);
          g.fill();
        }
      } else {
        g.save();
        g.clip();
        g.strokeStyle = 'rgba(60,40,15,0.18)';
        g.lineWidth = 1;
        for (let x = -W; x < W * 2; x += 7) {
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x + H, H); g.stroke();
        }
        g.restore();
        g.strokeStyle = 'rgba(60,40,15,0.3)';
        g.lineWidth = 1;
        g.stroke();
      }
    }

    // treasure map X marks (only when the island is discovered)
    g.font = `${16 * Math.max(this.zoom * 0.8, 1)}px Georgia`;
    for (const map of this.ctx.state.data.maps ?? []) {
      if (map.found || !discovered.includes(map.islandId)) continue;
      g.fillStyle = '#7e2a1e';
      g.fillText('✕', toX(map.x), toY(map.z) + 6);
    }

    // waypoint
    const wp = this.ctx.state.data.waypoint;
    if (wp) {
      g.strokeStyle = '#8a6f33';
      g.lineWidth = 2;
      const x = toX(wp[0]), y = toY(wp[1]);
      g.beginPath(); g.arc(x, y, 8, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(x - 12, y); g.lineTo(x + 12, y); g.stroke();
      g.beginPath(); g.moveTo(x, y - 12); g.lineTo(x, y + 12); g.stroke();
    }

    // player ship marker
    const ship = this.ctx.playerShip?.ship;
    if (ship) {
      const x = toX(ship.position.x), y = toY(ship.position.z);
      const h = this.ctx.playerShip.heading;
      g.save();
      g.translate(x, y);
      g.rotate(Math.PI - h); // world heading → canvas orientation
      g.fillStyle = '#1c2f44';
      g.beginPath();
      g.moveTo(0, -9); g.lineTo(6, 7); g.lineTo(0, 4); g.lineTo(-6, 7);
      g.closePath();
      g.fill();
      g.restore();
    }
  }
}
