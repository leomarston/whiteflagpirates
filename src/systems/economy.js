// Dynamic port economies: supply/demand pricing, trading, contraband risk.
import { ECONOMY } from '../core/constants.js';
import { clamp, mulberry32, randRange } from '../core/utils.js';
import { BIOME_ECONOMY, SIZE_STOCK } from '../data/goods.js';

export class Economy {
  constructor(ctx) {
    this.ctx = ctx;
    this._nudges = [];   // {portName, key?, mult, until}

    ctx.events?.on('ship:sunk', ({ ship }) => {
      // a lost merchant tightens nearby markets
      if (ship?.faction === 'concern') {
        const near = ctx.world?.getNearestPort?.(ship.position);
        if (near && near.distance < 2500) {
          this._nudges.push({ portName: near.port.name, mult: 1.08, until: ctx.time.t + 180 });
        }
      }
    });
  }

  _islandFor(portName) {
    return this.ctx.data.islands.find((i) => i.port?.name === portName);
  }

  /** Stable-ish market listing for a port. Prices drift over game time. */
  getMarket(portName) {
    const ctx = this.ctx;
    const island = this._islandFor(portName);
    if (!island) return [];
    const eco = BIOME_ECONOMY[island.biome] ?? { produces: [], demands: [] };
    const rng = mulberry32(island.seed + Math.floor(ctx.time.t / 240));
    const t = ctx.time.t;
    const out = [];
    for (const good of ctx.data.goods) {
      let price = good.basePrice;
      if (eco.produces.includes(good.key)) price *= randRange(rng, 0.55, 0.72);
      else if (eco.demands.includes(good.key)) price *= randRange(rng, 1.35, 1.8);
      else price *= randRange(rng, 0.9, 1.15);
      // slow sine drift so revisits feel alive
      price *= 1 + Math.sin(t * 0.004 + good.basePrice) * ECONOMY.PRICE_DRIFT * 0.5;
      for (const n of this._nudges) {
        if (n.portName === portName && n.until > t && (!n.key || n.key === good.key)) price *= n.mult;
      }
      // freetrader skill: better prices
      const edge = (this.ctx.progression?.getMod?.('priceEdge') ?? 1);
      const buy = Math.max(2, Math.round(price / edge));
      const sell = Math.max(1, Math.round(price * ECONOMY.SELL_MARGIN * edge));
      const contrabandHere = good.contraband && island.faction === 'crown';
      out.push({
        key: good.key,
        name: good.name,
        base: good.basePrice,
        buy, sell,
        stock: SIZE_STOCK[island.port.size] ?? 30,
        contraband: contrabandHere,
        weight: good.weight,
      });
    }
    return out;
  }

  cargoUsed() {
    const cargo = this.ctx.state?.data?.cargo ?? {};
    let used = 0;
    for (const [key, qty] of Object.entries(cargo)) {
      const good = this.ctx.data.goods.find((g) => g.key === key);
      used += (good?.weight ?? 1) * qty;
    }
    return used;
  }

  cargoCapacity() {
    const cap = this.ctx.playerShip?.ship?.type?.cargoCapacity ?? 30;
    return Math.round(cap * (this.ctx.progression?.getMod?.('cargoBonus') ?? 1));
  }

  buy(portName, key, qty = 1) {
    const ctx = this.ctx;
    const item = this.getMarket(portName).find((i) => i.key === key);
    if (!item) return { ok: false, why: 'No such good' };
    const cost = item.buy * qty;
    if ((ctx.state?.data?.gold ?? 0) < cost) return { ok: false, why: 'Not enough gold' };
    if (this.cargoUsed() + item.weight * qty > this.cargoCapacity()) return { ok: false, why: 'Hold is full' };
    ctx.state.addGold(-cost);
    const cargo = ctx.state.data.cargo;
    cargo[key] = (cargo[key] ?? 0) + qty;
    ctx.events?.emit('trade', { portName, key, qty, gold: -cost, kind: 'buy' });
    return { ok: true };
  }

  sell(portName, key, qty = 1) {
    const ctx = this.ctx;
    const cargo = ctx.state?.data?.cargo ?? {};
    qty = Math.min(qty, cargo[key] ?? 0);
    if (qty <= 0) return { ok: false, why: 'Nothing to sell' };
    const item = this.getMarket(portName).find((i) => i.key === key);
    if (!item) return { ok: false, why: 'No market' };
    const earn = item.sell * qty;
    cargo[key] -= qty;
    if (cargo[key] <= 0) delete cargo[key];
    ctx.state.addGold(earn);
    ctx.events?.emit('trade', { portName, key, qty, gold: earn, kind: 'sell' });

    // fencing contraband under the Crown's nose
    if (item.contraband && Math.random() < 0.25) {
      ctx.progression?.addRep?.('crown', -8);
      ctx.events?.emit('guards:aggro', {});
      ctx.events?.emit('toast', { text: 'Customs spotted the contraband — guards alerted!', kind: 'warn' });
    }
    return { ok: true, earn };
  }

  update() { /* markets are computed lazily */ }
}
