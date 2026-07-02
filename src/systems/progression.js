// Progression: XP/levels, three skill branches, reputation, ship upgrades.
import { clamp } from '../core/utils.js';
import { SHIP_TYPES } from '../ship/shipTypes.js';

export const SKILLS = {
  corsair: {
    name: 'Corsair', color: '#7e2a1e',
    tiers: [
      { key: 'swordDamage1', name: 'Keen Edge', desc: '+15% sword damage', mod: { swordDamage: 1.15 } },
      { key: 'stamina1', name: 'Sea Legs', desc: '+25% stamina regen', mod: { staminaRegen: 1.25 } },
      { key: 'pistol1', name: 'Dead Eye', desc: '+50% pistol damage', mod: { pistolDamage: 1.5 } },
      { key: 'swordDamage2', name: 'Red Reputation', desc: '+30% sword damage', mod: { swordDamage: 1.3 } },
    ],
  },
  captain: {
    name: 'Captain', color: '#1e3a6e',
    tiers: [
      { key: 'reload1', name: 'Gun Drill', desc: '+15% reload speed', mod: { reloadSpeed: 1.15 } },
      { key: 'sail1', name: 'Trim Master', desc: '+6% ship speed', mod: { shipSpeed: 1.06 } },
      { key: 'hull1', name: 'Iron Ribs', desc: '+15% hull strength', mod: { hullMax: 1.15 } },
      { key: 'board1', name: 'Terror of the Verge', desc: '+35% boarding strength, +15% cannon damage', mod: { boarding: 1.35, cannonDamage: 1.15 } },
    ],
  },
  freetrader: {
    name: 'Freetrader', color: '#1d6f6d',
    tiers: [
      { key: 'price1', name: 'Sharp Tongue', desc: '4% better prices', mod: { priceEdge: 1.04 } },
      { key: 'cargo1', name: 'Clever Stowage', desc: '+20% cargo space', mod: { cargoBonus: 1.2 } },
      { key: 'gold1', name: 'Salvager', desc: '+20% found gold', mod: { goldFind: 1.2 } },
      { key: 'price2', name: 'The Ledger Answers', desc: '8% better prices', mod: { priceEdge: 1.08 } },
    ],
  },
};

const XP_SHIP = { cutter: 25, sloop: 30, brig: 50, merchantman: 45, frigate: 70, galleon: 90 };
const REP_LABELS = [
  [-100, 'Hunted'], [-50, 'Outlaw'], [-20, 'Distrusted'], [20, 'Neutral'],
  [50, 'Respected'], [80, 'Honored'], [101, 'Legend'],
];

export class Progression {
  constructor(ctx) {
    this.ctx = ctx;
    this.SKILLS = SKILLS; // exposed for the UI via ctx.progression
    this._hunterTimer = 240;
    this._hunterLive = false;

    ctx.events?.on('ship:sunk', ({ ship, byPlayer }) => {
      if (!byPlayer || !ship || ship.isPlayer) return;
      this.addXp(XP_SHIP[ship.typeKey] ?? 40);
      if (ship.faction === 'crown') this.addRep('crown', -6), this.addRep('corsairs', 4);
      if (ship.faction === 'concern') this.addRep('concern', -6), this.addRep('corsairs', 2);
      if (ship.faction === 'corsairs') this.addRep('corsairs', -8);
      if (ship._brainRole === 'hunter') this._hunterLive = false;
    });
    ctx.events?.on('npc:killed', () => this.addXp(8));
    ctx.events?.on('island:discovered', () => this.addXp(30));
    ctx.events?.on('treasure:dug', () => this.addXp(25));
  }

  levelFor(xp) { return 1 + Math.floor(Math.sqrt(xp / 90)); }
  xpForLevel(level) { return Math.pow(level - 1, 2) * 90; }

  addXp(n) {
    const d = this.ctx.state.data;
    d.xp += Math.round(n);
    const newLevel = this.levelFor(d.xp);
    while (newLevel > d.level) {
      d.level++;
      d.skillPoints++;
      this.ctx.events?.emit('level:up', { level: d.level });
      this.ctx.events?.emit('toast', { text: `Level ${d.level}! Skill point earned (K).`, kind: 'discover' });
    }
  }

  addRep(faction, delta) {
    const rep = this.ctx.state.data.reputation;
    if (!(faction in rep)) return;
    rep[faction] = clamp(rep[faction] + delta, -100, 100);
    this.ctx.events?.emit('rep:change', { faction, value: rep[faction] });
  }

  repLabel(value) {
    for (const [max, label] of REP_LABELS) {
      if (value < max) return label;
    }
    return 'Legend';
  }

  /** Product of all unlocked skill modifiers for a key (default 1). */
  getMod(key) {
    const skills = this.ctx.state.data.skills ?? {};
    let mod = 1;
    for (const branch of Object.values(SKILLS)) {
      for (const tier of branch.tiers) {
        if (skills[tier.key] && tier.mod[key]) mod *= tier.mod[key];
      }
    }
    if (key === 'shipSpeed') return mod;
    return mod;
  }

  canUnlock(branchKey, tierIdx) {
    const d = this.ctx.state.data;
    const branch = SKILLS[branchKey];
    if (!branch || d.skillPoints < 1) return false;
    const tier = branch.tiers[tierIdx];
    if (!tier || d.skills[tier.key]) return false;
    // must own the previous tier
    return tierIdx === 0 || !!d.skills[branch.tiers[tierIdx - 1].key];
  }

  unlock(branchKey, tierIdx) {
    if (!this.canUnlock(branchKey, tierIdx)) return false;
    const d = this.ctx.state.data;
    const tier = SKILLS[branchKey].tiers[tierIdx];
    d.skills[tier.key] = true;
    d.skillPoints--;
    this.ctx.events?.emit('toast', { text: `Learned: ${tier.name}`, kind: 'discover' });
    this.ctx.events?.emit('ship:upgraded', {}); // refresh derived stats
    return true;
  }

  /** Shipwright catalog. */
  getUpgradeOffers() {
    const ctx = this.ctx;
    const shipData = ctx.state.data.ship;
    const ship = ctx.playerShip?.ship;
    const offers = { repair: null, tiers: [], ships: [], paints: [] };

    if (ship && ship.hull < ship.hullMax) {
      offers.repair = { cost: Math.ceil((ship.hullMax - ship.hull) * 1.5), amount: ship.hullMax - ship.hull };
    }
    const tierPrices = [0, 600, 1600];
    for (const [key, label] of [['hullTier', 'Reinforced Hull'], ['sailTier', 'Fine Sailcloth'], ['cannonTier', 'Bored Cannon']]) {
      const cur = shipData[key] ?? 1;
      if (cur < 3) {
        offers.tiers.push({
          key, label, current: cur, next: cur + 1, cost: tierPrices[cur],
        });
      }
    }
    for (const type of Object.values(SHIP_TYPES)) {
      if (type.key !== shipData.type) {
        offers.ships.push({ type, cost: type.cost });
      }
    }
    offers.paints = ['default', 'storm', 'pearl', 'blood'].filter((p) => p !== shipData.paint)
      .map((p) => ({ key: p, cost: 120 }));
    return offers;
  }

  applyUpgrade(kind, key) {
    const ctx = this.ctx;
    const d = ctx.state.data;
    const offers = this.getUpgradeOffers();

    if (kind === 'repair' && offers.repair) {
      if (d.gold < offers.repair.cost) return { ok: false, why: 'Not enough gold' };
      ctx.state.addGold(-offers.repair.cost);
      const ship = ctx.playerShip.ship;
      ship.hull = ship.hullMax;
      d.ship.hull = ship.hull;
      ctx.events?.emit('toast', { text: 'Hull repaired to full.', kind: 'info' });
      return { ok: true };
    }
    if (kind === 'tier') {
      const offer = offers.tiers.find((t) => t.key === key);
      if (!offer) return { ok: false, why: 'Nothing to upgrade' };
      if (d.gold < offer.cost) return { ok: false, why: 'Not enough gold' };
      ctx.state.addGold(-offer.cost);
      d.ship[key] = offer.next;
      ctx.events?.emit('ship:upgraded', {});
      ctx.events?.emit('toast', { text: `${offer.label} — tier ${offer.next}.`, kind: 'info' });
      return { ok: true };
    }
    if (kind === 'ship') {
      const offer = offers.ships.find((s) => s.type.key === key);
      if (!offer) return { ok: false, why: 'Not for sale' };
      if (d.gold < offer.cost) return { ok: false, why: 'Not enough gold' };
      ctx.state.addGold(-offer.cost);
      d.ship.type = key;
      d.ship.hull = null;
      d.ship.hullTier = 1; d.ship.sailTier = 1; d.ship.cannonTier = 1;
      ctx.events?.emit('ship:changed', {});
      ctx.events?.emit('toast', { text: `She's yours, Captain — a fine ${offer.type.name}.`, kind: 'discover' });
      ctx.state.addLog(`Took command of a ${offer.type.name}. The old girl earned her rest.`);
      return { ok: true };
    }
    if (kind === 'paint') {
      if (d.gold < 120) return { ok: false, why: 'Not enough gold' };
      ctx.state.addGold(-120);
      d.ship.paint = key;
      ctx.events?.emit('ship:changed', {});
      return { ok: true };
    }
    return { ok: false, why: 'Unknown upgrade' };
  }

  update(dt) {
    const ctx = this.ctx;
    if (ctx.mode === 'menu') return;
    // Crown hunters when deeply wanted
    if ((ctx.state.data.reputation.crown ?? 0) <= -50 && !this._hunterLive) {
      this._hunterTimer -= dt;
      if (this._hunterTimer <= 0) {
        this._hunterTimer = 240;
        this._hunterLive = true;
        ctx.events?.emit('spawn:ship', { role: 'hunter', faction: 'crown', typeKey: 'frigate' });
        ctx.events?.emit('toast', { text: 'The Crown has posted hunters on your wake!', kind: 'warn' });
        ctx.state.addLog('A hunter flies the Crown blue on the horizon. Flattered, honestly.');
      }
    }
  }
}
