// World: island meshes, colors, and the registry every other system queries.
import * as THREE from 'three';
import { clamp, clamp01, lerp, mulberry32, smoothstep, SimplexNoise } from '../core/utils.js';
import { SEABED, TerrainField } from './terrain.js';
import { buildVegetation } from './vegetation.js';
import { buildProps } from './props.js';
import { buildPorts } from './ports.js';

// Per-biome vertical colour ramp. Bands (seabed → shallow turquoise → wet
// intertidal → dry sand → vegetation → rock/ash → summit) are blended by height
// and slope so shorelines read wet, cliffs read stony, and shallows glow.
const BIOME_COLORS = {
  tropical: { deep: 0x123138, shallow: 0x2ea79a, wet: 0x9c8558, sand: 0xdcc79a, sandHi: 0xe9dbb6, veg: 0x4f7d3b, vegHi: 0x77a455, dry: 0x9c9a5a, cliff: 0x6f6459, top: 0x8a8078 },
  jungle: { deep: 0x122f32, shallow: 0x2c8f86, wet: 0x7d6b45, sand: 0xccb888, sandHi: 0xdccb9c, veg: 0x2f5f2c, vegHi: 0x4f8a3a, dry: 0x5c6b34, cliff: 0x585047, top: 0x6b6157 },
  volcanic: { deep: 0x0f1a1e, shallow: 0x2b6f70, wet: 0x3a3330, sand: 0x4b453f, sandHi: 0x5f574e, veg: 0x494340, vegHi: 0x5a504a, dry: 0x38322f, cliff: 0x2e2a27, top: 0x211d1b, ember: 0xff5a1e },
  mangrove: { deep: 0x13272a, shallow: 0x2f7d6f, wet: 0x453a28, sand: 0x6d5c3f, sandHi: 0x7e6b49, veg: 0x47612f, vegHi: 0x60803d, dry: 0x53603a, cliff: 0x574b39, top: 0x5a5240 },
  atoll: { deep: 0x14828d, shallow: 0x3fccc1, wet: 0xd9c79f, sand: 0xeaddc0, sandHi: 0xf4edd7, veg: 0x8fb06a, vegHi: 0xbad293, dry: 0xcdbd93, cliff: 0xc9b285, top: 0xd8c496 },
  rock: { deep: 0x131b1f, shallow: 0x2c6a72, wet: 0x5b5348, sand: 0x8a8176, sandHi: 0x9a938a, veg: 0x6f7159, vegHi: 0x8a8d68, dry: 0x625a50, cliff: 0x4d463d, top: 0x8a857e },
};

const BEACH_TOP = 3.8;

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

// Fill `out` with the terrain colour at a vertex. Build-time only; all colours
// come from scratch objects so there is zero per-vertex allocation.
function paintVertex(pal, biome, h, slope, peak, nLarge, nFine, out) {
  if (h < -7) {
    out.setHex(pal.deep);
  } else if (h < -0.25) {
    // shallow water floor — sand/turquoise fading down into the deep bed
    const t = smoothstep(-7, -0.25, h);
    out.setHex(pal.deep).lerp(_c2.setHex(pal.shallow), t);
  } else if (h < 0.9) {
    // intertidal: darkened wet sand right at the waterline
    const t = smoothstep(0, 1, clamp01((h + 0.25) / 1.15));
    out.setHex(pal.shallow).lerp(_c2.setHex(pal.wet), t);
  } else if (h < BEACH_TOP) {
    const t = smoothstep(0, 1, clamp01((h - 0.9) / (BEACH_TOP - 0.9)));
    out.setHex(pal.wet).lerp(_c2.setHex(pal.sand), t);
    out.lerp(_c2.setHex(pal.sandHi), clamp01(nFine * 0.5 + 0.2) * 0.4); // dune tips
  } else {
    const at = clamp01((h - BEACH_TOP) / (peak * 0.8));
    out.setHex(pal.veg).lerp(_c2.setHex(pal.top), at * at);
    out.lerp(_c2.setHex(pal.vegHi), clamp01(nLarge * 0.5 + 0.5) * 0.35 * (1 - at));
    if (slope > 0.48) out.lerp(_c2.setHex(pal.cliff), clamp01((slope - 0.48) / 0.5));
    if (biome !== 'volcanic') {
      out.lerp(_c2.setHex(pal.dry), clamp01(nLarge) * 0.12 * smoothstep(0.15, 0.5, at));
    } else if (pal.ember && at > 0.55) {
      out.lerp(_c2.setHex(pal.ember), (at - 0.55) * 0.16); // lava-stained rim
    }
    // soften the beach → vegetation line into a dune-grass transition
    if (at < 0.14) out.lerp(_c2.setHex(pal.sand), (1 - at / 0.14) * 0.5);
  }
  // painterly per-vertex jitter (hue + value)
  out.offsetHSL(nFine * 0.012, 0.0, nLarge * 0.04);
}

// Seamless, tileable multi-octave value-noise texture used as a triplanar
// detail map multiplied into the vertex colours (fine grain, no UV stretch).
function makeDetailTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const img = g.createImageData(size, size);
  const acc = new Float32Array(size * size);
  const octaves = [[4, 0.5], [8, 0.28], [16, 0.15], [32, 0.09]];
  let seed = 9271;
  for (const [cells, amp] of octaves) {
    const rng = mulberry32(seed);
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const v = new Float32Array(cells * cells);
    for (let i = 0; i < v.length; i++) v[i] = rng();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells;
      const y0 = Math.floor(fy) % cells, y1 = (y0 + 1) % cells;
      const ty = fy - Math.floor(fy);
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const x0 = Math.floor(fx) % cells, x1 = (x0 + 1) % cells;
        const tx = fx - Math.floor(fx);
        const sx = tx * tx * (3 - 2 * tx);
        const a = v[y0 * cells + x0], b = v[y0 * cells + x1];
        const c = v[y1 * cells + x0], d = v[y1 * cells + x1];
        acc[y * size + x] += ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy) * amp;
      }
    }
  }
  for (let i = 0; i < acc.length; i++) {
    const g8 = clamp(Math.round(acc[i] * 255), 0, 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g8;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace; // used as a grayscale multiplier, not colour
  tex.anisotropy = 4;
  return tex;
}

// Inject triplanar detail-map multiply + world-space varyings into the shared
// terrain material. One compile, shared by every island mesh.
function installTerrainDetail(material, detailTex, amount) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: detailTex };
    shader.uniforms.uDetailScale = { value: 1 / 5.5 };  // ~5.5m grain
    shader.uniforms.uDetailScale2 = { value: 1 / 62 };  // broad mottle
    shader.uniforms.uDetailAmt = { value: amount };
    material.userData.shader = shader;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPosT;\nvarying vec3 vWNrmT;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vWNrmT = normalize(mat3(modelMatrix) * objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWPosT = (modelMatrix * vec4(transformed, 1.0)).xyz;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPosT;\nvarying vec3 vWNrmT;\nuniform sampler2D uDetail;\nuniform float uDetailScale;\nuniform float uDetailScale2;\nuniform float uDetailAmt;')
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec3 bw = abs(normalize(vWNrmT));
    bw = pow(bw, vec3(4.0));
    bw /= max(bw.x + bw.y + bw.z, 1e-4);
    float d1 = texture2D(uDetail, vWPosT.yz * uDetailScale).r * bw.x
             + texture2D(uDetail, vWPosT.xz * uDetailScale).r * bw.y
             + texture2D(uDetail, vWPosT.xy * uDetailScale).r * bw.z;
    float d2 = texture2D(uDetail, vWPosT.xz * uDetailScale2).r;
    float det = mix(d1, d2, 0.35);
    diffuseColor.rgb *= 1.0 + (det - 0.5) * uDetailAmt;
  }`);
  };
}

export class World {
  constructor(ctx) {
    this.ctx = ctx;
    this.field = new TerrainField(ctx.data.islands);
    this.islands = [];
    this.diveSpots = [];
    this.lava = [];
    this.group = new THREE.Group();
    this.group.name = 'world';
    ctx.scene.add(this.group);

    const prof = ctx.engine?.qualityProfile;
    this._detailTex = makeDetailTexture();
    const detailAmt = prof ? (prof.oceanDetail >= 1 ? 0.5 : prof.oceanDetail >= 0.75 ? 0.42 : 0.3) : 0.5;

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
    });
    installTerrainDetail(material, this._detailTex, detailAmt);
    this.material = material;

    for (const def of ctx.data.islands) {
      const record = this._buildIsland(def, material);
      this.islands.push(record);
    }

    this.vegetation = buildVegetation(ctx, this);
    this.props = buildProps(ctx, this);
    const ports = buildPorts(ctx, this);
    for (const port of ports) {
      const rec = this.islands.find((i) => i.def.id === port.islandId);
      if (rec) rec.port = port;
    }
    this.ports = ports;
  }

  _buildIsland(def, material) {
    const size = def.radius * 3.3;
    // Adaptive tessellation: keep roughly constant world-space quad size so big
    // islands aren't under-sampled, scaled by quality. Analytic queries are
    // unaffected — only the visual mesh density changes.
    const detailQ = this.ctx.engine?.qualityProfile?.oceanDetail ?? 1;
    let segs = Math.round(size / (15 / clamp(detailQ, 0.5, 1)));
    segs = clamp(segs - (segs % 2), 96, 220);

    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const [cx, cz] = def.position;
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const pal = BIOME_COLORS[def.biome] ?? BIOME_COLORS.tropical;
    const cnoise = new SimplexNoise(def.seed + 17);
    const peak = Math.max(8, this.field.islands.find((i) => i.def === def)?.params.peak ?? 60);

    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + cx;
      const wz = pos.getZ(i) + cz;
      const h = this.field.heightAt(wx, wz);
      pos.setY(i, h);

      const slope = h > 0.3 ? this.field.slopeAt(wx, wz) : 0;
      const nLarge = cnoise.noise2D(wx * 0.006, wz * 0.006);
      const nFine = cnoise.noise2D(wx * 0.05, wz * 0.05);
      paintVertex(pal, def.biome, h, slope, peak, nLarge, nFine, _c1);
      colors[i * 3] = _c1.r;
      colors[i * 3 + 1] = _c1.g;
      colors[i * 3 + 2] = _c1.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere(); // raised vertices → fix culling bounds

    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(cx, 0, cz);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);

    if (def.biome === 'volcanic') this._buildLava(def, cx, cz, peak);

    return {
      def,
      center: new THREE.Vector3(cx, 0, cz),
      radius: def.radius,
      mesh,
      port: null,
      rng: mulberry32(def.seed),
    };
  }

  // A glowing lava pool in the crater bowl of a volcanic island. One emissive
  // disc (bloom does the glow) plus a single warm point light, animated subtly.
  _buildLava(def, cx, cz, peak) {
    // find the crater floor: lowest point within the central bowl
    let bx = cx, bz = cz, bh = Infinity;
    for (let a = 0; a < 8; a++) {
      for (let rad = 0; rad <= 2; rad++) {
        const ang = (a / 8) * Math.PI * 2;
        const dd = rad * def.radius * 0.06;
        const x = cx + Math.cos(ang) * dd;
        const z = cz + Math.sin(ang) * dd;
        const h = this.field.heightAt(x, z);
        if (h < bh) { bh = h; bx = x; bz = z; }
      }
    }
    if (bh <= 2 || !isFinite(bh)) return; // no dry crater — skip
    const rLava = Math.max(6, def.radius * 0.09);
    const lavaGeo = new THREE.CircleGeometry(rLava, 20);
    lavaGeo.rotateX(-Math.PI / 2);
    const lavaMat = new THREE.MeshStandardMaterial({
      color: 0x2a0a04, emissive: 0xff4a12, emissiveIntensity: 1.4, roughness: 0.55, metalness: 0,
    });
    const lava = new THREE.Mesh(lavaGeo, lavaMat);
    lava.position.set(bx, bh + 0.4, bz);
    this.group.add(lava);

    const light = new THREE.PointLight(0xff5a1e, 6, rLava * 6, 1.8);
    light.position.set(bx, bh + rLava * 0.5, bz);
    this.group.add(light);

    this.lava.push({ mat: lavaMat, light, base: 1.4, lbase: 6, phase: def.seed * 0.001 });
  }

  getTerrainHeight(x, z) {
    return this.field.heightAt(x, z);
  }

  getNearestIsland(pos) {
    let best = null;
    let bestD = Infinity;
    for (const isl of this.islands) {
      const d = Math.hypot(pos.x - isl.center.x, pos.z - isl.center.z);
      if (d < bestD) { bestD = d; best = isl; }
    }
    return best ? { island: best, distance: bestD } : null;
  }

  getNearestPort(pos) {
    let best = null;
    let bestD = Infinity;
    for (const isl of this.islands) {
      if (!isl.port) continue;
      const d = pos.distanceTo(isl.port.dockPosition);
      if (d < bestD) { bestD = d; best = isl; }
    }
    return best ? { island: best, port: best.port, distance: bestD } : null;
  }

  /** Highest walkable surface at (x,z): terrain or a port deck rect. */
  getWalkHeight(x, z) {
    let h = this.field.heightAt(x, z);
    for (const port of this.ports) {
      for (const s of port.walkSurfaces) {
        // into surface space: local +Z runs along the rect's heading (rot)
        const dx = x - s.x;
        const dz = z - s.z;
        const sin = Math.sin(s.rot);
        const cos = Math.cos(s.rot);
        const lx = dx * cos - dz * sin;
        const lz = dx * sin + dz * cos;
        if (Math.abs(lx) <= s.hw && Math.abs(lz) <= s.hd && s.y > h) h = s.y;
      }
    }
    return h;
  }

  /** Alias kept for callers that expect the spot-height name (see contract). */
  getSpotHeight(x, z) {
    return this.getWalkHeight(x, z);
  }

  update(dt) {
    if (this.lava.length) {
      const t = this.ctx.time.t;
      for (const l of this.lava) {
        const flick = 0.82 + 0.18 * Math.sin(t * 1.7 + l.phase) + 0.06 * Math.sin(t * 5.3 + l.phase * 2);
        l.mat.emissiveIntensity = l.base * flick;
        l.light.intensity = l.lbase * flick;
      }
    }
    this.vegetation?.update?.(dt);
    this.props?.update?.(dt);
    for (const port of this.ports) port.update?.(dt);
  }
}

export { SEABED };
