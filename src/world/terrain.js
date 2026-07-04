// Analytic island terrain — single source of truth for meshes AND queries.
// heightAt()/slopeAt() are called every frame by ship & character physics, so
// they must stay fast and must be the *exact* function the meshes are built
// from (see worldgen.js). Keep frequencies low enough that a reasonably
// tessellated mesh can follow them — fine surface detail lives in the shader,
// never in this height field, so visuals and collision never disagree.
import { clamp01, fbm2, lerp, SimplexNoise, smoothstep } from '../core/utils.js';

export const SEABED = -38;

// peak  — summit height (m)
// detail— relief amplitude ridden on the base falloff
// ridged— fold the fbm into sharp ridge lines (crags / volcanoes)
// rough — surface exponent bias (higher = rockier flanks)
const BIOME_PARAMS = {
  tropical: { peak: 74, detail: 14, ridged: false, rough: 1.0 },
  jungle: { peak: 118, detail: 22, ridged: false, rough: 1.05 },
  volcanic: { peak: 205, detail: 26, ridged: true, rough: 1.15 },
  mangrove: { peak: 11, detail: 4, ridged: false, rough: 0.9 },
  atoll: { peak: 7, detail: 2, ridged: false, rough: 0.9 },
  rock: { peak: 104, detail: 30, ridged: true, rough: 1.2 },
};

export class TerrainField {
  constructor(islandDefs) {
    this.islands = islandDefs.map((def) => ({
      def,
      cx: def.position[0],
      cz: def.position[1],
      r: def.radius,
      bound: def.radius * 1.75,
      noise: new SimplexNoise(def.seed),
      params: BIOME_PARAMS[def.biome] ?? BIOME_PARAMS.tropical,
    }));
  }

  /** World-space ground height (negative = seabed). Fast: early-out per island. */
  heightAt(x, z) {
    let h = SEABED;
    for (let i = 0; i < this.islands.length; i++) {
      const isl = this.islands[i];
      const dx = x - isl.cx;
      const dz = z - isl.cz;
      if (Math.abs(dx) > isl.bound || Math.abs(dz) > isl.bound) continue;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > isl.bound) continue;
      const hi = this._islandHeight(isl, dx, dz, d);
      if (hi > h) h = hi;
    }
    return h;
  }

  _islandHeight(isl, dx, dz, d) {
    const { noise, params, r, def } = isl;

    // Organic coastline. The primary angular warp is kept byte-identical to the
    // formula the world map silhouettes reconstruct from (see ui/map.js); a
    // small secondary warp adds coves without moving the footprint.
    const ang = Math.atan2(dz, dx);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const warp = fbm2(noise, ca * 1.6 + 10.7, sa * 1.6 + 3.1, 3);
    const warp2 = fbm2(noise, ca * 4.3 - 5.2, sa * 4.3 + 8.4, 2);
    const rr = r * (1 + 0.24 * warp + 0.05 * warp2);

    if (d >= rr) {
      // underwater skirt down to the seabed (no floating edges)
      const t = clamp01((d - rr) / (rr * 0.62));
      return lerp(-0.8, SEABED, smoothstep(0, 1, t));
    }

    const t = 1 - d / rr;              // 0 at coast → 1 at center
    const f = t * t * (3 - 2 * t);     // smoothed falloff

    // Base relief — low frequency so the mesh can follow it exactly.
    let relief = fbm2(noise, (isl.cx + dx) * 0.008, (isl.cz + dz) * 0.008, 4);
    if (params.ridged) relief = 1 - Math.abs(relief) * 2; // sharp ridges
    // A gentle mid-scale undulation for handmade-feeling flanks.
    const undul = fbm2(noise, (isl.cx + dx) * 0.021 + 40, (isl.cz + dz) * 0.021 - 12, 2);

    let h;
    if (def.biome === 'atoll') {
      // ring reef with a lagoon dip in the middle
      const ring = Math.exp(-((t - 0.42) ** 2) / 0.028);
      h = ring * params.peak + relief * params.detail * ring;
      h += undul * params.detail * 0.4 * ring;
      if (t > 0.7) h -= (t - 0.7) * 14; // lagoon
    } else {
      h = Math.pow(f, 1.35 * params.rough) * params.peak + relief * params.detail * f;
      h += undul * params.detail * 0.5 * f;
      if (def.biome === 'volcanic' && f > 0.8) {
        h -= ((f - 0.8) / 0.2) * params.peak * 0.42; // crater bowl
      }
    }

    // gentle beaches: compress the band around the waterline
    if (h > -2 && h < 5) h *= 0.55;

    // ease into the water at the very coast
    if (t < 0.06) h = lerp(-0.8, h, t / 0.06);
    return h;
  }

  /** Approximate slope (rise over run). Build-time helper — not a hot path. */
  slopeAt(x, z) {
    const e = 2;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.sqrt(hx * hx + hz * hz) / (2 * e);
  }
}
