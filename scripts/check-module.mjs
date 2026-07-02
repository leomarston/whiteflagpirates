#!/usr/bin/env node
// Import-checks module files in Node (no DOM). Usage:
//   node scripts/check-module.mjs src/world/ocean.js [more files...]
// Modules must not touch document/window at top level (see docs/CONTRACTS.md).
// CSS imports are not supported here — never import .css from module files.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

let failed = 0;
for (const rel of process.argv.slice(2)) {
  const abs = path.resolve(rel);
  try {
    await import(pathToFileURL(abs).href);
    console.log(`OK   ${rel}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${rel}`);
    console.error('  ' + String(err?.stack ?? err).split('\n').slice(0, 6).join('\n  '));
  }
}
process.exit(failed ? 1 : 0);
