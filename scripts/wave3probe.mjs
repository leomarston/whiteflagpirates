// Focused Wave 3 probe: crew figures close-up, enemy target panel, boardable cue,
// visible battle damage, nav beacons. Boots built game headless in Chromium.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] ?? 'http://localhost:4174/';
const outDir = process.argv[3] ?? 'shots3probe';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
    '--disable-dev-shm-usage', '--window-size=1440,810'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
await page.addInitScript(() => {
  localStorage.setItem('whiteflagpirates_save_v1_settings', JSON.stringify({ quality: 'low' }));
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const shot = async (n) => { await page.screenshot({ path: path.join(outDir, n + '.png') }); console.log('shot', n); };

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(6000);
await page.evaluate(() => { const c = window.__WFP; c.beginGame ? c.beginGame(true) : c.events.emit('game:start', { fresh: true }); });
await page.waitForTimeout(3500);

// --- 1. Spawn an enemy ship right off the starboard bow + point camera at it
const spawn = await page.evaluate(() => {
  const ctx = window.__WFP;
  const ps = ctx.playerShip?.ship; if (!ps) return 'no-player';
  const g = ps.group;
  const hd = ps.physics.heading;
  // 90m ahead and a touch to starboard
  const fx = Math.sin(hd), fz = Math.cos(hd);
  const ex = g.position.x + fx * 90 + Math.cos(hd) * 30;
  const ez = g.position.z + fz * 90 - Math.sin(hd) * 30;
  let enemy = null;
  try {
    enemy = ctx.ships.createShip('brig', { faction: 'crown', name: 'HMS Test' });
    enemy.group.position.set(ex, 0, ez);
    enemy.physics.heading = hd + Math.PI; // facing us
    if (ctx.enemies?.list) ctx.enemies.list.push(enemy);
  } catch (e) { return 'spawn-err:' + e; }
  // damage it to ~20% hull so it's boardable + shows battle damage
  enemy.hull = enemy.hullMax * 0.2;
  enemy.crewCount = 3;
  enemy._boardable = true;
  return { ex: +ex.toFixed(0), ez: +ez.toFixed(0), enemyHull: enemy.hull, hullMax: enemy.hullMax };
});
console.log('spawn:', JSON.stringify(spawn));
await page.waitForTimeout(2500);
await shot('20-target-panel');

// --- 2. Force the naval target scan + read the HUD state
const tstate = await page.evaluate(() => {
  const ctx = window.__WFP;
  const t = ctx.combat?.currentTarget;
  const panel = document.getElementById('target-panel');
  const beaconLayer = document.getElementById('beacon-layer');
  return {
    currentTarget: t ? { name: t.name, faction: t.faction, hullFrac: +(t.hullFrac).toFixed(2), crewCount: t.crewCount, boardable: t.boardable, distance: +(t.distance).toFixed(0) } : null,
    panelVisible: panel ? !panel.classList.contains('hidden') && getComputedStyle(panel).display !== 'none' : 'no-panel',
    panelText: panel ? panel.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) : null,
    beaconMarkers: beaconLayer ? [...beaconLayer.children].filter((c) => getComputedStyle(c).display !== 'none').length : 'no-layer',
  };
});
console.log('target-state:', JSON.stringify(tstate));

// --- 3. Close-up on the player deck to see crew figures
await page.evaluate(() => {
  const ctx = window.__WFP;
  const ps = ctx.playerShip?.ship; if (!ps) return;
  const g = ps.group;
  const cam = ctx.camera;
  // put camera above & behind the deck looking forward-down
  const hd = ps.physics.heading;
  cam.position.set(g.position.x - Math.sin(hd) * 10, g.position.y + 7, g.position.z - Math.cos(hd) * 10);
  cam.lookAt(g.position.x, g.position.y + 1.5, g.position.z);
  if (ctx.engine) ctx.engine._freezeCam = true; // best-effort; may be ignored
});
await page.waitForTimeout(400);
await shot('21-crew-closeup');

const crewInfo = await page.evaluate(() => {
  const ctx = window.__WFP;
  const ps = ctx.playerShip?.ship;
  // find crew instanced meshes in the scene
  let crewMeshes = 0, totalInstances = 0;
  ctx.scene.traverse((o) => {
    if (o.isInstancedMesh && (o.name?.toLowerCase().includes('crew') || o.userData?.crew)) {
      crewMeshes++; totalInstances += o.count;
    }
  });
  return { crewMeshes, totalInstances, playerCrewCount: ps?.crewCount };
});
console.log('crew-info:', JSON.stringify(crewInfo));

console.log('ERRORS:', errors.length);
errors.slice(0, 8).forEach((e) => console.log('  [err]', e.slice(0, 200)));
await browser.close();
