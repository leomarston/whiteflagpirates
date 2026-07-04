// Port screens: dock menu, market, shipwright, tavern, quest board.

function portraitCanvas(seedStr) {
  const c = document.createElement('canvas');
  c.width = c.height = 52;
  c.className = 'portrait';
  const g = c.getContext('2d');
  let h = 0;
  for (const ch of seedStr) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const skin = ['#c9976b', '#a87a52', '#8a6242', '#d8ac82'][h % 4];
  const hat = ['#241c12', '#3d4a5c', '#6e3a2a', '#1d6f6d'][(h >> 3) % 4];
  g.fillStyle = '#101c28';
  g.fillRect(0, 0, 52, 52);
  g.fillStyle = skin;
  g.fillRect(16, 16, 20, 22);        // face
  g.fillStyle = '#241c12';
  g.fillRect(20, 24 + (h % 3), 3, 3); // eyes
  g.fillRect(29, 24 + (h % 3), 3, 3);
  g.fillStyle = hat;
  if ((h >> 5) % 3 === 0) g.fillRect(12, 8, 28, 10);        // tricorne-ish
  else if ((h >> 5) % 3 === 1) g.fillRect(16, 10, 20, 8);   // bandana
  else g.fillRect(16, 12, 20, 5);                            // headband
  if ((h >> 7) % 2) { g.fillStyle = '#241c12'; g.fillRect(16, 36, 20, 6); } // beard
  return c;
}

export class Trading {
  constructor(ctx, ui) {
    this.ctx = ctx;
    this.ui = ui;
  }

  _findIsland(port) {
    return this.ctx.world?.islands.find((i) => i.port === port) ??
      this.ctx.world?.islands.find((i) => i.port?.name === port.name);
  }

  openDockMenu(port, island) {
    const ctx = this.ctx;
    this.ui.openScreen('dock', (panel) => {
      const def = island?.def ?? this._findIsland(port)?.def;
      panel.insertAdjacentHTML('beforeend', `
        <h2>${port.name}</h2>
        <div class="sub">${def?.description ?? 'A harbor of the Verge.'}</div>
        <div class="menu-col"></div>
      `);
      const col = panel.querySelector('.menu-col');
      const mk = (label, fn, cls = '') => {
        const b = document.createElement('button');
        if (cls) b.className = cls;
        b.innerHTML = label;
        b.onclick = fn;
        col.appendChild(b);
      };
      mk('🚶 Step ashore', () => {
        this.ui.closeScreen();
        const heading = (port.dockHeading ?? 0) + Math.PI; // inland
        const base = port.dockWalk ?? port.position;
        const spawn = {
          x: base.x + Math.sin(heading) * 3.2,
          y: base.y,
          z: base.z + Math.cos(heading) * 3.2,
        };
        ctx.setMode('foot');
        ctx.character?.spawnAt(spawn, heading);
      }, 'primary');
      mk('⚖ Market', () => this.openMarket(port));
      if (port.flags?.hasShipwright) mk('🔨 Shipwright', () => this.openShipwright(port));
      if (port.flags?.hasTavern) mk('🍺 Tavern', () => this.openTavern(port));
      if (port.flags?.hasQuests) mk('📜 Quest board', () => this.openQuestBoard(port));
      mk('⛵ Set sail', () => {
        this.ui.closeScreen();
        ctx.events?.emit('ship:undock', {});
      });
    });
  }

  openMarket(port) {
    const ctx = this.ctx;
    const render = (panel) => {
      const market = ctx.economy?.getMarket(port.name) ?? [];
      const cargo = ctx.state.data.cargo ?? {};
      panel.innerHTML = `
        <button class="close-x">✕</button>
        <h2>Market — ${port.name}</h2>
        <div class="sub">Click Buy/Sell · hold Shift for 5 at a time</div>
        <div class="trade-head">
          <span class="money">Purse: ${ctx.state.data.gold.toLocaleString('en-US')} s</span>
          <span>Hold: ${ctx.economy?.cargoUsed() ?? 0} / ${ctx.economy?.cargoCapacity() ?? 0}</span>
        </div>
        <div class="trade-wrap">
          <table class="trade">
            <tr><th>Good</th><th>Buy</th><th>Sell</th><th>Aboard</th><th></th><th></th></tr>
          </table>
        </div>
      `;
      panel.querySelector('.close-x').onclick = () => this.ui.closeScreen();
      const table = panel.querySelector('table');
      for (const item of market) {
        const tr = document.createElement('tr');
        const buyCls = item.buy < item.base ? 'price-low' : item.buy > item.base * 1.25 ? 'price-high' : '';
        const sellCls = item.sell > item.base ? 'price-low' : '';
        tr.innerHTML = `
          <td>${item.name}${item.contraband ? '<span class="skull" title="Contraband here">☠</span>' : ''}</td>
          <td class="${buyCls}">${item.buy}</td>
          <td class="${sellCls}">${item.sell}</td>
          <td>${cargo[item.key] ?? 0}</td>
          <td><button class="mini buy">Buy</button></td>
          <td><button class="mini sell" ${!(cargo[item.key] > 0) ? 'disabled' : ''}>Sell</button></td>
        `;
        tr.querySelector('.buy').onclick = (e) => {
          const r = ctx.economy.buy(port.name, item.key, e.shiftKey ? 5 : 1);
          if (!r.ok) this.ui.toast(r.why, 'warn');
          render(panel);
        };
        tr.querySelector('.sell').onclick = (e) => {
          const r = ctx.economy.sell(port.name, item.key, e.shiftKey ? 5 : 1);
          if (!r.ok) this.ui.toast(r.why, 'warn');
          render(panel);
        };
        table.appendChild(tr);
      }
    };
    this.ui.openScreen('market', render);
  }

  openShipwright(port) {
    const ctx = this.ctx;
    const render = (panel) => {
      const offers = ctx.progression?.getUpgradeOffers() ?? { tiers: [], ships: [], paints: [] };
      const shipData = ctx.state.data.ship;
      panel.innerHTML = `
        <button class="close-x">✕</button>
        <h2>Shipwright — ${port.name}</h2>
        <div class="sub">Your ${ctx.playerShip?.ship?.type?.name ?? 'ship'}, the <i>${shipData.name}</i> ·
          hull ${Math.round(ctx.playerShip?.ship?.hull ?? 0)}/${Math.round(ctx.playerShip?.ship?.hullMax ?? 0)} ·
          Purse: <span style="color:#e8c860">${ctx.state.data.gold.toLocaleString('en-US')} s</span></div>
        <div class="cards"></div>
        <h2 style="margin-top:22px;font-size:16px">Hulls for sale</h2>
        <div class="cards ships"></div>
      `;
      panel.querySelector('.close-x').onclick = () => this.ui.closeScreen();
      const cards = panel.querySelector('.cards');
      const addCard = (parent, title, desc, meta, btnLabel, fn, disabled = false) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<h3>${title}</h3><div class="desc">${desc}</div><div class="meta">${meta}</div>`;
        const b = document.createElement('button');
        b.className = 'mini primary';
        b.textContent = btnLabel;
        b.disabled = disabled;
        b.onclick = () => { fn(); render(panel); };
        card.appendChild(b);
        parent.appendChild(card);
      };

      if (offers.repair) {
        addCard(cards, 'Careen & Repair', 'Patch shot-holes, replace sprung planks, tar the seams.',
          `${offers.repair.cost} s`, 'Repair', () => {
            const r = ctx.progression.applyUpgrade('repair');
            if (!r.ok) this.ui.toast(r.why, 'warn');
          });
      }
      for (const t of offers.tiers) {
        addCard(cards, `${t.label} · Tier ${t.next}`,
          t.key === 'hullTier' ? 'Doubled frames and iron knees. The sea hits softer.'
            : t.key === 'sailTier' ? 'Tighter weave, truer cut. She points closer and runs faster.'
              : 'Re-bored barrels and better powder. Faster, harder broadsides.',
          `${t.cost} s`, 'Refit', () => {
            const r = ctx.progression.applyUpgrade('tier', t.key);
            if (!r.ok) this.ui.toast(r.why, 'warn');
          });
      }
      for (const p of offers.paints) {
        addCard(cards, `Paint — ${p.key[0].toUpperCase()}${p.key.slice(1)}`,
          'A fresh coat and a new waterline stripe.', `${p.cost} s`, 'Paint', () => {
            const r = ctx.progression.applyUpgrade('paint', p.key);
            if (!r.ok) this.ui.toast(r.why, 'warn');
          });
      }
      const ships = panel.querySelector('.ships');
      for (const s of offers.ships) {
        addCard(ships, s.type.name, s.type.blurb,
          `${s.type.cannonsPerSide * 2} guns · ${s.type.cargoCapacity} cargo · ${s.type.crewMax} crew · ${s.cost} s`,
          'Buy', () => {
            const r = ctx.progression.applyUpgrade('ship', s.type.key);
            if (!r.ok) this.ui.toast(r.why, 'warn');
          }, ctx.state.data.gold < s.cost);
      }
    };
    this.ui.openScreen('shipwright', render);
  }

  openTavern(port) {
    const ctx = this.ctx;
    const render = (panel) => {
      const candidates = ctx.crew?.candidatesFor(port.name) ?? [];
      panel.innerHTML = `
        <button class="close-x">✕</button>
        <h2>The Tavern — ${port.name}</h2>
        <div class="sub">Smoke, fiddle music, and every kind of talk that floats.
          Purse: <span style="color:#e8c860">${ctx.state.data.gold.toLocaleString('en-US')} s</span> ·
          Crew ${ctx.crew?.roster.length ?? 0}/${ctx.playerShip?.ship?.type?.crewMax ?? 8}</div>
        <div class="cards services"></div>
        <h2 style="margin-top:20px;font-size:16px">Hands for hire</h2>
        <div class="cards hires"></div>
      `;
      panel.querySelector('.close-x').onclick = () => this.ui.closeScreen();

      const services = panel.querySelector('.services');
      const rumorCard = document.createElement('div');
      rumorCard.className = 'card';
      rumorCard.innerHTML = `<h3>Buy a round · 15 s</h3><div class="desc">Loose lips and full cups. Someone always knows something.</div>`;
      const rb = document.createElement('button');
      rb.className = 'mini';
      rb.textContent = 'Listen in';
      rb.onclick = () => {
        if (ctx.state.data.gold < 15) return this.ui.toast('Not enough gold', 'warn');
        ctx.state.addGold(-15);
        const rumors = ctx.data.lore.rumors;
        this.ui.say('Tavern talk', rumors[Math.floor(Math.random() * rumors.length)]);
      };
      rumorCard.appendChild(rb);
      services.appendChild(rumorCard);

      const mapCard = document.createElement('div');
      mapCard.className = 'card';
      mapCard.innerHTML = `<h3>Old chart · 90 s</h3><div class="desc">"Found it on a dead man's table. The X is honest, I swear it."</div>`;
      const mb = document.createElement('button');
      mb.className = 'mini';
      mb.textContent = 'Buy the map';
      mb.onclick = () => {
        const r = ctx.treasure?.buyMap(port.name, 90);
        if (!r?.ok) this.ui.toast(r?.why ?? 'No maps today', 'warn');
        render(panel);
      };
      mapCard.appendChild(mb);
      services.appendChild(mapCard);

      const hires = panel.querySelector('.hires');
      for (const cand of candidates) {
        const card = document.createElement('div');
        card.className = 'card';
        card.appendChild(portraitCanvas(cand.name));
        card.insertAdjacentHTML('beforeend', `
          <h3>${cand.name}</h3>
          <div class="crole" style="font-size:11px;color:var(--brass);letter-spacing:2px;text-transform:uppercase">${cand.role}</div>
          <div class="stars">${'★'.repeat(cand.skill)}${'☆'.repeat(5 - cand.skill)}</div>
          <div class="desc">${cand.story}</div>
          <div class="meta">${cand.cost} s to sign · ${cand.wage} s/day</div>
        `);
        const hb = document.createElement('button');
        hb.className = 'mini primary';
        hb.textContent = 'Hire';
        hb.onclick = () => {
          const r = ctx.crew.hire(cand);
          if (!r.ok) this.ui.toast(r.why, 'warn');
          else render(panel);
        };
        card.appendChild(hb);
        hires.appendChild(card);
      }
    };
    this.ui.openScreen('tavern', render);
  }

  openQuestBoard(port) {
    const ctx = this.ctx;
    const render = (panel) => {
      const available = ctx.quests?.available(port.name) ?? [];
      panel.innerHTML = `
        <button class="close-x">✕</button>
        <h2>Quest Board — ${port.name}</h2>
        <div class="sub">Contracts, pleas, and one or two honest offers.</div>
        <div class="cards"></div>
      `;
      panel.querySelector('.close-x').onclick = () => this.ui.closeScreen();
      const cards = panel.querySelector('.cards');
      if (!available.length) {
        cards.innerHTML = '<div class="sub">Nothing posted today that isn\'t already spoken for.</div>';
      }
      for (const q of available) {
        const card = document.createElement('div');
        card.className = 'card';
        const r = q.rewards ?? {};
        card.innerHTML = `
          <h3>${q.chapter ? `Ch.${q.chapter} — ` : ''}${q.title}</h3>
          <div class="desc">${q.text}</div>
          <div class="meta">${r.gold ? `${r.gold} s · ` : ''}${r.xp ?? 0} xp</div>
        `;
        const b = document.createElement('button');
        b.className = 'mini primary';
        b.textContent = 'Accept';
        b.onclick = () => {
          ctx.quests.accept(q.id);
          render(panel);
        };
        card.appendChild(b);
        cards.appendChild(card);
      }
    };
    this.ui.openScreen('questboard', render);
  }
}
