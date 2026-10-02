import { Curve, Vector3, Vector4, DataTexture, RGBAFormat, FloatType, NearestFilter } from 'three';

export const CURVE_SAMPLES = 512;
export const DEFAULT_SEED = 'b8740a35d39fe6421e759c084af6032b';
const TAU = Math.PI * 2;

export function normalizeSeed(value) {
  return typeof value === 'string' && /^[a-f\d]{32}$/i.test(value) ? value.toLowerCase() : null;
}

export function randomSeed(cryptoProvider = globalThis.crypto) {
  const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// All 128 seed bits feed this reproducible stream; there is no catalogue or
// small seed modulus. Keep this recipe stable so shared URLs remain replayable.
function seedStream(seed) {
  let [a, b, c, d] = seed.match(/.{8}/g).map((word) => parseInt(word, 16) >>> 0);
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const sum = (a + b + d) | 0;
    d = (d + 1) | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = (c << 21 | c >>> 11) + sum | 0;
    return (sum >>> 0) / 4294967296;
  };
  for (let i = 0; i < 16; i++) next();
  return next;
}

function greatestCommonDivisor(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

class GeneratedCurve extends Curve {
  constructor(recipe) { super(); this.recipe = recipe; this.arcLengthDivisions = 2048; }
  getPoint(t, target = new Vector3()) {
    const g = this.recipe;
    const a = t * TAU;
    const radial = 1 + g.fold * Math.cos(g.q * a + g.phases[0]);
    let x, y, z;
    if (g.kind === 0) {
      x = radial * Math.cos(g.p * a);
      y = g.height * Math.sin(g.q * a + g.phases[1]);
      z = radial * Math.sin(g.p * a);
    } else if (g.kind === 1) {
      x = radial * Math.cos(a);
      y = g.height * Math.sin(g.r * a + g.phases[1]);
      z = radial * Math.sin(a);
    } else if (g.kind === 2) {
      x = Math.cos(g.p * a + g.phases[0]);
      y = g.height * Math.sin(g.q * a + g.phases[1]);
      z = Math.sin(g.r * a + g.phases[2]);
    } else {
      x = radial * Math.cos(a);
      y = g.height * Math.sin(g.r * a + g.phases[1]) + g.fold * 0.35 * Math.cos(g.q * a);
      z = radial * Math.sin(a);
    }
    return target.set(
      x * g.stretch[0] + g.overtones[0] * Math.sin(g.r * a + g.phases[2]),
      y + g.overtones[1] * Math.sin((g.p + g.q) * a + g.phases[0]),
      z * g.stretch[1] + g.overtones[2] * Math.cos((g.r + 1) * a + g.phases[1]),
    );
  }
}

export function generateForm(seed) {
  seed = normalizeSeed(seed);
  if (!seed) throw new TypeError('A form needs a 128-bit hexadecimal seed.');
  const random = seedStream(seed);
  const between = (min, max) => min + random() * (max - min);
  const integer = (min, max) => Math.floor(between(min, max + 1));
  const recipe = {
    seed,
    kind: integer(0, 3),
    p: integer(1, 4),
    q: integer(2, 9),
    r: integer(1, 6),
    height: between(0.25, 0.95),
    fold: between(0.16, 0.58),
    stretch: [between(0.8, 1.3), between(0.8, 1.3)],
    overtones: [between(0.015, 0.22), between(0.015, 0.22), between(0.015, 0.22)],
    phases: [between(0, TAU), between(0, TAU), between(0, TAU)],
    tube: between(0.13, 0.47),
    flatness: between(0.32, 1.55),
    twist: integer(-3, 5),
    ripples: integer(8, 38),
    rippleDepth: between(0.008, 0.042),
    lobes: integer(2, 7),
    swelling: between(0.05, 0.4),
    scale: 1,
  };
  // Coprime windings avoid retracing the exact same knot multiple times.
  while (greatestCommonDivisor(recipe.p, recipe.q) !== 1) recipe.q = recipe.q % 9 + 2;
  if (recipe.kind === 2 && recipe.p === recipe.r) recipe.r = recipe.r % 6 + 1;
  if (recipe.kind === 3) { recipe.tube *= 1.2; recipe.flatness *= 0.65; }
  if (recipe.kind === 1) { recipe.height *= 0.6; recipe.p = 1; }

  const curve = new GeneratedCurve(recipe);
  const frames = curve.computeFrenetFrames(CURVE_SAMPLES, true);
  const data = new Float32Array(CURVE_SAMPLES * 3 * 4);
  const centre = new Vector3();
  let extent = 0;
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    curve.getPointAt(i / CURVE_SAMPLES, centre);
    extent = Math.max(extent, centre.length());
    const values = [centre, frames.normals[i], frames.binormals[i]];
    for (let row = 0; row < 3; row++) {
      const offset = (row * CURVE_SAMPLES + i) * 4;
      data[offset] = values[row].x;
      data[offset + 1] = values[row].y;
      data[offset + 2] = values[row].z;
      data[offset + 3] = 1;
    }
  }
  const tubeExtent = (recipe.tube * (1 + recipe.swelling) + recipe.rippleDepth) * Math.max(1, recipe.flatness) * 1.1;
  recipe.scale = 1.94 / (extent + tubeExtent);
  recipe.curveData = data;
  recipe.tubeUniform = new Vector4(recipe.tube, recipe.flatness, recipe.twist, recipe.phases[0]);
  recipe.detailUniform = new Vector4(recipe.ripples, recipe.rippleDepth, recipe.lobes, recipe.swelling);
  recipe.scaleUniform = new Vector4(recipe.scale, recipe.phases[1], recipe.phases[2], 0);
  const adjectives = ['Sessiz', 'Akışkan', 'Yabancı', 'Kırılgan', 'Dönen', 'Kavisli', 'Sonsuz', 'Saklı', 'İnce', 'Açık', 'Uzak', 'Bükülmüş'];
  const nouns = ['yankı', 'sedef', 'düş', 'halka', 'nefes', 'iz', 'gelgit', 'kıvrım', 'çiçek', 'düğüm', 'ufuk', 'ritim'];
  const descriptions = ['Bir ihtimalin daha önce görülmemiş hâli.', 'Kendi yolunu çizen bir madde.', 'Bir kıvrımdan doğan başka bir dünya.', 'Hiçbir kalıba sığmayan bir hareket.', 'Katmanlarının arasında saklı bir hikâye.', 'Birbirine değen iki ayrı olasılık.'];
  recipe.name = `${adjectives[integer(0, adjectives.length - 1)]} ${nouns[integer(0, nouns.length - 1)]}`;
  recipe.description = descriptions[integer(0, descriptions.length - 1)];
  recipe.note = 'Aynı tohum. Sana ait bir olasılık.';
  const root = [87.31, 98, 110, 116.54, 130.81, 146.83][integer(0, 5)];
  recipe.chord = [root, root * 1.5, root * 2, root * 2.5];
  return recipe;
}

export function createCurveTexture(recipe) {
  const texture = new DataTexture(recipe.curveData, CURVE_SAMPLES, 3, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// CPU counterpart of the GPU surface, used to verify generated geometry.
export function sampleForm(recipe, u, v, bloom = 0, time = 0, pointer = [0, 0]) {
  const position = (u % 1 + 1) % 1 * CURVE_SAMPLES;
  const first = Math.floor(position);
  const next = (first + 1) % CURVE_SAMPLES;
  const fraction = position - first;
  const read = (row) => {
    const a = (row * CURVE_SAMPLES + first) * 4;
    const b = (row * CURVE_SAMPLES + next) * 4;
    return new Vector3(...[0, 1, 2].map((axis) => recipe.curveData[a + axis] * (1 - fraction) + recipe.curveData[b + axis] * fraction));
  };
  const c = read(0).multiplyScalar(1 + bloom * 0.12);
  const n = read(1).normalize(), b = read(2).normalize();
  const a = u * TAU, angle = v * TAU;
  const phi = angle + recipe.twist * a + recipe.phases[0] + bloom * 0.45 * Math.sin(3 * angle);
  const radius = (recipe.tube * (1 + recipe.swelling * Math.cos(recipe.lobes * a + recipe.phases[2])) + recipe.rippleDepth * Math.sin(recipe.ripples * a + 2 * phi + recipe.phases[1])) * (1 + bloom * 1.15);
  c.addScaledVector(n, Math.cos(phi) * radius).addScaledVector(b, Math.sin(phi) * radius * recipe.flatness);
  c.add(new Vector3(Math.sin(3 * angle + a), Math.cos(2 * angle - a), Math.sin(4 * angle + a)).multiplyScalar(bloom * 0.2));
  c.multiplyScalar(recipe.scale * (1 + 0.025 * Math.sin(time * 0.65 + a * 3 + recipe.phases[1])));
  const nearPointer = Math.exp(-Math.hypot(c.x * 0.45 - pointer[0], c.y * 0.45 - pointer[1]) * 2.7);
  return c.addScaledVector(n, nearPointer * 0.035 * Math.sin(a * 6 + time));
}
