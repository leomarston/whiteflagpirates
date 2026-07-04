// Dynamic world encounters: convoys, patrols, castaways, bottles, whales.
import { pick, randRange } from '../core/utils.js';

const ENCOUNTERS = [
  { key: 'convoy', weight: 3 },
  { key: 'patrol', weight: 3 },
  { key: 'rival', weight: 3 },
  { key: 'bottle', weight: 2 },
  { key: 'cargo', weight: 3 },
  { key: 'castaway', weight: 2 },
  { key: 'whales', weight: 2 },
];

export class Encounters {
  constructor(ctx) {
    this.ctx = ctx;
    this._timer = 50;
    // periodic, low-frequency nudge for the legendary set-piece (the Ashen
    // Verdict). It self-gates on cooldown/threshold/open water, so we can poke
    // it liberally without spawning her often.
    this._legendTimer = randRange(Math.random, 90, 150);
  }

  _roll() {
    const total = ENCOUNTERS.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * total;
    for (const e of ENCOUNTERS) {
      r -= e.weight;
      if (r <= 0) return e.key;
    }
    return 'cargo';
  }

  _dropNear(contents) {
    const p = this.ctx.playerShip?.ship?.position;
    if (!p) return;
    const a = Math.random() * Math.PI * 2;
    const d = randRange(Math.random, 120, 300);
    this.ctx.events?.emit('spawn:loot', {
      pos: { x: p.x + Math.sin(a) * d, z: p.z + Math.cos(a) * d },
      contents,
    });
  }

  _fire(key) {
    const ctx = this.ctx;
    const events = ctx.events;
    const lore = ctx.data.lore;
    switch (key) {
      case 'convoy': {
        events?.emit('spawn:ship', { typeKey: 'merchantman', faction: 'concern', role: 'trade' });
        events?.emit('spawn:ship', { typeKey: 'cutter', faction: 'concern', role: 'trade' });
        events?.emit('toast', { text: 'Sails on the horizon — a Concern convoy, riding low.', kind: 'info' });
        break;
      }
      case 'patrol': {
        events?.emit('spawn:ship', { typeKey: Math.random() < 0.4 ? 'frigate' : 'sloop', faction: 'crown', role: 'patrol' });
        events?.emit('toast', { text: 'Crown colors to windward. Mind your flag.', kind: 'info' });
        break;
      }
      case 'rival': {
        events?.emit('spawn:ship', { typeKey: Math.random() < 0.5 ? 'brig' : 'sloop', faction: 'corsairs', role: 'pirate' });
        events?.emit('toast', { text: 'A rival crew is working these waters.', kind: 'warn' });
        break;
      }
      case 'bottle': {
        this._dropNear({ map: true });
        events?.emit('toast', { text: 'Something glints in the swell — a message bottle?', kind: 'discover' });
        break;
      }
      case 'cargo': {
        const good = pick(Math.random, ctx.data.goods);
        this._dropNear({ gold: Math.round(randRange(Math.random, 10, 40)), goods: { [good.key]: 1 + Math.floor(Math.random() * 3) } });
        events?.emit('toast', { text: 'Flotsam ahead — cargo adrift on the current.', kind: 'info' });
        break;
      }
      case 'castaway': {
        ctx.progression?.addXp?.(20);
        const rumor = pick(Math.random, lore.rumors);
        events?.emit('toast', { text: 'Pulled a castaway from a raft. They talk. A lot.', kind: 'discover' });
        setTimeout(() => events?.emit('toast', { text: `Castaway: “${rumor}”`, kind: 'info' }), 4000);
        ctx.state.addLog('Rescued a castaway. Paid in gratitude and gossip — the usual rate.');
        break;
      }
      case 'whales': {
        ctx.progression?.addXp?.(15);
        events?.emit('toast', { text: 'A whale pod breaches to starboard. The crew falls quiet.', kind: 'discover' });
        ctx.state.addLog('Whales alongside at dusk. Some wealth is not for spending.');
        break;
      }
    }
  }

  update(dt) {
    const ctx = this.ctx;
    if (ctx.mode !== 'sail' || ctx.time.paused) return;
    const p = ctx.playerShip?.ship?.position;
    if (!p) return;
    // only in open water
    const near = ctx.world?.getNearestPort?.(p);
    if (near && near.distance < 400) return;

    this._timer -= dt;
    if (this._timer <= 0) {
      this._timer = randRange(Math.random, 45, 85);
      this._fire(this._roll());
    }

    // rare rumour of the legendary hunter — additive, never displaces the
    // ordinary encounter roll above.
    this._legendTimer -= dt;
    if (this._legendTimer <= 0) {
      this._legendTimer = randRange(Math.random, 120, 210);
      if (Math.random() < 0.5) ctx.setpiece?.requestSpawn?.('rumour');
    }
  }
}
