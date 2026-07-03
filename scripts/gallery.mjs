#!/usr/bin/env node
// Quality gallery: boots the built game and captures a broad set of scenarios
// at the highest quality the headless GL can manage, for visual QA across waves.
// Usage: node scripts/gallery.mjs <url> <outDir> [quality=high]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] ?? 'http://localhost:4173/';
const outDir = process.argv[3] ?? 'gallery';
const quality = process.argv[4] ?? 'high';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript((q) => {
  localStorage.setItem('whiteflagpirates_save_v1_settings', JSON.stringify({ quality: q }));
}, quality);

const errs = new Set();
page.on('pageerror', (e) => { const s = String(e); if (!errs.has(s)) { errs.add(s); console.log('ERR', s.slice(0, 180)); } });
page.on('console', (m) => { if (m.type() === 'error') { const s = m.text(); if (!/404/.test(s) && !errs.has(s)) { errs.add(s); console.log('CERR', s.slice(0, 180)); } } });

const shot = (n) => page.screenshot({ path: path.join(outDir, n + '.png') }).then(() => console.log('shot', n));
const set = (fn, ...a) => page.evaluate(fn, ...a);

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(6500);
await shot('00-title');
await set(() => document.querySelectorAll('button')[0].click());
await page.waitForTimeout(3000);

// open-sea, full sail, broad reach
await set(() => { const c = window.__WFP; c.playerShip.ship.physics.placeAt(0, 0, c.weather.wind.angle + 2.0); c.playerShip.sailTarget = 1; c.playerShip.anchored = false; c.playerShip.ship.physics.anchored = false; c.time.dayFrac = 0.42; });
await page.keyboard.down('w'); await page.waitForTimeout(6000); await page.keyboard.up('w');
await shot('01-open-sea-day');

// golden hour
await set(() => { window.__WFP.time.dayFrac = 0.76; });
await page.waitForTimeout(3500); await shot('02-golden-hour');

// night
await set(() => { window.__WFP.time.dayFrac = 0.02; });
await page.waitForTimeout(3000); await shot('03-night');

// storm
await set(() => { const c = window.__WFP; c.time.dayFrac = 0.45; c.weather.forceCondition('storm'); });
await page.waitForTimeout(14000); await shot('04-storm');

// combat: spawn an enemy close and fire a broadside
await set(() => {
  const c = window.__WFP; c.weather.forceCondition('fair'); c.time.dayFrac = 0.5;
  const p = c.playerShip.ship.position;
  c.events.emit('spawn:ship', { typeKey: 'frigate', faction: 'crown', role: 'hunter' });
  setTimeout(() => { const e = c.enemies.entries.at(-1); if (e) e.ship.physics.placeAt(p.x + 130, p.z + 40, 3); }, 400);
});
await page.waitForTimeout(5000);
await page.mouse.move(800, 420); await page.mouse.down({ button: 'right' }); await page.waitForTimeout(700);
await page.mouse.down({ button: 'left' }); await page.waitForTimeout(150); await page.mouse.up({ button: 'left' });
await page.waitForTimeout(400); await shot('05-broadside'); await page.mouse.up({ button: 'right' });

// harbor approach (Gullhaven)
await set(() => { const c = window.__WFP; const isl = c.world.islands.find(i => i.def.id === 'gullhaven'); const d = isl.port.dockPosition; c.playerShip.ship.physics.placeAt(d.x + 70, d.z + 70, Math.atan2(d.x - isl.center.x, d.z - isl.center.z) + Math.PI); c.time.dayFrac = 0.55; });
await page.waitForTimeout(2500); await shot('06-harbor');

// harbor at dusk (lanterns)
await set(() => { window.__WFP.time.dayFrac = 0.8; });
await page.waitForTimeout(3000); await shot('07-harbor-dusk');

// on foot ashore (volcanic island)
await set(() => {
  const c = window.__WFP; c.time.dayFrac = 0.5;
  const isl = c.world.islands.find(i => i.def.id === 'verdantine') || c.world.islands[3];
  const px = isl.center.x + isl.radius + 60, pz = isl.center.z;
  c.playerShip.ship.physics.placeAt(px, pz, Math.atan2(isl.center.x - px, isl.center.z - pz));
});
await page.waitForTimeout(1200);
await page.keyboard.press('e'); await page.waitForTimeout(2500);
await shot('08-ashore');

const perf = await set(() => ({ fps: Math.round(window.__WFP.engine.fps), calls: window.__WFP.renderer.info.render.calls, tris: window.__WFP.renderer.info.render.triangles }));
console.log('perf:', JSON.stringify(perf));
console.log('ERRORS:', errs.size);
await browser.close();
process.exit(0);
