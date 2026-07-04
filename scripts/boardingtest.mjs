// Headless drive of the playable boarding melee: spawn a crippled prize, accept
// the boarding, verify we drop to a foot fight on her deck, clear it, and return
// to the helm with loot. Screenshots the melee and the aftermath.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] ?? 'http://localhost:4177/';
const outDir = process.argv[3] ?? 'shotsboard';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
    '--disable-dev-shm-usage', '--window-size=1440,810'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
await page.addInitScript(() => localStorage.setItem('whiteflagpirates_save_v1_settings', JSON.stringify({ quality: 'low' })));
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const shot = async (n) => { await page.screenshot({ path: path.join(outDir, n + '.png') }); console.log('shot', n); };

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(6000);
await page.evaluate(() => { const c = window.__WFP; c.beginGame ? c.beginGame(true) : c.events.emit('game:start', { fresh: true }); });
await page.waitForTimeout(3000);

// --- spawn a crippled prize just off the bow and accept the boarding
const begin = await page.evaluate(() => {
  const ctx = window.__WFP;
  const ps = ctx.playerShip?.ship; if (!ps) return 'no-player';
  const g = ps.group, hd = ps.physics.heading;
  const ex = g.position.x + Math.sin(hd) * 40;
  const ez = g.position.z + Math.cos(hd) * 40;
  const enemy = ctx.ships.createShip('brig', { faction: 'crown', name: 'HMS Quarry' });
  enemy.group.position.set(ex, 0, ez);
  enemy.physics.placeAt(ex, ez, hd);
  enemy.hull = enemy.hullMax * 0.18;
  enemy.crewCount = 5;
  enemy._boardable = true;
  ctx.enemies.entries.push({ ship: enemy, brain: { role: 'patrol', state: 'engage', broadsideSide: 'L' } });
  window.__prize = enemy;
  ctx.events.emit('boarding:accept', { ship: enemy });
  return 'accepted';
});
console.log('begin:', begin);
await page.waitForTimeout(1600); // let the grapple beat pass

const inFight = await page.evaluate(() => {
  const ctx = window.__WFP;
  const b = ctx.boarding;
  return {
    mode: ctx.mode,
    active: b?.active,
    hostiles: b?._hostiles?.length,
    hostilesAlive: b?._hostiles?.filter((h) => h && h.alive).length,
    dynSurfaces: ctx.world?.dynamicSurfaces?.length,
    charY: +(ctx.character?.position?.y ?? -99).toFixed(2),
    charAlive: ctx.character?.alive,
  };
});
console.log('in-fight:', JSON.stringify(inFight));
await shot('30-melee');

// --- resolve: clear the enemy deck to force a victory
const goldBefore = await page.evaluate(() => window.__WFP.state?.data?.gold ?? 0);
await page.evaluate(() => {
  const b = window.__WFP.boarding;
  for (const h of b._hostiles) { if (h) { h.hp = 0; h.alive = false; } }
});
await page.waitForTimeout(1500);

const after = await page.evaluate(() => {
  const ctx = window.__WFP;
  return {
    mode: ctx.mode,
    active: ctx.boarding?.active,
    dynSurfaces: ctx.world?.dynamicSurfaces?.length,
    prizeSinking: window.__prize?.sinking,
    prizeAlive: window.__prize?.alive,
    gold: ctx.state?.data?.gold ?? 0,
    hostilesInMgr: ctx.npcs?.hostiles?.length,
  };
});
console.log('after-victory:', JSON.stringify(after), 'goldBefore', goldBefore);
await shot('31-aftermath');

console.log('ERRORS:', errors.length);
errors.slice(0, 10).forEach((e) => console.log('  [err]', e.slice(0, 220)));
await browser.close();
