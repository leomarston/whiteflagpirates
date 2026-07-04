// Hunting → Materials → Craftable Outfits — a self-contained content vertical.
//
// Fauna hunting (whales at sea, and the circling shark when it commits to a
// swimmer — both driven through the Animals harvest API) drops raw materials
// into a persisted inventory. At a port those materials buy permanent OUTFITS
// that fold straight into progression.getMod, so they take effect with no
// consumer changes. This module owns:
//   • the harpoon prompt/input + material award loop (update)
//   • its OWN injected Outfitter DOM panel (scoped <style> + a floating overlay)
// It reads/writes only ctx.state.data.materials and ctx.state.data.outfits, and
// leans on ctx.effects / ctx.events — it invents no new APIs and edits no other
// system's UI.
//
// Contract (mirrors the other systems): new Hunting(ctx); update(dt).
import { OUTFITS } from './progression.js';

// Harpoon tuning. Whale hp 120 → ~5 strikes; shark hp 60 → ~2–3 strikes.
const HARPOON_DMG = 28;
const STRIKE_CD = 0.55;   // seconds between throws (rate-limit, fair & readable)
const PORT_RANGE = 90;    // open the Outfitter this close to a port quay

// Keys. KeyF is free in SAIL mode (the pistol binds KeyF but only on foot, and
// the Character/sword only update on foot), so the whale harpoon uses it as the
// task suggests. On foot KeyF is taken by the pistol, so the shark harpoon uses
// KeyH (unbound everywhere). The Outfitter opens with KeyG (unbound everywhere).
const KEY_HARPOON_SAIL = 'KeyF';
const KEY_HARPOON_FOOT = 'KeyH';
const KEY_OUTFITTER = 'KeyG';

const DEFAULT_MATERIALS = { oil: 0, hide: 0, ambergris: 0 };
const MAT_LABEL = { oil: 'Whale oil', hide: 'Hide', ambergris: 'Ambergris' };

export class Hunting {
  constructor(ctx) {
    this.ctx = ctx;

    this._strikeCd = 0;
    this._huntPromptOn = false;
    this._outPromptOn = false;
    this._panelOpen = false;
    this._root = null;      // outfitter overlay (built lazily on first open)
    this._listEl = null;
    this._matsEl = null;
    this._escHandler = null;

    // Persisted stores — initialise defensively so getMod & the panel are safe
    // even before the first game:start.
    this._ensureStores();

    ctx.events?.on('game:start', ({ fresh } = {}) => {
      const d = ctx.state?.data;
      if (!d) return;
      if (fresh) {
        d.materials = { oil: 0, hide: 0, ambergris: 0 };
        d.outfits = {};
      } else {
        this._ensureStores();
      }
      if (this._panelOpen) this._closePanel();
    });
  }

  _ensureStores() {
    const d = this.ctx.state?.data;
    if (!d) return;
    d.materials ??= { oil: 0, hide: 0, ambergris: 0 };
    d.materials.oil ??= 0;
    d.materials.hide ??= 0;
    d.materials.ambergris ??= 0;
    d.outfits ??= {};
  }

  // ---- per-frame: harpoon loop + Outfitter proximity prompt ----------------
  update(dt) {
    const ctx = this.ctx;
    // update() only runs while unpaused & in play (the loop skips it otherwise),
    // but guard anyway so a stray call can't misbehave.
    if (!ctx || ctx.mode === 'menu' || ctx.time?.paused || this._panelOpen) return;

    if (this._strikeCd > 0) this._strikeCd -= dt;

    this._updateHunt(dt);
    this._updateOutfitterPrompt(dt);
  }

  _updateHunt() {
    const ctx = this.ctx;
    const animals = ctx.animals;
    const onFoot = ctx.mode === 'foot';
    const focus = onFoot ? ctx.character?.position : ctx.playerShip?.ship?.position;
    const target = (animals?.getHuntTarget && focus) ? animals.getHuntTarget(focus) : null;

    if (target) {
      const key = onFoot ? KEY_HARPOON_FOOT : KEY_HARPOON_SAIL;
      const what = target.kind === 'shark' ? 'the shark' : 'the whale';
      const kd = onFoot ? 'H' : 'F';
      ctx.events?.emit('prompt', { id: 'hunt', text: `${kd} — Harpoon ${what}` });
      this._huntPromptOn = true;
      if (this._strikeCd <= 0 && ctx.input?.wasPressed?.(key)) {
        this._strikeCd = STRIKE_CD;
        this._throwHarpoon(target);
      }
    } else if (this._huntPromptOn) {
      ctx.events?.emit('prompt', { id: 'hunt', text: null });
      this._huntPromptOn = false;
    }
  }

  _throwHarpoon(target) {
    const ctx = this.ctx;
    const p = target?.point;
    if (p) {
      // a quick harpoon-line effect using only the existing effects API
      ctx.effects?.trail?.(p);
      ctx.effects?.splash?.(p, 0.45);
    }
    ctx.events?.emit('shake', { amount: 0.12 });
    const yield_ = ctx.animals?.strikeHunt?.(target, HARPOON_DMG);
    if (yield_) this._award(yield_, target?.kind);
  }

  _award(yield_, kind) {
    const d = this.ctx.state?.data;
    if (!d) return;
    this._ensureStores();
    const parts = [];
    for (const k in yield_) {
      const n = yield_[k] | 0;
      if (!n) continue;
      d.materials[k] = (d.materials[k] | 0) + n;
      parts.push(`${n} ${MAT_LABEL[k] ?? k}`);
    }
    if (!parts.length) return;
    const what = kind === 'shark' ? 'Shark taken' : 'Whale taken';
    const spoils = parts.join(', ');
    this.ctx.events?.emit('toast', { text: `${what} — harvested ${spoils}.`, kind: 'discover' });
    this.ctx.state?.addLog?.(`${what}. Salted away ${spoils} for the outfitter.`);
    this.ctx.events?.emit('materials:change', d.materials);
  }

  _updateOutfitterPrompt() {
    const ctx = this.ctx;
    // near a port AND slowed at the quay → offer the Outfitter. The speed gate
    // keeps the dock-approach prompt ("E — Dock") clean while you're still under
    // way, and this takes over once you've pulled up / dropped anchor.
    const ship = ctx.mode === 'sail' ? ctx.playerShip?.ship : null;
    const pos = ship?.position;
    const slow = (ship?.physics?.speed ?? 99) < 3;
    const near = pos ? ctx.world?.getNearestPort?.(pos) : null;
    const isNear = !!near && near.distance < PORT_RANGE && slow;

    if (isNear) {
      ctx.events?.emit('prompt', { id: 'outfitter', text: 'G — Outfitter' });
      this._outPromptOn = true;
      if (ctx.input?.wasPressed?.(KEY_OUTFITTER)) this._openPanel();
    } else if (this._outPromptOn) {
      ctx.events?.emit('prompt', { id: 'outfitter', text: null });
      this._outPromptOn = false;
    }
  }

  // ---- Outfitter panel (own scoped DOM; do not touch ui/*) -----------------
  _ensureDom() {
    if (this._root) return;
    if (!document.getElementById('outfitter-style')) {
      const style = document.createElement('style');
      style.id = 'outfitter-style';
      style.textContent = OUTFITTER_CSS;
      document.head.appendChild(style);
    }

    const root = document.createElement('div');
    root.id = 'outfitter-root';
    root.className = 'of-backdrop';
    root.style.display = 'none';
    root.innerHTML = `
      <div class="of-panel" role="dialog" aria-label="Outfitter">
        <button type="button" class="of-close" title="Close">✕</button>
        <div class="of-head">
          <div class="of-title">Chandler's Outfitter</div>
          <div class="of-sub">Permanent riggings, crafted from your hunting spoils.</div>
        </div>
        <div class="of-mats"></div>
        <div class="of-list"></div>
        <div class="of-foot">
          <button type="button" class="of-done">Weigh anchor</button>
        </div>
      </div>`;
    // clicking the dark backdrop (but not the panel) closes
    root.addEventListener('mousedown', (e) => { if (e.target === root) this._closePanel(); });
    root.querySelector('.of-close').onclick = () => this._closePanel();
    root.querySelector('.of-done').onclick = () => this._closePanel();
    // swallow clicks inside the panel so they never fall through to the backdrop
    root.querySelector('.of-panel').addEventListener('mousedown', (e) => e.stopPropagation());

    document.body.appendChild(root);
    this._root = root;
    this._matsEl = root.querySelector('.of-mats');
    this._listEl = root.querySelector('.of-list');
  }

  _openPanel() {
    if (this._panelOpen) return;
    this._ensureDom();
    if (!this._root) return;
    this._panelOpen = true;

    // clear our prompts and pause the world (mirrors ui.openScreen behaviour)
    this.ctx.events?.emit('prompt', { id: 'outfitter', text: null });
    this.ctx.events?.emit('prompt', { id: 'hunt', text: null });
    this._outPromptOn = false;
    this._huntPromptOn = false;
    this.ctx.input?.exitPointerLock?.();
    if (this.ctx.time) this.ctx.time.paused = true;

    this._renderPanel();
    this._root.style.display = 'flex';

    // Close on Escape ourselves (capture + stopImmediatePropagation) so the
    // global Escape handler doesn't also pop the pause menu behind us.
    this._escHandler = (e) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        this._closePanel();
      }
    };
    window.addEventListener('keydown', this._escHandler, true);
  }

  _closePanel() {
    if (!this._panelOpen) return;
    this._panelOpen = false;
    if (this._root) this._root.style.display = 'none';
    if (this._escHandler) {
      window.removeEventListener('keydown', this._escHandler, true);
      this._escHandler = null;
    }
    if (this.ctx.mode !== 'menu' && this.ctx.time) this.ctx.time.paused = false;
  }

  _renderPanel() {
    const d = this.ctx.state?.data;
    if (!d || !this._listEl) return;
    this._ensureStores();
    const mats = d.materials;
    const gold = d.gold | 0;

    this._matsEl.innerHTML =
      `<span class="of-mat"><b>${mats.oil | 0}</b> oil</span>` +
      `<span class="of-mat"><b>${mats.hide | 0}</b> hide</span>` +
      `<span class="of-mat"><b>${mats.ambergris | 0}</b> ambergris</span>` +
      `<span class="of-mat of-gold"><b>${gold}</b> gold</span>`;

    this._listEl.innerHTML = '';
    for (const id in OUTFITS) {
      const o = OUTFITS[id];
      const owned = !!d.outfits?.[id];
      const costMats = o.cost || {};
      const costStr = [
        ...Object.keys(costMats).map((k) => `${costMats[k]} ${k}`),
        ...(o.gold ? [`${o.gold} gold`] : []),
      ].join(' · ');
      const afford = this._canAfford(o);

      const row = document.createElement('div');
      row.className = 'of-row' + (owned ? ' of-owned' : '');
      row.innerHTML = `
        <div class="of-info">
          <div class="of-name">${o.label}</div>
          <div class="of-desc">${o.desc ?? ''}</div>
          <div class="of-cost">${owned ? 'Fitted' : costStr}</div>
        </div>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'of-buy';
      if (owned) {
        btn.textContent = '✓ Owned';
        btn.disabled = true;
      } else {
        btn.textContent = 'Fit';
        btn.disabled = !afford;
        btn.onclick = () => this._buy(id);
      }
      row.appendChild(btn);
      this._listEl.appendChild(row);
    }
  }

  _canAfford(o) {
    const d = this.ctx.state?.data;
    if (!d) return false;
    const mats = d.materials || DEFAULT_MATERIALS;
    for (const k in (o.cost || {})) {
      if ((mats[k] | 0) < o.cost[k]) return false;
    }
    if ((o.gold | 0) > 0 && (d.gold | 0) < o.gold) return false;
    return true;
  }

  _buy(id) {
    const d = this.ctx.state?.data;
    const o = OUTFITS[id];
    if (!d || !o) return;
    this._ensureStores();
    if (d.outfits[id]) return;
    if (!this._canAfford(o)) {
      this.ctx.events?.emit('toast', { text: 'Not enough materials for that.', kind: 'warn' });
      return;
    }
    for (const k in (o.cost || {})) {
      d.materials[k] = (d.materials[k] | 0) - o.cost[k];
    }
    if (o.gold) this.ctx.state?.addGold?.(-o.gold);
    d.outfits[id] = true;

    // refresh any derived ship stats that cache mods, and let getMod consumers
    // pick the new factor up (most read it live, so this is belt-and-braces)
    this.ctx.events?.emit('ship:upgraded', {});
    this.ctx.events?.emit('materials:change', d.materials);
    this.ctx.events?.emit('toast', { text: `Fitted: ${o.label}`, kind: 'discover' });
    this.ctx.state?.addLog?.(`Fitted ${o.label} at the outfitter's.`);
    this._renderPanel();
  }
}

const OUTFITTER_CSS = `
#outfitter-root.of-backdrop {
  position: fixed; inset: 0; z-index: 9000;
  display: none; align-items: center; justify-content: center;
  background: rgba(6, 10, 14, 0.6);
  font-family: 'Georgia', 'Times New Roman', serif;
  -webkit-font-smoothing: antialiased;
}
#outfitter-root .of-panel {
  position: relative;
  width: min(560px, 92vw); max-height: 86vh; overflow-y: auto;
  padding: 26px 26px 20px;
  color: #ece3d0;
  background: linear-gradient(160deg, #221c14 0%, #171310 100%);
  border: 1px solid #6b5334;
  border-radius: 10px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.6), inset 0 0 0 1px rgba(201, 162, 75, 0.12);
}
#outfitter-root .of-close {
  position: absolute; top: 12px; right: 14px;
  width: 30px; height: 30px; line-height: 1;
  background: transparent; color: #b7a988; border: 0;
  font-size: 20px; cursor: pointer; border-radius: 6px;
}
#outfitter-root .of-close:hover { color: #f3e9d2; background: rgba(255,255,255,0.06); }
#outfitter-root .of-head { margin-bottom: 14px; padding-right: 26px; }
#outfitter-root .of-title {
  font-size: 25px; letter-spacing: 0.5px; color: #e8c860;
  text-shadow: 0 1px 0 rgba(0,0,0,0.5);
}
#outfitter-root .of-sub { font-size: 13.5px; color: #b7a988; margin-top: 3px; font-style: italic; }
#outfitter-root .of-mats {
  display: flex; flex-wrap: wrap; gap: 8px 16px;
  padding: 10px 12px; margin-bottom: 16px;
  background: rgba(0,0,0,0.28); border: 1px solid #4a3a24; border-radius: 8px;
  font-size: 14px; color: #d7cbb0;
}
#outfitter-root .of-mat b { color: #f0e6cd; }
#outfitter-root .of-mat.of-gold b { color: #e8c860; }
#outfitter-root .of-list { display: flex; flex-direction: column; gap: 10px; }
#outfitter-root .of-row {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 14px;
  background: rgba(255,255,255,0.03); border: 1px solid #4a3a24; border-radius: 8px;
}
#outfitter-root .of-row.of-owned { opacity: 0.72; border-color: #3c5a3c; }
#outfitter-root .of-info { flex: 1 1 auto; min-width: 0; }
#outfitter-root .of-name { font-size: 16px; color: #f0e6cd; }
#outfitter-root .of-desc { font-size: 13px; color: #b2c7a8; margin-top: 2px; }
#outfitter-root .of-cost { font-size: 12.5px; color: #b7a988; margin-top: 4px; }
#outfitter-root .of-buy {
  flex: 0 0 auto; min-width: 84px;
  padding: 9px 14px; cursor: pointer;
  font-family: inherit; font-size: 14px; color: #17130d;
  background: linear-gradient(180deg, #e8c860, #c99a3c);
  border: 0; border-radius: 7px; font-weight: bold;
}
#outfitter-root .of-buy:hover:not(:disabled) { filter: brightness(1.08); }
#outfitter-root .of-buy:disabled {
  cursor: default; color: #8a8064;
  background: #2a231a; border: 1px solid #4a3a24;
}
#outfitter-root .of-foot { margin-top: 18px; text-align: right; }
#outfitter-root .of-done {
  padding: 9px 18px; cursor: pointer;
  font-family: inherit; font-size: 14px; color: #ece3d0;
  background: rgba(255,255,255,0.05); border: 1px solid #6b5334; border-radius: 7px;
}
#outfitter-root .of-done:hover { background: rgba(255,255,255,0.1); }
`;
