// The crew: hiring, morale, wages, role bonuses, boarding actions.
import { clamp, mulberry32, randRange, randInt } from '../core/utils.js';

const ROLES = ['quartermaster', 'gunner', 'carpenter', 'cook', 'surgeon', 'navigator', 'boatswain', 'sailmaster'];

export class Crew {
  constructor(ctx) {
    this.ctx = ctx;
    this._lastDay = -1;
    this._candidates = new Map(); // portName -> {day, list}

    ctx.events?.on('game:start', ({ fresh }) => {
      if (fresh || !(ctx.state.data.crew?.length)) this._starterCrew();
    });
    ctx.events?.on('boarding:accept', ({ ship }) => {
      // Prefer the playable melee set-piece; fall back to the abstract resolve
      // if the boarding system or an on-foot fight isn't available.
      if (this.ctx.boarding?.canBoard?.(ship)) this.ctx.boarding.begin(ship);
      else this._resolveBoarding(ship);
    });
    ctx.events?.on('ship:sunk', ({ byPlayer }) => {
      if (byPlayer) this._moraleAll(6, 'a prize taken');
    });
    ctx.events?.on('ship:dock', () => this._moraleAll(4));
  }

  get roster() {
    return this.ctx.state?.data?.crew ?? [];
  }

  _makeHand(rng, roleHint) {
    const names = this.ctx.data.names;
    return {
      name: names.crewName(rng),
      role: roleHint ?? ROLES[randInt(rng, 0, ROLES.length - 1)],
      skill: randInt(rng, 1, 5),
      morale: randInt(rng, 55, 85),
      wage: 0,
      story: names.crewStory(rng),
    };
  }

  _starterCrew() {
    const rng = mulberry32(777);
    const crew = [];
    for (const role of ['quartermaster', 'gunner', 'carpenter', 'cook']) {
      const hand = this._makeHand(rng, role);
      hand.skill = randInt(rng, 2, 3);
      hand.wage = 2 + hand.skill;
      crew.push(hand);
    }
    this.ctx.state.data.crew = crew;
  }

  _bestSkill(role) {
    let best = 0;
    for (const hand of this.roster) {
      if (hand.role === role && hand.skill > best) best = hand.skill;
    }
    return best;
  }

  reloadBonus() { return 1 + this._bestSkill('gunner') * 0.06; }
  repairBonus() { return this._bestSkill('carpenter') * 0.12; }   // hull/s at sea
  regenBonus() { return 1 + this._bestSkill('surgeon') * 0.15; }
  speedBonus() { return 1 + this._bestSkill('navigator') * 0.016; }
  moraleAvg() {
    const r = this.roster;
    if (!r.length) return 60;
    return r.reduce((sum, h) => sum + h.morale, 0) / r.length;
  }

  boardingStrength() {
    let s = (this.ctx.state?.data?.level ?? 1) * 2;
    for (const hand of this.roster) s += hand.skill;
    s *= this.ctx.progression?.getMod?.('boarding') ?? 1;
    s *= 0.7 + (this.moraleAvg() / 100) * 0.6;
    return s;
  }

  candidatesFor(portName) {
    const day = Math.floor(this.ctx.time.t / this.ctx.time.dayLength);
    const cached = this._candidates.get(portName);
    if (cached && cached.day === day) return cached.list.filter((c) => !c.hired);
    const island = this.ctx.data.islands.find((i) => i.port?.name === portName);
    const rng = mulberry32((island?.seed ?? 1) * 31 + day);
    const n = island?.port?.size === 'capital' ? 5 : island?.port?.size === 'village' ? 3 : 4;
    const list = [];
    for (let i = 0; i < n; i++) {
      const hand = this._makeHand(rng);
      hand.cost = 40 + hand.skill * 28;
      hand.wage = 2 + hand.skill;
      list.push(hand);
    }
    this._candidates.set(portName, { day, list });
    return list.filter((c) => !c.hired);
  }

  hire(candidate) {
    const ctx = this.ctx;
    const max = ctx.playerShip?.ship?.type?.crewMax ?? 8;
    if (candidate.hired) return { ok: false, why: 'Already signed on' };
    if (this.roster.length >= max) return { ok: false, why: 'Ship berths are full' };
    if ((ctx.state.data.gold ?? 0) < candidate.cost) return { ok: false, why: 'Not enough gold' };
    ctx.state.addGold(-candidate.cost);
    candidate.hired = true; // remove from the tavern's list so it can't be re-hired
    const { cost, hired, ...hand } = candidate;
    this.roster.push(hand);
    ctx.state.addLog(`Signed ${hand.name} aboard as ${hand.role}.`);
    ctx.events?.emit('crew:change', {});
    return { ok: true };
  }

  dismiss(index) {
    const hand = this.roster[index];
    if (!hand) return;
    this.roster.splice(index, 1);
    this.ctx.state.addLog(`Paid off ${hand.name}. Fair winds to them.`);
    this.ctx.events?.emit('crew:change', {});
  }

  _moraleAll(delta, why) {
    for (const hand of this.roster) hand.morale = clamp(hand.morale + delta, 0, 100);
    if (why && delta > 0) this.ctx.state.addLog(`Crew spirits lifted — ${why}.`);
  }

  // Abstract (dice-roll) boarding — used only when the playable melee can't run.
  _resolveBoarding(ship) {
    const ours = this.boardingStrength();
    const theirs = (ship?.crewCount ?? 8) * 1.6 * (0.5 + (ship?.hull ?? 1) / Math.max(ship?.hullMax ?? 1, 1));
    const p = ours / (ours + theirs);
    const victory = Math.random() < clamp(p, 0.15, 0.95);
    this.applyBoardingOutcome(ship, victory);
  }

  /** Book the result of a boarding (loot, casualties, morale, log, event).
   *  Called by the playable melee with a decided outcome, or by the dice roll.
   *  `heavy` losses (a hard-fought or lost fight) claim more of the crew. */
  applyBoardingOutcome(ship, victory, { heavy = false } = {}) {
    const ctx = this.ctx;
    const casualties = [];
    const roster = this.roster;
    const losses = victory
      ? (Math.random() < (heavy ? 0.7 : 0.35) ? 1 : 0)
      : randInt(Math.random, 1, Math.min(heavy ? 3 : 2, roster.length));
    for (let i = 0; i < losses && roster.length > 1; i++) {
      const idx = Math.floor(Math.random() * roster.length);
      casualties.push(roster[idx].name);
      roster.splice(idx, 1);
    }
    let lootGold = 0;
    if (victory) {
      lootGold = Math.round((ship?.type?.cost ?? 900) * randRange(Math.random, 0.06, 0.12));
      lootGold = Math.round(lootGold * (ctx.progression?.getMod?.('goldFind') ?? 1));
      ctx.state.addGold(lootGold);
      this._moraleAll(8, 'a deck taken sword-in-hand');
      ctx.state.addLog(`Boarded ${ship?.name ?? 'a prize'} — ${lootGold} sovereigns in the strongbox.`);
    } else {
      this._moraleAll(-10);
      ctx.state.addLog(`Repelled at ${ship?.name ?? 'a prize'}. ${casualties.join(', ') || 'No one'} lost.`);
    }
    ctx.events?.emit('boarding:resolve', { victory, lootGold, casualties, ship });
    ctx.events?.emit('crew:change', {});
  }

  update(dt) {
    const ctx = this.ctx;
    if (ctx.mode === 'menu') return;

    // daily wages & upkeep
    const day = Math.floor(ctx.time.t / ctx.time.dayLength);
    if (day !== this._lastDay) {
      this._lastDay = day;
      if (day > 0) this._payday();
    }

    // carpenter patches the hull at sea
    const ship = ctx.playerShip?.ship;
    if (ship?.alive && !ship.sinking && ctx.mode === 'sail') {
      const repair = this.repairBonus();
      if (repair > 0 && ship.hull < ship.hullMax) {
        ship.hull = Math.min(ship.hullMax, ship.hull + repair * dt);
      }
    }

    // storms grind everyone down a little
    if (ctx.weather?.condition === 'storm' && Math.random() < dt * 0.02) {
      this._moraleAll(-1);
    }
  }

  _payday() {
    const ctx = this.ctx;
    let bill = 0;
    for (const hand of this.roster) bill += hand.wage;
    if (bill === 0) return;
    if ((ctx.state.data.gold ?? 0) >= bill) {
      ctx.state.addGold(-bill);
      ctx.state.addLog(`Paid the crew: ${bill} sovereigns.`);
      const cook = this._bestSkill('cook');
      this._moraleAll(1 + cook);
    } else {
      this._moraleAll(-15);
      ctx.events?.emit('toast', { text: "Couldn't make payday — the crew grumbles.", kind: 'warn' });
      ctx.state.addLog('Missed payday. The forecastle has gone quiet and sharp.');
    }
    // desertion check
    for (let i = this.roster.length - 1; i >= 0; i--) {
      if (this.roster[i].morale < 25 && Math.random() < 0.4) {
        const hand = this.roster.splice(i, 1)[0];
        ctx.events?.emit('toast', { text: `${hand.name} has deserted!`, kind: 'warn' });
        ctx.state.addLog(`${hand.name} slipped ashore in the night. Can't say I blame them.`);
      }
    }
  }
}
