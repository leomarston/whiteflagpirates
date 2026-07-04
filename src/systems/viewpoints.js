// Viewpoints — climb (or sail up) to a named high landmark and "survey" from it,
// unveiling the surrounding chart in one ritual sweep. Sites sit on the tall
// props already in the world: each port's lighthouse/fort high point plus the
// Mistral Rock light. Which viewpoints have been surveyed is persisted in
// ctx.state.data.viewpoints (a list of names) so it survives a save/load, and
// is re-synced fresh on every 'game:start'. Zero per-frame allocation: the hot
// path is scalar distance math only; Vector3s are built once at world start.
import * as THREE from 'three';
import { TAU } from '../core/utils.js';

const SURVEY_RADIUS = 3000;   // islands within this of a viewpoint get charted
                              // (island nearest-neighbour spacing runs ~2000-2700m,
                              // so this reveals a viewpoint's 2-4 surrounding shores)
const TRIGGER_RADIUS = 82;    // how close (horizontally) to prompt the survey
const SURVEY_BOUNTY = 15;     // sovereigns per newly-charted landmark

export class Viewpoints {
  constructor(ctx) {
    this.ctx = ctx;
    this.sites = null;        // [{ name, islandId, position:Vector3, radius, synced }]
    this.surveyRadius = SURVEY_RADIUS; // read by the chart to draw revealed extents
    this._promptOn = false;
    ctx.events?.on('game:start', () => this._onGameStart());
  }

  // Locate the highest walkable point near an island's heart — the lighthouse
  // hill / fort rise the player climbs to. Deterministic grid sample; build-time
  // only, so allocating a Vector3 here is fine.
  _highPoint(world, isl) {
    const field = world.field;
    const c = isl.center;
    let bx = c.x, bz = c.z, bh = -Infinity;
    for (let i = 0; i < 48; i++) {
      const ang = (i / 48) * TAU;
      for (let rr = 0.12; rr <= 0.6; rr += 0.16) {
        const x = c.x + Math.cos(ang) * isl.radius * rr;
        const z = c.z + Math.sin(ang) * isl.radius * rr;
        const h = field?.heightAt?.(x, z) ?? 0;
        if (h > bh) { bh = h; bx = x; bz = z; }
      }
    }
    const y = world.getWalkHeight?.(bx, bz) ?? bh;
    return new THREE.Vector3(bx, y, bz);
  }

  // Build the stable list of viewpoint sites from the finished world. Runs once
  // (islands never move); only the synced flags are reset between games.
  _build() {
    const world = this.ctx.world;
    if (!world || !Array.isArray(world.islands)) return;
    this.sites = [];
    for (const isl of world.islands) {
      if (!isl?.def) continue;
      const isMistral = isl.def.id === 'mistralrock';
      // every port has a lighthouse/fort high point; Mistral Rock has its light
      if (!isl.port && !isMistral) continue;
      const label = isMistral ? 'Mistral Rock' : (isl.port?.name ?? isl.def.name);
      this.sites.push({
        name: `${label} Heights`,
        islandId: isl.def.id,
        position: this._highPoint(world, isl),
        radius: TRIGGER_RADIUS,
        synced: false,
      });
    }
  }

  _applyPersisted() {
    const list = this.ctx.state?.data?.viewpoints;
    if (!this.sites || !Array.isArray(list)) return;
    for (const s of this.sites) if (list.includes(s.name)) s.synced = true;
  }

  _onGameStart() {
    // state is already reset/loaded at this point; re-key the synced flags
    if (!Array.isArray(this.ctx.state?.data?.viewpoints)) {
      if (this.ctx.state?.data) this.ctx.state.data.viewpoints = [];
    }
    if (!this.sites) this._build();
    if (this.sites) for (const s of this.sites) s.synced = false;
    this._applyPersisted();
    this._clearPrompt();
  }

  _clearPrompt() {
    if (!this._promptOn) return;
    this._promptOn = false;
    this.ctx.events?.emit('prompt', { id: 'viewpoint', text: null });
  }

  // Read the horizon: chart every island centred within SURVEY_RADIUS.
  _survey(vp) {
    const ctx = this.ctx;
    vp.synced = true;
    this._clearPrompt();
    const persisted = (ctx.state.data.viewpoints ??= []);
    if (!persisted.includes(vp.name)) persisted.push(vp.name);

    const discovered = (ctx.state.data.discovered ??= []);
    let revealed = 0;
    for (const isl of ctx.world?.islands ?? []) {
      if (!isl?.def) continue;
      const dx = isl.center.x - vp.position.x, dz = isl.center.z - vp.position.z;
      if (Math.hypot(dx, dz) > SURVEY_RADIUS) continue;
      const id = isl.def.id;
      if (discovered.includes(id)) continue;
      discovered.push(id);
      ctx.events?.emit('island:discovered', { island: isl });
      revealed++;
    }

    if (revealed > 0) {
      ctx.events?.emit('toast', {
        text: `Surveyed from ${vp.name} — ${revealed} new shore${revealed === 1 ? '' : 's'} charted.`,
        kind: 'discover',
      });
      ctx.state.addLog?.(`Climbed ${vp.name} and read the whole horizon — ${revealed} new shore${revealed === 1 ? '' : 's'} inked onto the chart.`);
      ctx.state.addGold?.(revealed * SURVEY_BOUNTY);
    } else {
      ctx.events?.emit('toast', { text: `Surveyed from ${vp.name}. These waters are already yours.`, kind: 'info' });
      ctx.state.addLog?.(`Stood atop ${vp.name}. Every shore in sight was already on the chart.`);
    }
    ctx.effects?.sparks?.(vp.position, 10);
  }

  update(dt) {
    const ctx = this.ctx;
    // build lazily the first time the world is ready (survives boot ordering)
    if (!this.sites) {
      this._build();
      this._applyPersisted();
    }
    if (!this.sites || !this.sites.length) return;
    if (ctx.time?.paused || ctx.mode === 'menu') { this._clearPrompt(); return; }

    // player anchor: the captain on foot, or the ship at the helm
    let px, pz;
    if (ctx.mode === 'foot') {
      const c = ctx.character;
      if (!c?.position || c.alive === false) { this._clearPrompt(); return; }
      px = c.position.x; pz = c.position.z;
    } else if (ctx.mode === 'sail') {
      const g = ctx.playerShip?.ship?.group?.position;
      if (!g) { this._clearPrompt(); return; }
      px = g.x; pz = g.z;
    } else {
      this._clearPrompt();
      return;
    }

    // nearest un-surveyed viewpoint within reach (horizontal distance)
    let near = null, nd = Infinity;
    for (const s of this.sites) {
      if (s.synced) continue;
      const dx = s.position.x - px, dz = s.position.z - pz;
      const d = Math.hypot(dx, dz);
      if (d < s.radius && d < nd) { nd = d; near = s; }
    }

    if (near) {
      this._promptOn = true;
      ctx.events?.emit('prompt', { id: 'viewpoint', text: `E — Survey from ${near.name}` });
      if (ctx.input?.wasPressed?.('KeyE')) this._survey(near);
    } else {
      this._clearPrompt();
    }
  }
}
