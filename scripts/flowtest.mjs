// Flow test: dock → port menu → ashore → walk → combat anim → tavern → market
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const out = process.argv[2] ?? 'flowshots';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
await page.addInitScript(() => { localStorage.setItem('whiteflagpirates_save_v1_settings', JSON.stringify({ quality: 'low' })); });
const errs = new Set();
page.on('pageerror', (e) => { const s = String(e); if (!errs.has(s)) { errs.add(s); console.log('ERR', s.slice(0, 300)); } });
page.on('console', (m) => { if (m.type() === 'error') { const s = m.text(); if (!errs.has(s)) { errs.add(s); console.log('CERR', s.slice(0, 300)); } } });
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` }).then(() => console.log('shot', n));

await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.evaluate(() => document.querySelectorAll('button')[0].click());
await page.waitForTimeout(3000);

// teleport just off Gullhaven's dock, slow, facing it
await page.evaluate(() => {
  const c = window.__WFP;
  const isl = c.world.islands.find((i) => i.def.id === 'gullhaven');
  const d = isl.port.dockPosition;
  c.playerShip.ship.physics.placeAt(d.x, d.z, 0);
});
await page.waitForTimeout(2500);
await shot('20-at-dock');
const dockState = await page.evaluate(() => {
  const c = window.__WFP;
  const near = c.world.getNearestPort(c.playerShip.ship.position);
  return { dist: Math.round(near.distance), speed: +c.playerShip.ship.physics.speed.toFixed(1) };
});
console.log('dock:', JSON.stringify(dockState));
await page.keyboard.press('e');
await page.waitForTimeout(1500);
await shot('21-dock-menu');

// step ashore
const stepped = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#screen-root button')];
  const b = btns.find((x) => /ashore/i.test(x.textContent));
  if (b) { b.click(); return true; }
  return btns.map((x) => x.textContent);
});
console.log('ashore:', JSON.stringify(stepped));
await page.waitForTimeout(2500);
await shot('22-ashore');
console.log('foot:', await page.evaluate(() => {
  const c = window.__WFP;
  return JSON.stringify({
    mode: c.mode,
    pos: [Math.round(c.character.position.x), +c.character.position.y.toFixed(1), Math.round(c.character.position.z)],
    npcs: c.npcs.npcs.length,
  });
}));

// walk toward town
await page.keyboard.down('w');
await page.waitForTimeout(6000);
await page.keyboard.up('w');
await shot('23-walking');

// swing sword
await page.mouse.click(720, 400);
await page.waitForTimeout(600);
await shot('24-sword');

// talk to someone if близко — otherwise open tavern via api
await page.evaluate(() => {
  const c = window.__WFP;
  const isl = c.world.islands.find((i) => i.def.id === 'gullhaven');
  c.ui.trading.openTavern(isl.port);
});
await page.waitForTimeout(1200);
await shot('25-tavern');
await page.keyboard.press('Escape');

await page.evaluate(() => {
  const c = window.__WFP;
  const isl = c.world.islands.find((i) => i.def.id === 'gullhaven');
  c.ui.trading.openMarket(isl.port);
});
await page.waitForTimeout(1000);
await shot('26-market');
await page.keyboard.press('Escape');

// journal skills
await page.keyboard.press('k');
await page.waitForTimeout(1000);
await shot('27-skills');
await page.keyboard.press('Escape');

// spawn an enemy ship & watch a broadside exchange
await page.evaluate(() => {
  const c = window.__WFP;
  c.setMode('sail');
  const p = c.playerShip.ship.position;
  c.events.emit('spawn:ship', { typeKey: 'brig', faction: 'crown', role: 'hunter' });
  // pull it close for the camera
  setTimeout(() => {
    const e = c.enemies.entries[c.enemies.entries.length - 1];
    if (e) e.ship.physics.placeAt(p.x + 120, p.z + 60, 3);
  }, 500);
});
await page.waitForTimeout(6000);
await shot('28-enemy');
console.log('enemy:', await page.evaluate(() => {
  const c = window.__WFP;
  return JSON.stringify({
    entries: c.enemies.entries.map((e) => ({ n: e.ship.name, s: e.brain.state, hull: Math.round(e.ship.hull) })),
    threat: c.enemies.threatLevel,
  });
}));
// player fires a broadside at it
await page.mouse.move(720, 400);
await page.mouse.down({ button: 'right' });
await page.waitForTimeout(700);
await page.mouse.down({ button: 'left' });
await page.waitForTimeout(150);
await page.mouse.up({ button: 'left' });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(2000);
await shot('29-battle');

console.log('ERRORS:', errs.size);
await browser.close();
