// Playable boarding melee — the signature set-piece. When a crippled enemy is
// boarded, instead of an abstract dice-roll we lash the ships together, drop the
// captain onto the prize's deck on foot, and fight her surviving crew hand-to-hand
// with the full sword combat. Win by clearing her deck; lose by being beaten back.
//
// It reuses everything already in the game: a transient walk-surface registered
// with the world (so the foot controller and NPCs stand on the deck), the NPC
// hostile brain (ctx.npcs.spawnHostile), the on-foot SwordCombat, and the crew
// system's outcome bookkeeping (ctx.crew.applyBoardingOutcome).
import * as THREE from 'three';
import { clamp } from '../core/utils.js';

// module scratch — never allocate per frame
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _mid = new THREE.Vector3();

const DEFEAT_HP_FRAC = 0.30;   // beaten back before the captain can actually fall
const HOSTILE_DMG = [5, 8];    // capped so no single blow can drop the captain to 0
const MAX_HOSTILES = 5;
const BOARD_TIMEOUT = 110;     // s — safety valve so a fight can't hang forever

export class Boarding {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false;
    this.ship = null;          // the enemy Ship being boarded
    this._hostiles = [];
    this._surface = null;
    this._restore = null;
    this._t = 0;
    this._settleT = 0;         // brief "grapple" beat before control returns

    // If the captain loses his ship or respawns mid-boarding, tear the melee
    // down cleanly — otherwise the walk surface, the hostiles, and the ship pin
    // would leak and the rebuilt ship would be yanked back to the grapple spot
    // every frame (a soft-lock until the safety timeout).
    ctx.events?.on('ship:sunk', ({ ship }) => {
      if (this.active && ship === this.ctx.playerShip?.ship) this._abort();
    });
    ctx.events?.on('player:respawn', () => { if (this.active) this._abort(); });
  }

  /** Can we run the playable melee for this prize right now? */
  canBoard(ship) {
    const ctx = this.ctx;
    return !!(ship && ship.alive && !this.active
      && ctx.mode === 'sail'
      && ctx.character?.spawnAt && ctx.npcs?.spawnHostile
      && ctx.playerShip?.ship?.alive
      && ctx.world?.addDynamicSurface);
  }

  begin(ship) {
    const ctx = this.ctx;
    if (!this.canBoard(ship)) { ctx.crew?._resolveBoarding?.(ship); return; }
    const ps = ctx.playerShip.ship;
    const pg = ps.group;
    const eg = ship.group;
    const hd = ps.physics.heading;

    _fwd.set(Math.sin(hd), 0, Math.cos(hd));           // along the ships
    _right.set(Math.cos(hd), 0, -Math.sin(hd));        // to starboard

    const pBeam = ps.type.beam ?? 6;
    const eBeam = ship.type.beam ?? 6;
    const pLen = ps.type.length ?? 20;
    const eLen = ship.type.length ?? 20;
    const gap = pBeam * 0.5 + eBeam * 0.5 + 3.2;       // lashed alongside, starboard
    const pDeckY = pg.userData?.parts?.deckY ?? 1.4;
    const eDeckY = eg.userData?.parts?.deckY ?? 1.4;
    const platformY = pg.position.y + pDeckY;

    // remember what to put back
    this._restore = {
      eX: eg.position.x, eY: eg.position.y, eZ: eg.position.z,
      eRotX: eg.rotation.x, eRotY: eg.rotation.y, eRotZ: eg.rotation.z,
      eHeading: ship.physics.heading, eSail: ship.sailAmount,
      pX: pg.position.x, pY: pg.position.y, pZ: pg.position.z,
      pHeading: ps.physics.heading, pSail: ps.sailAmount,
    };

    // pin the prize abeam to starboard, decks aligned to one flat platform
    const ex = pg.position.x + _right.x * gap;
    const ez = pg.position.z + _right.z * gap;
    eg.position.set(ex, platformY - eDeckY, ez);
    eg.rotation.set(0, hd, 0);
    ship.physics.heading = hd;
    ship.physics.speed = 0;
    ship.sailAmount = 0;
    ps.physics.speed = 0;
    ps.sailAmount = 0;

    this._pin = { pX: pg.position.x, pY: pg.position.y, pZ: pg.position.z, pHd: hd,
      eX: ex, eY: platformY - eDeckY, eZ: ez, eHd: hd };

    // a boarding platform spanning both decks (rotated rect at deck height)
    _mid.set((pg.position.x + ex) / 2, 0, (pg.position.z + ez) / 2);
    this._surface = ctx.world.addDynamicSurface({
      x: _mid.x, z: _mid.z, y: platformY, rot: hd,
      hw: gap / 2 + Math.max(pBeam, eBeam) * 0.5 + 0.8,   // across the beams
      hd: Math.max(pLen, eLen) * 0.46,                     // along the ships
    });

    // drop the captain on his own rail, facing the prize
    _pt.set(pg.position.x + _right.x * (pBeam * 0.28), platformY, pg.position.z + _right.z * (pBeam * 0.28));
    const faceEnemy = Math.atan2(_right.x, _right.z);
    ctx.setMode('foot');
    ctx.character.spawnAt(_pt, faceEnemy);
    // board hale — sailing never regenerates HP, so a captain who last stepped
    // ashore wounded would otherwise be repelled before the fight even starts.
    if (ctx.character) ctx.character.hp = ctx.character.hpMax;

    // muster the prize's surviving hands across her deck
    const n = clamp(Math.round((ship.crewCount ?? 6) * 0.6), 2, MAX_HOSTILES);
    this._hostiles.length = 0;
    for (let i = 0; i < n; i++) {
      const along = (i / Math.max(n - 1, 1) - 0.5) * eLen * 0.6;
      const lat = (i % 2 ? 0.6 : -0.6) * eBeam * 0.18;
      _pt.set(
        ex + _fwd.x * along + _right.x * lat,
        platformY,
        ez + _fwd.z * along + _right.z * lat,
      );
      const kind = ship.faction === 'crown' ? 'marine' : (ship.faction === 'tidebound' ? 'drowned' : 'brigand');
      const h = ctx.npcs.spawnHostile(_pt, kind);
      if (h) { h.dmg = HOSTILE_DMG.slice(); this._hostiles.push(h); }
    }

    ship._boarded = true;      // freezes her AI (no steering, no gunnery) while grappled
    this.active = true;
    this.ship = ship;
    this._t = 0;
    this._settleT = 0.9;

    ctx.events?.emit('shake', { amount: 0.5 });
    ctx.events?.emit('boarding:begin', { ship });
    ctx.events?.emit('toast', { text: `Grapples away — board ${ship.name}! Clear her deck.`, kind: 'combat' });
  }

  update(dt) {
    if (!this.active) return;
    const ctx = this.ctx;
    const ps = ctx.playerShip?.ship;
    const ship = this.ship;
    this._t += dt;
    if (this._settleT > 0) this._settleT -= dt;

    // hold both hulls fast to the pinned transforms so the deck stays put
    if (ps?.group && this._pin) {
      ps.group.position.set(this._pin.pX, this._pin.pY, this._pin.pZ);
      ps.group.rotation.set(0, this._pin.pHd, 0);
      ps.physics.speed = 0;
    }
    if (ship?.group && this._pin) {
      ship.group.position.set(this._pin.eX, this._pin.eY, this._pin.eZ);
      ship.group.rotation.set(0, this._pin.eHd, 0);
      ship.physics.speed = 0;
    }

    // let the grapple beat play before we start judging the fight
    if (this._settleT > 0) return;

    const alive = this._hostiles.filter((h) => h && h.alive).length;
    const hpFrac = (ctx.character?.hp ?? 1) / (ctx.character?.hpMax ?? 1);

    if (alive === 0) { this._end(true); return; }
    if (!ctx.character?.alive || hpFrac <= DEFEAT_HP_FRAC) { this._end(false); return; }
    if (this._t > BOARD_TIMEOUT) { this._end(alive <= Math.ceil(this._hostiles.length / 2)); return; }
  }

  _end(victory) {
    const ctx = this.ctx;
    const ship = this.ship;
    this.active = false;

    // clear any of the prize's hands still standing
    for (const h of this._hostiles) {
      if (!h) continue;
      h.alive = false; h.hp = 0;
      this._despawn(h);
    }
    this._hostiles.length = 0;

    // lift the boarding platform and return to the helm
    if (this._surface) { ctx.world?.removeDynamicSurface?.(this._surface); this._surface = null; }
    ctx.setMode('sail');

    const ps = ctx.playerShip?.ship;
    if (ps) { ps.physics.speed = 0; if (this._restore) ps.physics.heading = this._restore.pHeading; }

    if (ship) ship._boarded = false;   // hand her back to the fleet AI

    if (victory) {
      // the prize is scuttled behind you as you sail off richer
      if (ship?.alive && !ship.sinking) {
        ship._lastHitByPlayer = true;
        ship.sink(true);
      }
      ctx.crew?.applyBoardingOutcome?.(ship, true, { heavy: (ctx.character?.hp ?? 100) / (ctx.character?.hpMax ?? 100) < 0.5 });
    } else {
      // beaten back — the prize breaks away and runs
      if (ship && this._restore) {
        ship.physics.heading = this._restore.eHeading;
        ship.sailAmount = 0.7;
        ship.hull = Math.min(ship.hullMax, ship.hull + ship.hullMax * 0.12); // no longer instantly re-boardable
        ship._boardable = false;
      }
      if (ctx.character?.alive) {
        // give the captain a moment to lick his wounds
        ctx.character.hp = Math.max(ctx.character.hp, ctx.character.hpMax * 0.35);
        ctx.crew?.applyBoardingOutcome?.(ship, false, { heavy: true });
      }
      // if the captain actually fell, the death/respawn flow owns the outcome —
      // don't stack a "Repelled!" modal on top of the death screen.
    }

    this.ship = null;
    this._pin = null;
    this._restore = null;
  }

  /** Tear the melee down without resolving an outcome — used when the player
   *  loses his ship or respawns mid-boarding (the death/respawn flow owns it). */
  _abort() {
    const ctx = this.ctx;
    this.active = false;
    for (const h of this._hostiles) {
      if (!h) continue;
      h.alive = false; h.hp = 0;
      this._despawn(h);
    }
    this._hostiles.length = 0;
    if (this._surface) { ctx.world?.removeDynamicSurface?.(this._surface); this._surface = null; }
    if (this.ship) this.ship._boarded = false;
    this.ship = null;
    this._pin = null;
    this._restore = null;
  }

  _despawn(npc) {
    const mgr = this.ctx.npcs;
    if (!mgr) return;
    const i = mgr.npcs?.indexOf(npc);
    if (i >= 0) mgr.npcs.splice(i, 1);
    const hi = mgr.hostiles?.indexOf(npc);
    if (hi >= 0) mgr.hostiles.splice(hi, 1);
    npc.dispose?.();   // removes rig.group from the scene and frees its geometry
  }
}
