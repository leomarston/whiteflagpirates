#!/usr/bin/env node
// Headless playtest harness: boots the built game in Chromium, drives basic
// flows, captures console errors and screenshots.
// Usage: node scripts/playtest.mjs <url> <outDir> [--quick]

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] ?? 'http://localhost:4173/';
const outDir = process.argv[3] ?? 'shots';
const quick = process.argv.includes('--quick');
fs.mkdirSync(outDir, { recursive: true });

const executablePath = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: [
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage',
    '--window-size=1440,810',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
// software rendering is slow — force the low quality preset before boot
await page.addInitScript(() => {
  localStorage.setItem('whiteflagpirates_save_v1_settings', JSON.stringify({ quality: 'low' }));
});

const errors = [];
const warned = new Set();
page.on('console', (msg) => {
  const text = msg.text();
  if (msg.type() === 'error' && !warned.has(text)) {
    warned.add(text);
    errors.push(text);
    console.log('[console.error]', text.slice(0, 500));
  }
});
page.on('pageerror', (err) => {
  const text = String(err);
  if (!warned.has(text)) {
    warned.add(text);
    errors.push(text);
    console.log('[pageerror]', text.slice(0, 800));
  }
});

async function shot(name) {
  await page.screenshot({ path: path.join(outDir, name + '.png') });
  console.log('shot:', name);
}

console.log('goto', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(quick ? 4000 : 8000);
await shot('01-title');

// Start a fresh voyage via the game API if UI buttons are unclickable headless
const started = await page.evaluate(() => {
  const ctx = window.__WFP;
  if (!ctx) return 'no-ctx';
  try {
    // click New Voyage if a button exists
    const btns = [...document.querySelectorAll('button, .menu-item, [data-action]')];
    const nv = btns.find((b) => /new voyage/i.test(b.textContent ?? ''));
    if (nv) { nv.click(); return 'clicked'; }
    if (ctx.beginGame) { ctx.beginGame(true); return 'beginGame'; }
    ctx.events.emit('game:start', { fresh: true });
    return 'event';
  } catch (e) { return 'err:' + e; }
});
console.log('start:', started);
await page.waitForTimeout(quick ? 3500 : 6000);
await shot('02-sailing');

const probe = await page.evaluate(() => {
  const ctx = window.__WFP;
  if (!ctx) return null;
  const g = ctx.playerShip?.ship?.group;
  return {
    mode: ctx.mode,
    fps: Math.round(ctx.engine?.fps ?? -1),
    shipPos: g ? [g.position.x, g.position.y, g.position.z].map((v) => +v.toFixed(1)) : null,
    seaState: +(ctx.ocean?.seaState ?? -1).toFixed(2),
    weather: ctx.weather?.condition,
    islands: ctx.world?.islands?.length,
    drawCalls: ctx.renderer?.info?.render?.calls,
    triangles: ctx.renderer?.info?.render?.triangles,
    systemsNull: Object.entries(ctx).filter(([, v]) => v === null).map(([k]) => k),
  };
});
console.log('probe:', JSON.stringify(probe));

if (!quick) {
  // sail forward for a bit
  await page.keyboard.down('w');
  await page.waitForTimeout(6000);
  await page.keyboard.up('w');
  await shot('03-underway');

  // aim + fire
  await page.mouse.move(720, 400);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(800);
  await shot('04-aiming');
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(120);
  await page.mouse.up({ button: 'left' });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(1500);
  await shot('05-broadside');

  // map + journal
  await page.keyboard.press('m');
  await page.waitForTimeout(800);
  await shot('06-map');
  await page.keyboard.press('Escape');
  await page.keyboard.press('j');
  await page.waitForTimeout(800);
  await shot('07-journal');
  await page.keyboard.press('Escape');

  // time-of-day sweep
  await page.evaluate(() => { window.__WFP.time.dayFrac = 0.78; });
  await page.waitForTimeout(1500);
  await shot('08-sunset');
  await page.evaluate(() => { window.__WFP.time.dayFrac = 0.02; });
  await page.waitForTimeout(1500);
  await shot('09-night');
  await page.evaluate(() => { window.__WFP.time.dayFrac = 0.45; });

  // storm
  await page.evaluate(() => {
    const w = window.__WFP.weather;
    if (w?.forceCondition) w.forceCondition('storm');
    else if (w) { w.condition = 'storm'; window.__WFP.ocean?.setSeaState(1); }
  });
  await page.waitForTimeout(4000);
  await shot('10-storm');

  // teleport near Gullhaven port for a town look
  await page.evaluate(() => {
    const ctx = window.__WFP;
    const isl = ctx.world?.islands?.find((i) => i.def.id === 'gullhaven');
    const d = isl?.port?.dockPosition;
    const g = ctx.playerShip?.ship?.group;
    if (d && g) {
      g.position.set(d.x + 60, g.position.y, d.z + 60);
    }
  });
  await page.waitForTimeout(2500);
  await shot('11-harbor');
}

const finalProbe = await page.evaluate(() => ({
  fps: Math.round(window.__WFP?.engine?.fps ?? -1),
  calls: window.__WFP?.renderer?.info?.render?.calls,
  tris: window.__WFP?.renderer?.info?.render?.triangles,
}));
console.log('final:', JSON.stringify(finalProbe));
console.log('ERRORS:', errors.length);
for (const e of errors.slice(0, 30)) console.log(' -', e.slice(0, 300));

await browser.close();
process.exit(0);
