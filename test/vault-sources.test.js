import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceMixer, CameraSampler, SCULPTURE_SAMPLE_SIZE, hashSculptureFrame } from '../vault-sources.js';

test('the sculpture digest binds both rendered pixels and the actual frame state', async () => {
  const pixels = new Uint8Array(SCULPTURE_SAMPLE_SIZE ** 2 * 4).fill(81);
  const state = { seed: 'b8740a35d39fe6421e759c084af6032b', time: 1, bloom: 0, rotation: [0, 0, 0] };
  const first = await hashSculptureFrame(pixels, state);
  assert.equal(first.length, 32);
  assert.deepEqual(await hashSculptureFrame(pixels, state), first);
  pixels[1234] ^= 1;
  assert.notDeepEqual(await hashSculptureFrame(pixels, state), first);
  pixels[1234] ^= 1;
  assert.notDeepEqual(await hashSculptureFrame(pixels, { ...state, time: 2 }), first);
  assert.notDeepEqual(await hashSculptureFrame(pixels, { ...state, bloom: 0.5 }), first);
  assert.notDeepEqual(await hashSculptureFrame(pixels, { ...state, rotation: [0, 1, 0] }), first);
  assert.equal(pixels[0], 81);
});

test('missing or malformed sculpture frames cannot produce a digest', async () => {
  const pixels = new Uint8Array(SCULPTURE_SAMPLE_SIZE ** 2 * 4);
  await assert.rejects(hashSculptureFrame(new Uint8Array(4), {}), /Heykel/);
  await assert.rejects(hashSculptureFrame(null, {}), /Heykel/);
  await assert.rejects(hashSculptureFrame(pixels, {}, {}), /Heykel/);
  await assert.rejects(hashSculptureFrame(pixels, { oversized: 'x'.repeat(8192) }), /Heykel/);
});

test('supplemental source pool hashes samples, counts actual samples, and clears state', async () => {
  const seen = [], mixer = new SourceMixer(globalThis.crypto, (count) => seen.push(count));
  assert.equal(await mixer.snapshot(), null);
  await mixer.add(new Uint8Array([1, 2, 3])); const first = await mixer.snapshot();
  await mixer.add(new Uint8Array([1, 2, 3])); const second = await mixer.snapshot();
  assert.equal(mixer.count, 2); assert.equal(first.length, 32); assert.notDeepEqual(first, second);
  const snapshot = await mixer.snapshot(); snapshot.fill(0); assert.notDeepEqual(await mixer.snapshot(), snapshot);
  mixer.reset(); assert.equal(await mixer.snapshot(), null); assert.deepEqual(seen, [1, 2, 0]);
});

test('clearing a pending sample prevents old data from returning to the pool', async () => {
  let resolve;
  const mixer = new SourceMixer({ subtle: { digest: () => new Promise((done) => { resolve = done; }) } });
  const pending = mixer.add(new Uint8Array([3])); mixer.reset(); resolve(new Uint8Array(32).fill(1).buffer);
  await pending; assert.equal(mixer.count, 0); assert.equal(await mixer.snapshot(), null);
});

function cameraFixture(mediaDevices) {
  const pixels = new Uint8ClampedArray(4096).fill(100);
  const context = { drawImage() {}, clearRect() {}, getImageData() { return { data: pixels }; } };
  const video = { hidden: true, readyState: 4, srcObject: null, async play() {}, pause() {} };
  const canvas = { getContext() { return context; } };
  const mixer = new SourceMixer();
  const sampler = new CameraSampler({ mediaDevices, video, canvas, mixer });
  return { sampler, video, mixer, pixels };
}

test('camera is off by default, samples locally, requests no audio, and releases tracks', async () => {
  let request, stops = 0;
  const track = { stop() { stops++; }, addEventListener() {} };
  const stream = { getTracks: () => [track] };
  const { sampler, video, mixer, pixels } = cameraFixture({ async getUserMedia(value) { request = value; return stream; } });
  assert.equal(request, undefined); assert.equal(sampler.stream, null);
  await sampler.start(); assert.equal(request.audio, false); assert.equal(video.hidden, false);
  sampler.sample(); await mixer.snapshot(); assert.equal(mixer.count, 1); assert.equal(pixels.every((byte) => byte === 0), true);
  sampler.stop(); assert.equal(stops, 1); assert.equal(video.srcObject, null); assert.equal(video.hidden, true); assert.equal(sampler.timer, null);
});

test('a cancelled camera permission request cannot activate the camera afterwards', async () => {
  let resolve, stops = 0;
  const track = { stop() { stops++; }, addEventListener() {} };
  const stream = { getTracks: () => [track] };
  const { sampler, video } = cameraFixture({ getUserMedia: () => new Promise((done) => { resolve = done; }) });
  const pending = sampler.start(); sampler.stop(); resolve(stream); await pending;
  assert.equal(stops, 1); assert.equal(sampler.stream, null); assert.equal(video.hidden, true);
});

test('denied or unavailable camera access leaves no stream or timer', async () => {
  const denied = Object.assign(new Error('permission denied'), { name: 'NotAllowedError' });
  for (const devices of [null, { async getUserMedia() { throw denied; } }]) {
    const { sampler, video } = cameraFixture(devices);
    await assert.rejects(sampler.start());
    assert.equal(sampler.stream, null); assert.equal(sampler.timer, null); assert.equal(video.hidden, true);
  }
});
