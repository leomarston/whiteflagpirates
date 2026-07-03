// Quests: the Pale Accord chapters + seeded port side-contracts.
import { mulberry32, pick, randInt } from '../core/utils.js';

export class Quests {
  constructor(ctx) {
    this.ctx = ctx;
    this._sideCache = new Map();

    ctx.events?.on('game:start', ({ fresh }) => {
      const q = this.state();
      if (fresh || (!q.active.length && !q.completed.length)) {
        this.accept('ch1', true);
      }
    });
    ctx.events?.on('ship:sunk', ({ ship, byPlayer }) => {
      if (byPlayer && ship) this._progress('sink', { faction: this._factionOf(ship) });
    });
    ctx.events?.on('island:discovered', ({ island }) => {
      this._progress('visit', { islandId: island.def.id });
    });
    ctx.events?.on('treasure:dug', () => this._progress('dig', {}));
    ctx.events?.on('npc:interact', ({ npc }) => {
      this._progress('talk', { role: npc.role, port: npc.portName });
    });
    ctx.events?.on('ship:dock', ({ port }) => {
      this._progress('deliver-check', { port: port.name });
    });
  }

  state() { return this.ctx.state.data.quests; }

  _factionOf(ship) {
    // side quests treat corsair AI ships as 'pirate'
    if (ship.faction === 'corsairs' && !ship.isPlayer) return 'pirate';
    return ship.faction;
  }

  _allDefs() {
    const defs = new Map();
    for (const ch of this.ctx.data.quests.chapters) defs.set(ch.id, ch);
    for (const [id, def] of this._sideCache) defs.set(id, def);
    return defs;
  }

  find(id) {
    return this._allDefs().get(id) ??
      this.state().sideDefs?.find?.((d) => d.id === id) ?? null;
  }

  /** Quests offered at a port right now (chapter first, then sides). */
  available(portName) {
    const island = this.ctx.data.islands.find((i) => i.port?.name === portName);
    if (!island) return [];
    const q = this.state();
    const out = [];

    for (const ch of this.ctx.data.quests.chapters) {
      if (q.completed.includes(ch.id) || q.active.includes(ch.id)) continue;
      const prevDone = !ch.chapter || ch.chapter === 1 ||
        q.completed.includes(`ch${ch.chapter - 1}`);
      if (prevDone && ch.giver === island.id) out.push(ch);
    }

    // seeded side quests, refreshed daily
    const day = Math.floor(this.ctx.time.t / this.ctx.time.dayLength);
    const key = `${portName}:${day}`;
    if (!this._sideCache.has(key)) {
      const rng = mulberry32(island.seed * 13 + day);
      const sides = [];
      const templates = this.ctx.data.quests.sideTemplates;
      for (let i = 0; i < 2; i++) {
        const t = pick(rng, templates);
        const otherIsl = pick(rng, this.ctx.data.islands.filter((isl) => isl.id !== island.id));
        const id = `${t.id}:${key}:${i}`;
        const objective = { ...t.objective };
        if (objective.type === 'deliver') objective.toPort = portName;
        const def = {
          ...t, id, side: true,
          title: t.title,
          giver: island.id,
          text: t.textTemplate
            .replace('{island}', otherIsl.name)
            .replace('{port}', portName)
            .replace('{qty}', String(objective.qty ?? '')),
          objective,
          rewards: { ...t.rewards, gold: Math.round((t.rewards.gold || 100) * (0.8 + rng() * 0.5)) },
        };
        sides.push(def);
        this._sideCache.set(id, def);
      }
      this._sideCache.set(key, sides);
    }
    for (const def of this._sideCache.get(key)) {
      if (!this.state().active.includes(def.id) && !this.state().completed.includes(def.id)) {
        out.push(def);
      }
    }
    return out;
  }

  accept(id, silent = false) {
    const def = this.find(id) ?? this.ctx.data.quests.chapters.find((c) => c.id === id);
    if (!def) return false;
    const q = this.state();
    if (q.active.includes(id)) return false;
    q.active.push(id);
    q.progress[id] = 0;
    if (def.side) {
      (q.sideDefs ??= []).push(def); // persist generated defs
    }
    if (!silent) {
      this.ctx.events?.emit('toast', { text: `Quest accepted — ${def.title}`, kind: 'info' });
    }
    this.ctx.events?.emit('quest:accept', { quest: def });
    this.ctx.state.addLog(`Took on "${def.title}".`);
    // credit a 'visit' objective immediately if the island is already charted —
    // 'island:discovered' is one-shot and would otherwise never re-fire (softlock)
    if (def.objective?.type === 'visit' &&
      (this.ctx.state.data.discovered ?? []).includes(def.objective.islandId)) {
      this._progress('visit', { islandId: def.objective.islandId });
    }
    return true;
  }

  activeDefs() {
    return this.state().active.map((id) => this.find(id)).filter(Boolean);
  }

  objectiveText(def) {
    const o = def.objective;
    const q = this.state();
    const p = q.progress[def.id] ?? 0;
    switch (o.type) {
      case 'sink': return `Sink ${o.faction === 'crown' ? 'Crown' : o.faction} ships (${p}/${o.count})`;
      case 'visit': {
        const isl = this.ctx.data.islands.find((i) => i.id === o.islandId);
        return `Make landfall at ${isl?.name ?? o.islandId}`;
      }
      case 'deliver': {
        const good = this.ctx.data.goods.find((g) => g.key === o.good);
        return `Deliver ${o.qty}× ${good?.name ?? o.good} to ${o.toPort}`;
      }
      case 'dig': return 'Dig up a buried treasure';
      case 'talk': return `Speak with the ${o.role} at ${o.port}`;
      default: return def.title;
    }
  }

  isComplete(def) {
    const o = def.objective;
    const p = this.state().progress[def.id] ?? 0;
    if (o.type === 'sink') return p >= o.count;
    if (o.type === 'deliver') {
      // completable at the right port with the goods aboard
      return p >= 1;
    }
    return p >= 1;
  }

  _progress(kind, info) {
    const q = this.state();
    for (const id of [...q.active]) {
      const def = this.find(id);
      if (!def) continue;
      const o = def.objective;
      let hit = false;
      if (kind === 'sink' && o.type === 'sink' && (o.faction === info.faction)) hit = true;
      if (kind === 'visit' && o.type === 'visit' && o.islandId === info.islandId) hit = true;
      if (kind === 'dig' && o.type === 'dig') hit = true;
      if (kind === 'talk' && o.type === 'talk' && o.role === info.role &&
        (!o.port || o.port === info.port)) hit = true;
      if (kind === 'deliver-check' && o.type === 'deliver' && o.toPort === info.port) {
        const cargo = this.ctx.state.data.cargo ?? {};
        if ((cargo[o.good] ?? 0) >= o.qty) {
          cargo[o.good] -= o.qty;
          if (cargo[o.good] <= 0) delete cargo[o.good];
          hit = true;
        }
      }
      if (!hit) continue;
      q.progress[id] = (q.progress[id] ?? 0) + 1;
      if (this.isComplete(def)) this._complete(def);
      else this.ctx.events?.emit('toast', { text: `${def.title}: ${this.objectiveText(def)}`, kind: 'info' });
    }
  }

  _complete(def) {
    const ctx = this.ctx;
    const q = this.state();
    const i = q.active.indexOf(def.id);
    if (i >= 0) q.active.splice(i, 1);
    q.completed.push(def.id);

    const r = def.rewards ?? {};
    if (r.gold) ctx.state.addGold(r.gold);
    if (r.xp) ctx.progression?.addXp?.(r.xp);
    for (const [f, d] of Object.entries(r.rep ?? {})) ctx.progression?.addRep?.(f, d);

    ctx.events?.emit('quest:complete', { quest: def });
    ctx.events?.emit('toast', {
      text: `Quest complete — ${def.title}${r.gold ? ` (+${r.gold}s)` : ''}`,
      kind: 'discover',
    });
    ctx.state.addLog(`Finished "${def.title}". The Verge takes note.`);

    if (def.next) {
      // the next chapter waits at its giver's port
      const next = this.ctx.data.quests.chapters.find((c) => c.id === def.next);
      if (next) {
        const giverIsland = this.ctx.data.islands.find((isl) => isl.id === next.giver);
        ctx.events?.emit('toast', {
          text: `Word waits for you at ${giverIsland?.port?.name ?? next.giver}…`, kind: 'info',
        });
      }
    }
  }

  turnIn() { /* completion is automatic on objective */ }

  update() { /* event-driven */ }
}
