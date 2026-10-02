import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEFAULT_SEED, generateForm, normalizeSeed, randomSeed, sampleForm } from '../form-generator.js';

const fingerprint = (recipe) => createHash('sha256')
  .update(new Uint8Array(recipe.curveData.buffer))
  .update(JSON.stringify([recipe.tubeUniform.toArray(), recipe.detailUniform.toArray(), recipe.scaleUniform.toArray()]))
  .digest('hex');

test('A shared 128-bit seed reproduces the geometry, name and sound', () => {
  for (const seed of [DEFAULT_SEED, '0'.repeat(32), 'f'.repeat(32), '1'.repeat(32)]) {
    const a = generateForm(seed), b = generateForm(seed);
    assert.equal(fingerprint(a), fingerprint(b));
    assert.equal(a.name, b.name);
    assert.deepEqual(a.chord, b.chord);
  }
  const variants = [
    '00000000000000000000000000000001',
    '00000000000000000000000100000000',
    '00000000000000010000000000000000',
    '00000001000000000000000000000000',
  ].map((seed) => fingerprint(generateForm(seed)));
  assert.equal(new Set(variants).size, variants.length, 'Every seed word must affect the shape');
});

test('1,024 seeds produce distinct, finite, closed and bounded surfaces', () => {
  const fingerprints = new Set(), kinds = new Set();
  for (let i = 0; i < 1024; i++) {
    const seed = createHash('sha256').update(`esik-form-${i}`).digest('hex').slice(0, 32);
    const recipe = generateForm(seed);
    fingerprints.add(fingerprint(recipe));
    kinds.add(recipe.kind);
    assert.ok(recipe.curveData.every(Number.isFinite), `Finite curve frames: ${seed}`);
    for (const bloom of [0, 1]) {
      for (let u = 0; u < 32; u++) {
        for (let v = 0; v < 8; v++) {
          const point = sampleForm(recipe, u / 32, v / 8, bloom);
          assert.ok(point.toArray().every(Number.isFinite), `Finite surface: ${seed}`);
          assert.ok(point.length() < (bloom ? 3.8 : 2.08), `Fits the scene: ${seed}`);
        }
      }
      for (let v = 0; v < 8; v++) {
        assert.ok(sampleForm(recipe, 0, v / 8, bloom).distanceTo(sampleForm(recipe, 1, v / 8, bloom)) < 1e-6, `Closed curve: ${seed}`);
      }
      for (let u = 0; u < 8; u++) {
        assert.ok(sampleForm(recipe, u / 8, 0, bloom).distanceTo(sampleForm(recipe, u / 8, 1, bloom)) < 1e-6, `Closed cross section: ${seed}`);
      }
    }
  }
  assert.equal(fingerprints.size, 1024, 'Every sampled seed needs different geometry');
  assert.equal(kinds.size, 4, 'The sample must exercise every curve construction');
});

test('Seed validation and random generation keep all 128 bits', () => {
  assert.equal(normalizeSeed('F'.repeat(32)), 'f'.repeat(32));
  for (const input of [null, undefined, '', '4109', 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) {
    assert.equal(normalizeSeed(input), null);
  }
  assert.throws(() => generateForm('not-a-seed'), TypeError);
  const seeds = new Set(Array.from({ length: 100 }, () => randomSeed()));
  assert.equal(seeds.size, 100);
  for (const seed of seeds) assert.match(seed, /^[a-f0-9]{32}$/);
});
