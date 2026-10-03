import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApiServer, MAX_BODY_BYTES } from '../backend/server.js';
import { seal, unseal, base64url } from '../vault-crypto.js';

const token = 'unit-test-token-0123456789abcdefgh';
async function withApi(options, run) {
  const server = createApiServer({ token, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  try { await run(post, base); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
test('API requires a configured token and authentication; health and spec are public', async () => {
  assert.throws(() => createApiServer(), /KOZA_API_TOKEN/);
  assert.throws(() => createApiServer({ token: 'short' }), /KOZA_API_TOKEN/);
  await withApi({}, async (post, base) => {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    const spec = await (await fetch(base + '/api/v1/openapi.json')).json();
    assert.equal(spec.openapi, '3.1.0'); assert.ok(spec.paths['/api/v1/encrypt']);
    assert.equal((await post('/api/v1/encrypt', { text: 'private' }, { Authorization: '' })).status, 401);
    assert.equal((await post('/api/v1/decrypt', {}, { Authorization: `Bearer ${'x'.repeat(token.length)}` })).status, 401);
    assert.equal((await fetch(base + '/api/v1/encrypt')).status, 405);
  });
});
test('API text encryption interoperates with the shared browser module and binds sculpture context', async () => {
  await withApi({}, async (post) => {
    const request = { text: 'Koza · İstanbul 🌿\n', name: 'özel.txt', sculpture: '17'.repeat(32) };
    const response = await post('/api/v1/encrypt', request);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const first = await response.json();
    assert.match(first.key, /^KOZA1-[A-Za-z0-9_-]{43}$/); assert.equal(first.sculpture, request.sculpture);
    const opened = await unseal(first.jwe, first.key);
    assert.equal(new TextDecoder().decode(opened.bytes), request.text); assert.equal(opened.name, request.name);
    const second = await (await post('/api/v1/encrypt', request)).json();
    assert.notEqual(first.key, second.key); assert.notEqual(first.jwe, second.jwe);
    const back = await (await post('/api/v1/decrypt', { jwe: first.jwe, key: first.key })).json();
    assert.equal(back.text, request.text); assert.equal(back.sculpture, request.sculpture);
  });
});
test('API decrypts browser packages and legacy ESIK1 keys without recreating the sculpture', async () => {
  await withApi({}, async (post) => {
    const bytes = new TextEncoder().encode('Browser package');
    const encrypted = await seal({ kind: 'text', name: 'browser.txt', mime: 'text/plain', bytes, sculpture: new Uint8Array(32).fill(31) });
    const response = await post('/api/v1/decrypt', { jwe: encrypted.compact, key: encrypted.secret.replace('KOZA1-', 'ESIK1-') });
    assert.equal(response.status, 200); const opened = await response.json();
    assert.equal(opened.text, 'Browser package'); assert.equal(opened.sculpture, '1f'.repeat(32));
  });
});
test('API binary files preserve bytes and reject changed packages or keys', async () => {
  await withApi({}, async (post) => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const encrypted = await (await post('/api/v1/encrypt', { data: base64url(bytes), name: 'sample.bin' })).json();
    const opened = await (await post('/api/v1/decrypt', { jwe: encrypted.jwe, key: encrypted.key })).json();
    assert.equal(opened.kind, 'file'); assert.equal(opened.data, base64url(bytes)); assert.equal(opened.name, 'sample.bin');
    assert.equal((await post('/api/v1/decrypt', { jwe: encrypted.jwe, key: 'KOZA1-' + base64url(new Uint8Array(32)) })).status, 422);
    const parts = encrypted.jwe.split('.'); parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    assert.equal((await post('/api/v1/decrypt', { jwe: parts.join('.'), key: encrypted.key })).status, 422);
  });
});
test('API validates schema, canonical encoding, sculpture and content type', async () => {
  await withApi({}, async (post, base) => {
    for (const body of [{}, { text: 'x', data: 'eA' }, { data: 'eA==' }, { text: 'x', sculpture: 'bad' }, { text: 'x', customKey: 'unsafe' }, { text: 'x', name: 42 }]) assert.equal((await post('/api/v1/encrypt', body)).status, 400);
    assert.equal((await post('/api/v1/encrypt', { text: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
    const malformed = await fetch(base + '/api/v1/encrypt', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
  });
});
test('API enforces decoded 10 MiB and raw request limits', async () => {
  await withApi({}, async (post) => {
    assert.equal((await post('/api/v1/encrypt', { text: 'x'.repeat(10 * 1024 * 1024 + 1) })).status, 413);
    assert.equal((await post('/api/v1/encrypt', { text: 'x'.repeat(MAX_BODY_BYTES) })).status, 413);
  });
});
test('API rate limits authenticated operations and keeps public health available', async () => {
  await withApi({ rateLimit: 1 }, async (post, base) => {
    assert.equal((await post('/api/v1/encrypt', { text: 'first' })).status, 200);
    const limited = await post('/api/v1/encrypt', { text: 'second' });
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await fetch(base + '/healthz')).status, 200);
  });
});
test('chunked requests exceeding the raw limit receive 413 without resetting the connection', async () => {
  await withApi({}, async (_post, base) => {
    const status = await new Promise((resolve, reject) => {
      const req = request(base + '/api/v1/encrypt', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.write('{"text":"');
      const chunk = 'x'.repeat(1024 * 1024);
      for (let i = 0; i <= Math.ceil(MAX_BODY_BYTES / chunk.length); i++) req.write(chunk);
      req.end('"}');
    });
    assert.equal(status, 413);
  });
});
