// UI orchestrator: screens, toasts, prompts, key routing.
import { HUD } from './hud.js';
import { MapScreen } from './map.js';
import { Menus } from './menus.js';
import { Trading } from './trading.js';
import { Journal } from './journal.js';

export class UI {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = document.getElementById('ui');
    this.pointerOverUI = false;
    this.activeScreen = null;

    // screen container
    this.screenRoot = document.createElement('div');
    this.screenRoot.id = 'screen-root';
    this.screenRoot.className = 'hidden';
    this.root.appendChild(this.screenRoot);

    this.hud = new HUD(ctx, this);
    this.map = new MapScreen(ctx, this);
    this.menus = new Menus(ctx, this);
    this.trading = new Trading(ctx, this);
    this.journal = new Journal(ctx, this);

    this._prompts = new Map();
    this._sayTimer = 0;

    ctx.events?.on('toast', ({ text, kind }) => this.toast(text, kind));
    ctx.events?.on('prompt', ({ id, text }) => this.prompt(id ?? 'default', text));
    ctx.events?.on('npc:say', ({ npc, text }) => this.say(npc?.name, text));
    ctx.events?.on('port:menu', ({ port, island }) => this.trading.openDockMenu(port, island));
    ctx.events?.on('npc:interact', ({ npc }) => this._onNpcInteract(npc));
    ctx.events?.on('boarding:offer', ({ ship }) => this._boardingOffer(ship));
    ctx.events?.on('boarding:resolve', (res) => this._boardingResult(res));
  }

  _onNpcInteract(npc) {
    const island = this.ctx.world?.islands.find((i) => i.port?.name === npc.portName);
    const port = island?.port;
    if (!port) return;
    if (npc.role === 'merchant') this.trading.openMarket(port);
    else if (npc.role === 'shipwright') this.trading.openShipwright(port);
    else if (npc.role === 'tavernkeep') this.trading.openTavern(port);
    else if (npc.role === 'questgiver') this.trading.openQuestBoard(port);
  }

  /** Show a modal panel. Builder fills the given panel element. */
  openScreen(name, builder) {
    this.closeScreen();
    this.activeScreen = name;
    this.pointerOverUI = true;
    this.ctx.time.paused = true;
    this.ctx.input?.exitPointerLock?.();
    this.screenRoot.classList.remove('hidden');
    this.screenRoot.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';
    const close = document.createElement('button');
    close.className = 'close-x';
    close.textContent = '✕';
    close.onclick = () => this.closeScreen();
    panel.appendChild(close);
    this.screenRoot.appendChild(panel);
    builder(panel);
    return panel;
  }

  closeScreen() {
    if (!this.activeScreen) return;
    this.activeScreen = null;
    this.pointerOverUI = false;
    this.screenRoot.classList.add('hidden');
    this.screenRoot.innerHTML = '';
    if (this.ctx.mode !== 'menu') this.ctx.time.paused = false;
  }

  toast(text, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    this.hud.toasts.appendChild(el);
    while (this.hud.toasts.children.length > 5) this.hud.toasts.firstChild.remove();
    setTimeout(() => el.classList.add('dying'), 4600);
    setTimeout(() => el.remove(), 5400);
  }

  prompt(id, text) {
    if (text == null) this._prompts.delete(id);
    else this._prompts.set(id, text);
    let last = '';
    for (const t of this._prompts.values()) last = t;
    this.hud.promptEl.innerHTML = last
      ? last.replace(/^(Hold E|E)(?= )/, '<b>$1</b>')
      : '';
  }

  say(who, text) {
    const el = this.hud.sayEl;
    el.innerHTML = `${who ? `<div class="who">${who}</div>` : ''}${text}`;
    el.style.opacity = '1';
    this._sayTimer = 6;
  }

  _boardingOffer(ship) {
    this.openScreen('boarding', (panel) => {
      panel.insertAdjacentHTML('beforeend', `
        <h2>Boarding Action</h2>
        <div class="sub">${ship.name} is crippled and within grappling range.</div>
        <p style="font-size:14px;line-height:1.6">Your crew stands ready at the rails, blades drawn.
        Their strength: <b style="color:var(--brass)">${Math.round(this.ctx.crew?.boardingStrength?.() ?? 10)}</b>
        against roughly <b style="color:var(--bad)">${Math.round((ship.crewCount ?? 8) * 1.6)}</b> souls still fighting.</p>
        <div class="board-buttons"></div>
      `);
      const row = panel.querySelector('.board-buttons');
      const yes = document.createElement('button');
      yes.className = 'primary';
      yes.textContent = '⚔ Board them!';
      yes.onclick = () => {
        this.closeScreen();
        this.ctx.events?.emit('boarding:accept', { ship });
      };
      const no = document.createElement('button');
      no.textContent = 'Hold off';
      no.onclick = () => this.closeScreen();
      row.append(yes, no);
    });
  }

  _boardingResult({ victory, lootGold, casualties }) {
    this.openScreen('boarding-result', (panel) => {
      panel.insertAdjacentHTML('beforeend', `
        <h2>${victory ? 'Prize Taken!' : 'Repelled!'}</h2>
        <div class="sub">${victory
          ? 'The deck is yours. The strongbox opens to a crowbar and a grin.'
          : 'Steel met steel and the sea decided against you today.'}</div>
        <p style="font-size:15px;line-height:1.7">
          ${victory ? `Plunder: <b style="color:#e8c860">${lootGold} sovereigns</b><br>` : ''}
          ${casualties?.length ? `Lost overboard or to the blade: <b style="color:var(--bad)">${casualties.join(', ')}</b>` : 'Not a hand lost.'}
        </p>
      `);
      const ok = document.createElement('button');
      ok.className = 'primary';
      ok.textContent = 'Back to the helm';
      ok.onclick = () => this.closeScreen();
      panel.appendChild(ok);
    });
  }

  update(dt) {
    const ctx = this.ctx;
    const input = ctx.input;

    // speech bubble fade
    if (this._sayTimer > 0) {
      this._sayTimer -= dt;
      if (this._sayTimer <= 0) this.hud.sayEl.style.opacity = '0';
    }

    // key routing (not on title screen)
    if (ctx.mode !== 'menu') {
      if (input.wasPressed('Escape')) {
        if (this.activeScreen) this.closeScreen();
        else this.menus.openPause();
      }
      if (input.wasPressed('KeyM')) {
        this.activeScreen === 'map' ? this.closeScreen() : this.map.open();
      }
      if (input.wasPressed('KeyJ')) {
        this.activeScreen === 'journal' ? this.closeScreen() : this.journal.open('quests');
      }
      if (input.wasPressed('KeyK')) {
        this.activeScreen === 'journal' ? this.closeScreen() : this.journal.open('skills');
      }
      if (input.wasPressed('Tab')) {
        this.activeScreen === 'journal' ? this.closeScreen() : this.journal.open('crew');
      }
    }

    this.hud.update(dt);
    this.menus.update(dt);
  }
}
