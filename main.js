import './style.css';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DEFAULT_SEED, CURVE_SAMPLES, normalizeSeed, randomSeed, generateForm, createCurveTexture } from './form-generator.js';
import { initVault } from './vault-ui.js';

const $ = (selector) => document.querySelector(selector);
const forms = [
  { name: 'Kıvrım', description: 'Kendi içine dönen bir sonsuzluk.', note: 'Bir çizginin kendisiyle karşılaşması.', chord: [110, 164.81, 220, 277.18] },
  { name: 'Çiçek', description: 'Hiçbir bahçede açmayan bir çiçek.', note: 'Bir ihtimalin beş yaprağı.', chord: [130.81, 164.81, 196, 261.63] },
  { name: 'Yörünge', description: 'Bir merkezi olmayan çekim.', note: 'Aynı yere farklı bir yoldan dönmek.', chord: [98, 146.83, 196, 246.94] },
  { name: 'Gelgit', description: 'Katı bir maddenin sıvı hatırası.', note: 'Bir dalganın unutamadığı kıyı.', chord: [116.54, 174.61, 233.08, 293.66] },
  { name: 'Sonsuz', description: 'Her tohumdan başka bir dünya.', note: 'Olasılıkların bir sonu yok.', chord: [110, 165, 220, 275] },
];
const materials = [
  { name: 'Bakır', color: '#b4421c', metalness: 0.62, roughness: 0.33, sheen: '#d15c31' },
  { name: 'Porselen', color: '#ede4d2', metalness: 0.04, roughness: 0.3, sheen: '#e8d4b6' },
  { name: 'Grafit', color: '#202b24', metalness: 0.28, roughness: 0.36, sheen: '#657163' },
];
const url = new URL(location.href);
function parseInteger(value, min, max, fallback) {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  form: parseInteger(url.searchParams.get('form'), 0, 4, 4),
  material: parseInteger(url.searchParams.get('matter'), 0, 2, 0),
  seed: normalizeSeed(url.searchParams.get('seed')) || parseInteger(url.searchParams.get('seed'), 1, 99999, 4109),
  paused: reducedMotion.matches,
  sound: false,
  flow: 0.4,
  pressing: false,
  unfolded: false,
  time: 0,
};
if (state.form === 4 && !normalizeSeed(state.seed)) state.seed = DEFAULT_SEED;
let recipeFrom = generateForm(normalizeSeed(state.seed) || DEFAULT_SEED);
let recipeTo = recipeFrom;
recipeFrom.texture = createCurveTexture(recipeFrom);
let pendingRecipe = null;
let recipeProgress = 1;
const activeForm = () => state.form === 4 ? recipeTo : forms[state.form];
const legacyPhase = () => typeof state.seed === 'number' ? state.seed * 0.001 + 0.3 : parseInt(state.seed.slice(0, 8), 16) / 4294967296 * 75 + 0.3;
const seedLabel = () => typeof state.seed === 'number' ? String(state.seed).padStart(5, '0') : `${state.seed.slice(0, 4)}·${state.seed.slice(4, 8)}`.toUpperCase();
const stage = $('.stage');
const canvas = $('#sculpture');
const cursor = $('#cursor-ring');
const weights = new THREE.Vector4(...[0, 1, 2, 3].map((i) => +(i === (state.form === 4 ? 0 : state.form))));
const targetWeights = weights.clone();
const pointer = new THREE.Vector2();
const smoothPointer = new THREE.Vector2();
let renderer, scene, camera, sculpture, surface, shadow, material;
let bloom = 0, bloomVelocity = 0, dragRotationX = 0, dragRotationY = 0;
let dragStart = null, hover = false, lastFrame = performance.now(), elapsed = 0, activeElapsed = 0;
let autoRotation = 0, lastSoundUpdate = 0, ready = false, animationFrame;
let toastTimeout, soundEngine;
let vaultPulseUntil = 0, vaultPhaseTimer;

function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('visible'), 3200);
}
function updateAddress() {
  const next = new URL(location.href);
  next.searchParams.set('seed', state.seed);
  next.searchParams.set('form', state.form);
  next.searchParams.set('matter', state.material);
  if (state.form === 4) next.searchParams.set('v', '2');
  else next.searchParams.delete('v');
  history.replaceState(null, '', next.pathname + next.search + next.hash);
}
function updateLabels() {
  $('#form-name').textContent = activeForm().name;
  $('#form-description').textContent = activeForm().description;
  $('#description-index').textContent = state.form === 4 ? '∞ / FORM' : `0${state.form + 1} / 04`;
  $('#specimen-number').textContent = state.form === 4 ? 'NESNE ∞' : `NESNE 00${state.form + 1}`;
  $('#seed-label').textContent = `TOHUM ${seedLabel()}`;
  canvas.dataset.formMode = state.form === 4 ? 'infinite' : 'preset';
  canvas.dataset.seed = String(state.seed);
  $('#material-name').textContent = materials[state.material].name;
  document.querySelectorAll('[data-form]').forEach((button) => {
    const selected = +button.dataset.form === state.form;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('[data-material]').forEach((button) => {
    const selected = +button.dataset.material === state.material;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('#pause').setAttribute('aria-pressed', String(state.paused));
  $('#pause').setAttribute('aria-label', state.paused ? 'Zamanı başlat' : 'Zamanı durdur');
  $('#pause').title = state.paused ? 'Zamanı başlat · Boşluk' : 'Zamanı durdur · Boşluk';
  $('#live-status').textContent = state.paused ? 'DURGUN' : 'CANLI';
  stage.classList.toggle('paused', state.paused);
}

// Each separated ribbon follows a shared, deformable curve. Surface normals are
// derived from the same function in the vertex shader, keeping every fold lit.
const parametricShader = /* glsl */ `
  uniform vec4 uShape;
  uniform float uTime;
  uniform float uBloom;
  uniform float uSeed;
  uniform vec2 uPointer;
  uniform float uGenerated;
  uniform float uRecipeMorph;
  uniform sampler2D uCurveFrom;
  uniform sampler2D uCurveTo;
  uniform vec4 uTubeFrom;
  uniform vec4 uTubeTo;
  uniform vec4 uDetailFrom;
  uniform vec4 uDetailTo;
  uniform vec4 uScaleFrom;
  uniform vec4 uScaleTo;
  const float PI = 3.14159265359;
  const float TAU = 6.28318530718;

  vec3 centre(float a) {
    float phase = uSeed * 0.39;
    vec3 c0 = vec3((1.12 + 0.37*cos(3.0*a))*cos(2.0*a), 0.73*sin(3.0*a), (1.12 + 0.37*cos(3.0*a))*sin(2.0*a));
    float flower = 1.13 + 0.44*cos(5.0*a + phase*0.13);
    vec3 c1 = vec3(flower*cos(a), 0.29*sin(5.0*a), flower*sin(a));
    vec3 c2 = vec3(1.34*cos(a), 0.82*sin(3.0*a), 1.34*sin(a));
    vec3 c3 = vec3((1.04 + 0.21*cos(3.0*a))*cos(a), 0.74*cos(2.0*a), (1.04 + 0.21*cos(3.0*a))*sin(a));
    vec3 c = c0*uShape.x + c1*uShape.y + c2*uShape.z + c3*uShape.w;
    c *= 1.0 + 0.06*sin(4.0*a + phase);
    c.y += 0.065*sin(2.0*a + phase) + 0.035*sin(a*6.0 + uTime*0.65);
    return c * (1.0 + uBloom*0.12);
  }

  vec3 legacySurface(vec2 coord) {
    float a = coord.x * TAU;
    float b = coord.y * TAU;
    vec3 c = centre(a);
    vec3 tangent = normalize(centre(a+0.002) - centre(a-0.002));
    vec3 reference = normalize(vec3(c.x, 0.0, c.z));
    vec3 binormal = normalize(cross(tangent, reference));
    vec3 normal = normalize(cross(binormal, tangent));
    float phi = b + 2.0*a + 0.12*sin(3.0*a + uSeed*0.1) + uBloom*0.45*sin(3.0*b);
    float radius = dot(uShape, vec4(0.36, 0.29, 0.20, 0.55));
    radius += 0.055*cos(3.0*phi + 3.0*a) + 0.025*sin(24.0*a + 2.0*phi + uSeed);
    radius *= 1.0 + 0.06*sin(uTime*0.6 + 3.0*a) + uBloom*1.15;
    vec3 p = c + (normal*cos(phi) + binormal*sin(phi))*radius;
    float nearPointer = exp(-length(p.xy*0.45 - uPointer)*2.7);
    p += normal * nearPointer * 0.04 * sin(a*6.0 + uTime);
    p.y += uBloom * 0.16*sin(5.0*a + phi);
    p += uBloom*0.25*vec3(sin(3.0*b+a), cos(2.0*b-a), sin(4.0*b+a));
    return p;
  }

  vec3 curveRow(sampler2D curve, float u, float row) {
    float position = fract(u) * ${CURVE_SAMPLES.toFixed(1)};
    float first = floor(position);
    float next = mod(first + 1.0, ${CURVE_SAMPLES.toFixed(1)});
    float height = (row + 0.5) / 3.0;
    vec3 a = texture2D(curve, vec2((first + 0.5) / ${CURVE_SAMPLES.toFixed(1)}, height)).xyz;
    vec3 b = texture2D(curve, vec2((next + 0.5) / ${CURVE_SAMPLES.toFixed(1)}, height)).xyz;
    return mix(a, b, fract(position));
  }

  vec3 generatedSurface(vec2 coord, sampler2D curve, vec4 tube, vec4 detail, vec4 shape) {
    float a = coord.x * TAU;
    float b = coord.y * TAU;
    vec3 c = curveRow(curve, coord.x, 0.0) * (1.0 + uBloom * 0.12);
    vec3 normal = curveRow(curve, coord.x, 1.0);
    vec3 binormal = curveRow(curve, coord.x, 2.0);
    normal /= max(length(normal), 0.000001);
    binormal /= max(length(binormal), 0.000001);
    float phi = b + tube.z*a + tube.w + uBloom*0.45*sin(3.0*b);
    float radius = tube.x * (1.0 + detail.w*cos(detail.z*a + shape.z));
    radius += detail.y*sin(detail.x*a + 2.0*phi + shape.y);
    radius *= 1.0 + uBloom*1.15;
    vec3 p = c + normal*cos(phi)*radius + binormal*sin(phi)*radius*tube.y;
    p += uBloom*0.2*vec3(sin(3.0*b+a), cos(2.0*b-a), sin(4.0*b+a));
    p *= shape.x;
    p *= 1.0 + 0.025*sin(uTime*0.65 + a*3.0 + shape.y);
    float nearPointer = exp(-length(p.xy*0.45 - uPointer)*2.7);
    p += normal*nearPointer*0.035*sin(a*6.0 + uTime);
    return p;
  }

  vec3 infiniteSurface(vec2 coord) {
    if (uRecipeMorph > 0.9999) return generatedSurface(coord, uCurveTo, uTubeTo, uDetailTo, uScaleTo);
    if (uRecipeMorph < 0.0001) return generatedSurface(coord, uCurveFrom, uTubeFrom, uDetailFrom, uScaleFrom);
    vec3 a = generatedSurface(coord, uCurveFrom, uTubeFrom, uDetailFrom, uScaleFrom);
    vec3 b = generatedSurface(coord, uCurveTo, uTubeTo, uDetailTo, uScaleTo);
    return mix(a, b, uRecipeMorph);
  }

  vec3 ribbonSurface(vec2 coord) {
    if (uGenerated > 0.9999) return infiniteSurface(coord);
    if (uGenerated < 0.0001) return legacySurface(coord);
    return mix(legacySurface(coord), infiniteSurface(coord), uGenerated);
  }
`;

function makeRibbonGeometry() {
  const bands = innerWidth < 760 ? 64 : 88;
  const segments = innerWidth < 760 ? 200 : 280;
  const columns = 3;
  const positions = [], coordinates = [], indices = [];
  for (let band = 0; band < bands; band++) {
    for (let segment = 0; segment <= segments; segment++) {
      for (let column = 0; column < columns; column++) {
        positions.push(0, 0, 0);
        coordinates.push(segment / segments, (band + 0.12 + 0.76 * column / (columns-1)) / bands);
        if (segment < segments && column < columns-1) {
          const i = band*(segments+1)*columns + segment*columns + column;
          indices.push(i, i+columns, i+1, i+1, i+columns, i+columns+1);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(coordinates, 2));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(positions.map((_,i) => i%3===1 ? 1 : 0), 3));
  geometry.setIndex(indices);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
  return geometry;
}

function initializeSculpture() {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth < 760 ? 1.5 : 1.8));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.setClearColor(0xeeeae1, 0);
  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  scene.environmentIntensity = 0.86;
  room.dispose();
  pmrem.dispose();
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.set(0, 0.42, 7.7);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xfff9ed, 0x81755d, 1.25));
  const key = new THREE.DirectionalLight(0xfff8ec, 3.1);
  key.position.set(-3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffcb99, 1.5);
  rim.position.set(4, 2, -4);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-2, -1, -2);
  scene.add(fill);

  surface = {
    uShape: { value: weights },
    uTime: { value: 0 },
    uBloom: { value: 0 },
    uSeed: { value: legacyPhase() },
    uPointer: { value: smoothPointer },
    uGenerated: { value: state.form === 4 ? 1 : 0 },
    uRecipeMorph: { value: 1 },
    uCurveFrom: { value: recipeFrom.texture },
    uCurveTo: { value: recipeTo.texture },
    uTubeFrom: { value: recipeFrom.tubeUniform },
    uTubeTo: { value: recipeTo.tubeUniform },
    uDetailFrom: { value: recipeFrom.detailUniform },
    uDetailTo: { value: recipeTo.detailUniform },
    uScaleFrom: { value: recipeFrom.scaleUniform },
    uScaleTo: { value: recipeTo.scaleUniform },
  };
  material = new THREE.MeshPhysicalMaterial({
    color: materials[state.material].color,
    metalness: materials[state.material].metalness,
    roughness: materials[state.material].roughness,
    clearcoat: 0.35,
    clearcoatRoughness: 0.34,
    sheen: 0.4,
    sheenColor: materials[state.material].sheen,
    side: THREE.DoubleSide,
    envMapIntensity: 1.3,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, surface);
    shader.vertexShader = parametricShader + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
      vec3 ribbonP = ribbonSurface(uv);
      vec3 ribbonU = ribbonSurface(uv + vec2(0.0002, 0.0));
      vec3 ribbonV = ribbonSurface(uv + vec2(0.0, 0.0002));
      vec3 ribbonNormal = cross(ribbonV-ribbonP, ribbonU-ribbonP);
      vec3 objectNormal = ribbonNormal / max(length(ribbonNormal), 0.00000001);
    `);
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = ribbonP;');
  };
  sculpture = new THREE.Group();
  sculpture.add(new THREE.Mesh(makeRibbonGeometry(), material));
  sculpture.rotation.set(0.45, -0.35, -0.19);
  scene.add(sculpture);

  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 128;
  const shadowContext = shadowCanvas.getContext('2d');
  const gradient = shadowContext.createRadialGradient(64,64,3,64,64,64);
  gradient.addColorStop(0, 'rgba(71,54,28,.26)');
  gradient.addColorStop(0.35, 'rgba(71,54,28,.14)');
  gradient.addColorStop(1, 'rgba(71,54,28,0)');
  shadowContext.fillStyle = gradient;
  shadowContext.fillRect(0,0,128,128);
  shadow = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 3.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false, opacity: 0.65 }));
  shadow.rotation.x = -Math.PI/2;
  shadow.position.y = -2.0;
  scene.add(shadow);
  createThumbnails();
  resize();
  ready = true;
  canvas.dataset.ready = 'true';
  animationFrame = requestAnimationFrame(animate);
}

function createThumbnails() {
  const previewCamera = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
  previewCamera.position.set(0, 1, 7.9);
  previewCamera.lookAt(0,0,0);
  renderer.setSize(150,150,false);
  shadow.visible = false;
  const originalShape = weights.clone();
  const originalGenerated = surface.uGenerated.value;
  const originalMorph = surface.uRecipeMorph.value;
  const originalBloom = surface.uBloom.value;
  surface.uRecipeMorph.value = 1;
  surface.uBloom.value = 0;
  for (let i=0; i<forms.length; i++) {
    weights.set(+(i===0),+(i===1),+(i===2),+(i===3));
    surface.uGenerated.value = i === 4 ? 1 : 0;
    renderer.render(scene, previewCamera);
    $(`#thumb-${i}`).src = canvas.toDataURL('image/png');
  }
  weights.copy(originalShape);
  surface.uGenerated.value = originalGenerated;
  surface.uRecipeMorph.value = originalMorph;
  surface.uBloom.value = originalBloom;
  shadow.visible = true;
}

function resize() {
  if (!renderer) return;
  const { width, height } = stage.getBoundingClientRect();
  renderer.setSize(width,height,false);
  camera.aspect = width/height;
  camera.position.z = camera.aspect < 1.04 ? 8.5/Math.max(camera.aspect,0.78) : 7.7;
  camera.updateProjectionMatrix();
}

function animate(now) {
  animationFrame = requestAnimationFrame(animate);
  const dt = Math.min((now-lastFrame)/1000, 0.04);
  lastFrame = now;
  if (document.hidden || !ready) return;
  elapsed += dt;
  activeElapsed += state.paused ? 0 : dt;
  if (!state.paused) {
    state.time += dt*(0.16 + state.flow*1.1);
    autoRotation += dt*(0.035 + state.flow*0.09);
  }
  weights.lerp(targetWeights, 1-Math.exp(-dt*(reducedMotion.matches ? 24 : 3.3)));
  surface.uGenerated.value = THREE.MathUtils.lerp(surface.uGenerated.value, state.form === 4 ? 1 : 0, 1-Math.exp(-dt*5));
  recipeProgress = Math.min(1, recipeProgress + dt / (reducedMotion.matches ? 0.08 : 0.85));
  surface.uRecipeMorph.value = recipeProgress * recipeProgress * (3 - 2 * recipeProgress);
  if (recipeProgress === 1 && pendingRecipe) {
    const nextRecipe = pendingRecipe;
    pendingRecipe = null;
    beginGeneratedForm(nextRecipe);
  }
  smoothPointer.lerp(pointer, 1-Math.exp(-dt*3.5));
  const targetBloom = state.pressing || state.unfolded || (!reducedMotion.matches && now < vaultPulseUntil) ? 1 : 0;
  bloomVelocity += ((targetBloom-bloom)*36 - bloomVelocity*10)*dt;
  bloom += bloomVelocity*dt;
  surface.uTime.value = state.time;
  surface.uBloom.value = Math.max(0,bloom);
  surface.uSeed.value = THREE.MathUtils.lerp(surface.uSeed.value, legacyPhase(), 1-Math.exp(-dt*1.7));
  sculpture.rotation.x = 0.45 + dragRotationX + smoothPointer.y*0.10 + (reducedMotion.matches ? 0 : Math.sin(state.time*.4)*.04);
  sculpture.rotation.y = -0.35 + dragRotationY + autoRotation + smoothPointer.x*.12;
  sculpture.rotation.z = -0.19;
  sculpture.position.y = 0.13 + (reducedMotion.matches ? 0 : Math.sin(state.time*.7)*.045);
  shadow.material.opacity = 0.65 - bloom*0.13;
  shadow.scale.setScalar(1+bloom*.13);
  renderer.render(scene, camera);
  if (state.form === 4 && recipeProgress === 1 && surface.uGenerated.value > 0.999) canvas.dataset.renderedSeed = recipeTo.seed;
  const seconds = Math.floor(activeElapsed);
  $('#live-time').textContent = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
  if (soundEngine && state.sound && now-lastSoundUpdate>160) {
    updateSound();
    lastSoundUpdate = now;
  }
}

function selectForm(index) {
  if (index === 4) { randomize(); return; }
  state.form = index;
  pendingRecipe = null;
  if (surface && surface.uGenerated.value > 0.99) weights.set(+(index===0),+(index===1),+(index===2),+(index===3));
  targetWeights.set(+(index===0),+(index===1),+(index===2),+(index===3));
  updateLabels();
  updateAddress();
  playNote(activeForm().chord[2]);
}
function selectMaterial(index) {
  state.material = index;
  if (material) {
    const chosen = materials[index];
    material.color.set(chosen.color);
    material.metalness = chosen.metalness;
    material.roughness = chosen.roughness;
    material.sheenColor.set(chosen.sheen);
  }
  updateLabels();
  updateAddress();
}
function beginGeneratedForm(recipe) {
  if (recipeFrom !== recipeTo) recipeFrom.texture.dispose();
  recipeFrom = recipeTo;
  recipeTo = recipe;
  recipeTo.texture = createCurveTexture(recipeTo);
  recipeProgress = 0;
  surface.uRecipeMorph.value = 0;
  surface.uCurveFrom.value = recipeFrom.texture;
  surface.uCurveTo.value = recipeTo.texture;
  surface.uTubeFrom.value = recipeFrom.tubeUniform;
  surface.uTubeTo.value = recipeTo.tubeUniform;
  surface.uDetailFrom.value = recipeFrom.detailUniform;
  surface.uDetailTo.value = recipeTo.detailUniform;
  surface.uScaleFrom.value = recipeFrom.scaleUniform;
  surface.uScaleTo.value = recipeTo.scaleUniform;
  state.seed = recipe.seed;
  state.form = 4;
  createThumbnails();
  resize();
  updateLabels();
  updateAddress();
  dragRotationX = 0;
  dragRotationY = 0;
  playNote(recipe.chord[2]);
}
function randomize() {
  const nextRecipe = generateForm(randomSeed());
  if (!surface) return;
  if (recipeProgress < 1) pendingRecipe = nextRecipe;
  else beginGeneratedForm(nextRecipe);
}
function togglePause() {
  state.paused = !state.paused;
  updateLabels();
}
document.querySelectorAll('[data-form]').forEach((button) => button.addEventListener('click', () => selectForm(+button.dataset.form)));
document.querySelectorAll('[data-material]').forEach((button) => button.addEventListener('click', () => selectMaterial(+button.dataset.material)));
$('#randomize').addEventListener('click', randomize);
$('#pause').addEventListener('click', togglePause);
$('#touch-hint').addEventListener('click', () => {
  state.unfolded = !state.unfolded;
  $('#touch-hint').setAttribute('aria-pressed', String(state.unfolded));
  $('#touch-hint').setAttribute('aria-label', state.unfolded ? 'Katmanları kapat' : 'Katmanları aç');
  $('#unfold-label').textContent = state.unfolded ? 'YENİDEN TOPLA ↙' : 'İÇİNİ AÇ ↗';
  playNote(activeForm().chord[3]*2);
});
$('#flow').addEventListener('input', (event) => {
  state.flow = +event.target.value/100;
  event.target.setAttribute('aria-valuetext', `Yüzde ${event.target.value}`);
});

function movePointer(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.set((event.clientX-rect.left)/rect.width*2-1, -((event.clientY-rect.top)/rect.height*2-1));
  if (event.pointerType === 'mouse') {
    cursor.style.left = `${event.clientX}px`;
    cursor.style.top = `${event.clientY}px`;
    cursor.style.display = 'flex';
    canvas.style.cursor = 'none';
  }
  if (dragStart) {
    dragRotationY += (event.clientX-dragStart.x)*0.007;
    dragRotationX += (event.clientY-dragStart.y)*0.005;
    dragStart = { x: event.clientX, y: event.clientY };
  }
}
canvas.addEventListener('pointermove', movePointer);
canvas.addEventListener('pointerenter', () => { hover = true; });
canvas.addEventListener('pointerleave', () => {
  hover = false;
  cursor.style.display = 'none';
  pointer.set(0,0);
});
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 && event.pointerType==='mouse') return;
  event.preventDefault();
  canvas.focus({ preventScroll:true });
  canvas.setPointerCapture(event.pointerId);
  state.pressing = true;
  dragStart = { x:event.clientX, y:event.clientY };
  stage.classList.add('engaged');
  cursor.classList.add('pressed');
  playNote(activeForm().chord[3]*2);
});
function release() {
  state.pressing = false;
  dragStart = null;
  cursor.classList.remove('pressed');
  if (!hover) cursor.style.display = 'none';
}
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);
window.addEventListener('blur', release);
canvas.addEventListener('lostpointercapture', release);
canvas.addEventListener('keydown', (event) => {
  if (event.key==='Enter') { event.preventDefault(); state.pressing=true; stage.classList.add('engaged'); }
  if (event.key==='ArrowLeft') { event.preventDefault(); dragRotationY-=.12; }
  if (event.key==='ArrowRight') { event.preventDefault(); dragRotationY+=.12; }
  if (event.key==='ArrowUp') { event.preventDefault(); dragRotationX-=.12; }
  if (event.key==='ArrowDown') { event.preventDefault(); dragRotationX+=.12; }
});
canvas.addEventListener('keyup', (event) => { if (event.key==='Enter') release(); });
window.addEventListener('keydown', (event) => {
  if ($('#about-dialog').open || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.toLowerCase() === 'n') { event.preventDefault(); if (!event.repeat) randomize(); return; }
  if (/^(BUTTON|A)$/.test(event.target.tagName)) return;
  if (event.code==='Space') { event.preventDefault(); if (!event.repeat) togglePause(); }
  if (/^[1-4]$/.test(event.key)) selectForm(+event.key-1);
});

const dialog = $('#about-dialog');
$('#about-open').addEventListener('click', () => { release(); dialog.showModal(); });
$('#about-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  const rect = dialog.getBoundingClientRect();
  if (event.target===dialog && (event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom)) dialog.close();
});

function createSound() {
  const context = new (window.AudioContext || window.webkitAudioContext)();
  const master = context.createGain();
  master.gain.value = 0;
  master.connect(context.destination);
  const filter = context.createBiquadFilter();
  filter.type='lowpass'; filter.frequency.value=750; filter.Q.value=.5;
  const delay=context.createDelay(1); delay.delayTime.value=.43;
  const feedback=context.createGain(); feedback.gain.value=.3;
  const wet=context.createGain(); wet.gain.value=.28;
  filter.connect(master); filter.connect(delay); delay.connect(feedback); feedback.connect(delay); delay.connect(wet); wet.connect(master);
  const voices = activeForm().chord.map((frequency,i) => {
    const oscillator=context.createOscillator(); oscillator.type=i===1?'triangle':'sine'; oscillator.frequency.value=frequency; oscillator.detune.value=[-4,3,-2,5][i];
    const gain=context.createGain(); gain.gain.value=[.16,.035,.055,.04][i];
    oscillator.connect(gain); gain.connect(filter); oscillator.start();
    return {oscillator,gain};
  });
  return {context,master,filter,voices,delay};
}
async function toggleSound() {
  try {
    if (!soundEngine) soundEngine=createSound();
    await soundEngine.context.resume();
    state.sound=!state.sound;
    soundEngine.master.gain.setTargetAtTime(state.sound?.32:0,soundEngine.context.currentTime,.3);
    $('#sound').setAttribute('aria-pressed',String(state.sound));
    $('#sound').setAttribute('aria-label',state.sound?'Sesi kapat':'Sesi aç');
    $('#sound').title=state.sound?'Sesi kapat':'Sesi aç';
    if (state.sound) { updateSound(); notify('Sesi de dokunuşun şekillendiriyor.'); }
  } catch { notify('Bu tarayıcıda ses başlatılamadı.'); }
}
function updateSound() {
  const {context,filter,voices}=soundEngine;
  filter.frequency.setTargetAtTime(450 + state.flow*950 + bloom*2400 + (smoothPointer.x+1)*200,context.currentTime,.15);
  voices.forEach((voice,i) => voice.oscillator.frequency.setTargetAtTime(activeForm().chord[i]*(1+bloom*.035),context.currentTime,.6));
}
function playNote(frequency) {
  if (!soundEngine || !state.sound) return;
  const {context,master}=soundEngine;
  const note=context.createOscillator(); note.type='sine'; note.frequency.value=frequency;
  const gain=context.createGain(); gain.gain.setValueAtTime(0,context.currentTime); gain.gain.linearRampToValueAtTime(.15,context.currentTime+.015); gain.gain.exponentialRampToValueAtTime(.0001,context.currentTime+2.2);
  note.connect(gain); gain.connect(master); note.start(); note.stop(context.currentTime+2.3);
  note.onended=() => {note.disconnect();gain.disconnect();};
}
$('#sound').addEventListener('click',toggleSound);
document.addEventListener('visibilitychange', () => {
  lastFrame=performance.now(); release();
  if (soundEngine) soundEngine.master.gain.setTargetAtTime(!document.hidden && state.sound?.32:0,soundEngine.context.currentTime,.15);
});

async function savePoster() {
  if (!ready) return;
  const button=$('#save');
  button.disabled=true;
  try {
    await document.fonts.ready;
    const poster=document.createElement('canvas'); poster.width=1600; poster.height=2000;
    const ctx=poster.getContext('2d');
    ctx.fillStyle='#eeeae1'; ctx.fillRect(0,0,1600,2000);
    ctx.strokeStyle='#c6bdac'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(100,155); ctx.lineTo(1500,155); ctx.moveTo(100,1780); ctx.lineTo(1500,1780); ctx.stroke();
    ctx.fillStyle='#292924'; ctx.font='600 31px Manrope'; ctx.fillText('E Ş İ K',100,108);
    ctx.font='17px Plex'; ctx.textAlign='right'; ctx.fillStyle='#807665'; ctx.fillText('3D FORM ATÖLYESİ',1500,105);
    ctx.textAlign='left'; ctx.fillStyle='#292924'; ctx.font='132px Instrument'; ctx.fillText('3D form',100,328); ctx.font='italic 132px Instrument'; ctx.fillStyle='#bc4f32'; ctx.fillText('çalışması.',100,456);
    const exportCamera=new THREE.PerspectiveCamera(35,1400/1160,.1,50); exportCamera.position.set(0,.42,8.5*(1+Math.max(0,bloom)*.6)); exportCamera.lookAt(0,0,0);
    const ratio=renderer.getPixelRatio();
    try {
      renderer.setPixelRatio(1); renderer.setSize(1400,1160,false); renderer.render(scene,exportCamera);
      ctx.drawImage(canvas,100,520,1400,1160);
    } finally {renderer.setPixelRatio(ratio);resize();renderer.render(scene,camera);}
    ctx.fillStyle='#292924'; ctx.font='74px Instrument'; ctx.fillText(activeForm().name,100,1728);
    ctx.fillStyle='#807665'; ctx.font='20px Manrope'; ctx.textAlign='right'; ctx.fillText(activeForm().note,1500,1724);
    ctx.textAlign='left'; ctx.font='17px Plex'; ctx.fillText(`NESNE ${state.form === 4 ? '∞' : '00'+(state.form+1)}    /    ${materials[state.material].name.toLocaleUpperCase('tr-TR')}    /    TOHUM ${seedLabel()}`,100,1840);
    ctx.textAlign='right'; ctx.fillText('makeme.parzi.dev',1500,1880);
    const blob=await new Promise((resolve)=>poster.toBlob(resolve,'image/png'));
    if (!blob) throw new Error('PNG could not be created');
    const link=document.createElement('a'); const blobUrl=URL.createObjectURL(blob);
    link.href=blobUrl; link.download=`esik-${activeForm().name.toLocaleLowerCase('tr-TR').replaceAll(' ','-')}-${state.seed}.png`; link.click();
    setTimeout(()=>URL.revokeObjectURL(blobUrl),60000);
    notify('Afiş indirildi.');
  } catch {notify('Afiş kaydedilemedi. Bir kez daha deneyebilirsin.');}
  finally {button.disabled=false;}
}
$('#save').addEventListener('click',savePoster);
new ResizeObserver(resize).observe(stage);
reducedMotion.addEventListener('change', (event) => { if(event.matches){state.paused=true;updateLabels();} });
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault(); ready=false;cancelAnimationFrame(animationFrame);
  $('#stage-fallback').hidden=false;
  $('#save').disabled=true;
  notify('Görsel bağlantısı kesildi. Sayfayı yenileyerek yeniden açabilirsin.');
});
updateLabels();
try {initializeSculpture();}
catch(error) {
  console.error('EŞİK could not initialize:',error);
  $('#stage-fallback').hidden=false;
  $('#save').disabled=true;
  $('#pause').disabled=true;
  $('#sound').disabled=true;
  canvas.hidden=true;
}
initVault({ notify, initialWorkspace: url.searchParams.get('workspace') === 'art' ? 'art' : 'vault', onPhase(phase) {
  clearTimeout(vaultPhaseTimer);
  stage.classList.toggle('crypto-working', phase === 'working');
  stage.classList.toggle('crypto-success', phase === 'success');
  vaultPulseUntil = phase === 'idle' ? 0 : performance.now() + 1600;
  if (phase === 'success') {
    playNote(activeForm().chord[3] * 2);
    vaultPhaseTimer = setTimeout(() => stage.classList.remove('crypto-success'), 2000);
  }
} });
