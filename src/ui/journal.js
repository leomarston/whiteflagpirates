// The captain's journal: quests, log, crew, cargo, skills, standings, maps.
import { fbm2, SimplexNoise } from '../core/utils.js';

const TABS = [
  ['quests', 'Quests'], ['log', "Captain's Log"], ['crew', 'Crew'],
  ['cargo', 'Cargo'], ['skills', 'Skills'], ['standings', 'Standings'], ['maps', 'Maps'],
];

export class Journal {
  constructor(ctx, ui) {
    this.ctx = ctx;
    this.ui = ui;
  }

  open(tab = 'quests') {
    this.ui.openScreen('journal', (panel) => {
      panel.insertAdjacentHTML('beforeend', `
        <h2>Captain's Journal</h2>
        <div class="tabs"></div>
        <div class="tab-body" style="min-width:min(880px,88vw);min-height:380px"></div>
      `);
      const tabsEl = panel.querySelector('.tabs');
      const body = panel.querySelector('.tab-body');
      for (const [key, label] of TABS) {
        const b = document.createElement('button');
        b.textContent = label;
        b.dataset.tab = key;
        b.onclick = () => {
          tabsEl.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
          this._render(key, body);
        };
        tabsEl.appendChild(b);
      }
      const initial = tabsEl.querySelector(`[data-tab="${tab}"]`) ?? tabsEl.firstChild;
      initial.classList.add('active');
      this._render(initial.dataset.tab, body);
    });
  }

  _render(tab, body) {
    const fn = {
      quests: () => this._quests(body),
      log: () => this._log(body),
      crew: () => this._crew(body),
      cargo: () => this._cargo(body),
      skills: () => this._skills(body),
      standings: () => this._standings(body),
      maps: () => this._maps(body),
    }[tab];
    body.innerHTML = '';
    fn?.();
  }

  _quests(body) {
    const q = this.ctx.quests;
    const active = q?.activeDefs?.() ?? [];
    const completed = (this.ctx.state.data.quests.completed ?? [])
      .map((id) => q?.find(id)).filter(Boolean);
    if (!active.length && !completed.length) {
      body.innerHTML = '<div class="sub">The pages wait for ink. Find work at a quest board.</div>';
    }
    for (const def of active) {
      body.insertAdjacentHTML('beforeend', `
        <div class="quest-entry">
          <div class="qname">${def.chapter ? `Chapter ${def.chapter} — ` : ''}${def.title}</div>
          <div class="qobj">◈ ${q.objectiveText(def)}</div>
          <div class="qobj" style="opacity:0.7;font-style:italic">${def.text}</div>
        </div>
      `);
    }
    for (const def of completed) {
      body.insertAdjacentHTML('beforeend', `
        <div class="quest-entry done">
          <div class="qname">✓ ${def.title}</div>
        </div>
      `);
    }
  }

  _log(body) {
    const entries = [...(this.ctx.state.data.logEntries ?? [])].reverse();
    if (!entries.length) body.innerHTML = '<div class="sub">A clean page. Rare thing on this ship.</div>';
    for (const e of entries) {
      body.insertAdjacentHTML('beforeend', `<div class="log-entry">${e.text}</div>`);
    }
  }

  _crew(body) {
    const roster = this.ctx.crew?.roster ?? [];
    body.insertAdjacentHTML('beforeend', `
      <div class="sub">${roster.length} hands aboard ·
        morale ${Math.round(this.ctx.crew?.moraleAvg?.() ?? 0)} ·
        boarding strength ${Math.round(this.ctx.crew?.boardingStrength?.() ?? 0)}</div>
    `);
    roster.forEach((hand, i) => {
      const row = document.createElement('div');
      row.className = 'crew-card';
      row.innerHTML = `
        <div class="info">
          <div class="cname">${hand.name} <span class="stars" style="font-size:12px">${'★'.repeat(hand.skill)}</span></div>
          <div class="crole">${hand.role} · ${hand.wage} s/day</div>
          <div class="cstory">${hand.story}</div>
        </div>
        <div class="morale-bar"><div class="bar stam"><i style="width:${hand.morale}%"></i></div></div>
      `;
      const b = document.createElement('button');
      b.className = 'mini danger';
      b.textContent = 'Pay off';
      b.onclick = () => {
        this.ctx.crew.dismiss(i);
        this._render('crew', body.parentElement.querySelector('.tab-body') ?? body);
      };
      row.appendChild(b);
      body.appendChild(row);
    });
  }

  _cargo(body) {
    const cargo = this.ctx.state.data.cargo ?? {};
    const goods = this.ctx.data.goods;
    body.insertAdjacentHTML('beforeend', `
      <div class="sub">Hold: ${this.ctx.economy?.cargoUsed() ?? 0} / ${this.ctx.economy?.cargoCapacity() ?? 0}</div>
      <div class="cargo-grid"></div>
    `);
    const grid = body.querySelector('.cargo-grid');
    const entries = Object.entries(cargo).filter(([, qty]) => qty > 0);
    if (!entries.length) grid.innerHTML = '<div class="sub">Nothing but ballast and ambition.</div>';
    for (const [key, qty] of entries) {
      const good = goods.find((g) => g.key === key);
      grid.insertAdjacentHTML('beforeend', `
        <div class="cargo-item"><b>${qty}×</b> ${good?.name ?? key}
          <div style="opacity:0.6;font-size:11px">${good?.weight ?? 1} wt each · base ${good?.basePrice ?? '?'} s</div>
        </div>
      `);
    }
  }

  _skills(body) {
    const prog = this.ctx.progression;
    const skills = prog?.SKILLS ?? {};
    const d = this.ctx.state.data;
    body.insertAdjacentHTML('beforeend', `
      <div class="sub">Level ${d.level} · ${d.xp} xp ·
        next at ${prog?.xpForLevel?.(d.level + 1) ?? '—'} xp ·
        <b style="color:var(--brass)">${d.skillPoints} point${d.skillPoints === 1 ? '' : 's'} to spend</b></div>
      <div class="skill-branches"></div>
    `);
    const wrap = body.querySelector('.skill-branches');
    for (const [branchKey, branch] of Object.entries(skills)) {
      const col = document.createElement('div');
      col.className = 'skill-branch';
      col.innerHTML = `<h3 style="color:${branch.color}">${branch.name}</h3>`;
      branch.tiers.forEach((tier, i) => {
        const owned = !!d.skills[tier.key];
        const can = prog.canUnlock(branchKey, i);
        const node = document.createElement('div');
        node.className = `skill-node${owned ? ' owned' : ''}${can ? ' can' : ''}`;
        node.innerHTML = `<div class="sname">${tier.name}</div><div class="sdesc">${tier.desc}</div>`;
        if (can) {
          node.onclick = () => {
            prog.unlock(branchKey, i);
            this._render('skills', body);
          };
        }
        col.appendChild(node);
      });
      wrap.appendChild(col);
    }
  }

  _standings(body) {
    const rep = this.ctx.state.data.reputation;
    const factions = this.ctx.data.factions;
    for (const [key, value] of Object.entries(rep)) {
      const f = factions[key];
      if (!f) continue;
      const pct = ((value + 100) / 200) * 100;
      body.insertAdjacentHTML('beforeend', `
        <div class="rep-row">
          <div class="fname">${f.name}</div>
          <div class="rep-track"><i style="left:calc(${pct}% - 2px)"></i></div>
          <div class="rlabel">${this.ctx.progression?.repLabel?.(value) ?? value}</div>
        </div>
        <div style="font-size:12px;font-style:italic;opacity:0.55;margin:-6px 0 10px 2px">${f.motto}</div>
      `);
    }
  }

  _maps(body) {
    const maps = this.ctx.state.data.maps ?? [];
    body.insertAdjacentHTML('beforeend', '<div class="maps-list cards"></div>');
    const list = body.querySelector('.maps-list');
    if (!maps.length) list.innerHTML = '<div class="sub">No charts but the honest one. Taverns sell the other kind.</div>';
    for (const map of maps) {
      const island = this.ctx.data.islands.find((i) => i.id === map.islandId);
      const card = document.createElement('div');
      card.className = 'card';
      card.appendChild(this._sketch(island, map));
      card.insertAdjacentHTML('beforeend', `
        <div>
          <h3>${island?.name ?? 'Unknown shore'} ${map.found ? '· <span style="color:var(--good)">recovered</span>' : ''}</h3>
          <div class="desc">${map.riddle}</div>
        </div>
      `);
      list.appendChild(card);
    }
  }

  _sketch(island, map) {
    const c = document.createElement('canvas');
    c.width = c.height = 110;
    c.className = 'map-sketch';
    const g = c.getContext('2d');
    g.fillStyle = '#e4d6b4';
    g.fillRect(0, 0, 110, 110);
    if (!island) return c;
    const noise = new SimplexNoise(island.seed);
    g.beginPath();
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = 38 * (0.82 + 0.3 * fbm2(noise, Math.cos(a) * 1.6 + 10.7, Math.sin(a) * 1.6 + 3.1, 3));
      const x = 55 + Math.cos(a) * r;
      const y = 55 + Math.sin(a) * r;
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.closePath();
    g.fillStyle = '#c9b285';
    g.fill();
    g.strokeStyle = 'rgba(60,40,15,0.7)';
    g.stroke();
    // the X
    const dx = 55 + ((map.x - island.position[0]) / island.radius) * 38;
    const dy = 55 + ((map.z - island.position[1]) / island.radius) * 38;
    g.fillStyle = map.found ? 'rgba(126,42,30,0.4)' : '#7e2a1e';
    g.font = '16px Georgia';
    g.textAlign = 'center';
    g.fillText('✕', dx, dy + 6);
    return c;
  }
}
