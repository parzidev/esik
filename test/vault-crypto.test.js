import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { MAX_BYTES, seal, unseal, base64url, fromBase64url, safeFilename } from '../vault-crypto.js';
const encode = (text) => new TextEncoder().encode(text);
const message = { kind: 'text', name: 'özel-🌿.txt', mime: 'text/plain', bytes: encode('  EŞİK — İstanbul 🌿\nİkinci satır.\n') };

test('Unicode plaintext and private metadata round-trip in a standard five-part JWE', async () => {
  const result = await seal(message);
  const parts = result.compact.split('.');
  assert.equal(parts.length, 5); assert.equal(parts[1], '');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromBase64url(parts[0]))), { alg: 'dir', enc: 'A256GCM', typ: 'JWE', cty: 'application/json' });
  assert.equal(fromBase64url(parts[2]).length, 12); assert.equal(fromBase64url(parts[4]).length, 16);
  assert.equal(fromBase64url(result.secret.slice(6)).length, 32);
  assert.ok(!result.compact.includes(result.secret)); assert.ok(!result.compact.includes(message.name));
  const opened = await unseal(result.compact, result.secret);
  assert.deepEqual(opened, message);
  assert.deepEqual(await unseal(result.compact + '\n', result.secret + '\n'), message);
});

test('fresh key and IV on every operation, even for identical supplemental samples', async () => {
  const secrets = new Set(), nonces = new Set();
  for (let i = 0; i < 64; i++) {
    const result = await seal({ ...message, sculpture: new Uint8Array(32) }, new Uint8Array(32));
    secrets.add(result.secret); nonces.add(result.compact.split('.')[2]);
    assert.deepEqual((await unseal(result.compact, result.secret)).bytes, message.bytes);
  }
  assert.equal(secrets.size, 64); assert.equal(nonces.size, 64);
});

test('wrong keys and modified ciphertext, IV, tag or protected header are rejected', async () => {
  const result = await seal(message), other = await seal(message);
  await assert.rejects(unseal(result.compact, other.secret), /Açılamadı/);
  for (const index of [2, 3, 4]) {
    const parts = result.compact.split('.');
    const data = fromBase64url(parts[index]); data[0] ^= 1; parts[index] = base64url(data);
    await assert.rejects(unseal(parts.join('.'), result.secret), /Açılamadı/);
  }
  const parts = result.compact.split('.');
  parts[0] = base64url(encode(JSON.stringify(JSON.parse(new TextDecoder().decode(fromBase64url(parts[0]))), null, 1)));
  await assert.rejects(unseal(parts.join('.'), result.secret), /Açılamadı/);
});

test('binary files, empty files, size limits and fail-closed provider validation', async () => {
  for (const bytes of [new Uint8Array(), Uint8Array.from({ length: 65537 }, (_, i) => i % 256)]) {
    const input = { kind: 'file', name: 'foto.bin', mime: 'application/octet-stream', bytes };
    const result = await seal(input);
    assert.deepEqual(await unseal(result.compact, result.secret), input);
  }
  await assert.rejects(seal({ ...message, bytes: new Uint8Array(MAX_BYTES + 1) }), /10 MB/);
  await assert.rejects(seal(message, null, {}), /güvenli şifreleme/);
  await assert.rejects(unseal('x.x.x.x.x', '123'), /EŞİK/);
  const result = await seal(message);
  await assert.rejects(unseal(result.compact, '4109'), /Anahtar/);
  await assert.rejects(unseal(result.compact, 'ESIK1-' + 'x'.repeat(43)), /veri biçimi|Açılamadı/);
  assert.doesNotMatch(safeFilename('../../hello<script>.html'), /[\/\\<>]|^\.+/);
});

test('a file at the 10 MB boundary encrypts and recovers without truncation', async () => {
  const bytes = new Uint8Array(MAX_BYTES); bytes[0] = 19; bytes[MAX_BYTES - 1] = 241;
  const result = await seal({ kind: 'file', name: 'limit.bin', mime: 'application/octet-stream', bytes, sculpture: new Uint8Array(32) });
  const opened = await unseal(result.compact, result.secret);
  assert.equal(opened.bytes.length, MAX_BYTES);
  assert.equal(opened.bytes[0], 19); assert.equal(opened.bytes[MAX_BYTES - 1], 241);
});

const hasIndependentCrypto = spawnSync('python3', ['-c', 'from cryptography.hazmat.primitives.ciphers.aead import AESGCM']).status === 0;
test('independent Python AES-GCM implementation decrypts EŞİK output and vice versa', { skip: !hasIndependentCrypto && 'Python cryptography is not installed' }, async () => {
  const encrypted = await seal({ ...message, sculpture: new Uint8Array(32) });
  const python = spawnSync('python3', ['-c', `
import sys,json,base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
def decode(s): return base64.urlsafe_b64decode(s+'='*((4-len(s)%4)%4))
def encode(b): return base64.urlsafe_b64encode(b).decode().rstrip('=')
given=json.load(sys.stdin)
p=given['compact'].split('.')
plain=AESGCM(decode(given['secret'][6:])).decrypt(decode(p[2]),decode(p[3])+decode(p[4]),p[0].encode())
data=json.loads(plain)
assert decode(data['data']).decode() == '  EŞİK — İstanbul 🌿\\nİkinci satır.\\n'
assert data['sculpture'] == '00'*32
key=bytes(range(32)); iv=bytes(range(12))
header=encode(b'{"alg":"dir","enc":"A256GCM","typ":"JWE","cty":"application/json"}')
payload=json.dumps({'v':1,'kind':'text','name':'python.txt','mime':'text/plain','data':encode('Bağımsız doğrulama ✓'.encode())}).encode()
out=AESGCM(key).encrypt(iv,payload,header.encode())
print(json.dumps({'compact':'.'.join([header,'',encode(iv),encode(out[:-16]),encode(out[-16:])]),'secret':'ESIK1-'+encode(key)}))
`], { input: JSON.stringify(encrypted), encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  const fixture = JSON.parse(python.stdout);
  const opened = await unseal(fixture.compact, fixture.secret);
  assert.equal(new TextDecoder().decode(opened.bytes), 'Bağımsız doğrulama ✓');
});

test('changing only the sculpture changes the derived key; the saved key recovers the frame receipt', async () => {
  // Fixed base randomness exists only in this test to isolate the frame's effect.
  const base = Uint8Array.from({ length: 32 }, (_, i) => i);
  let generated = 0;
  const fixed = {
    getRandomValues: crypto.getRandomValues.bind(crypto),
    subtle: new Proxy(crypto.subtle, { get(target, name) {
      if (name === 'generateKey') return async () => { generated++; return crypto.subtle.importKey('raw', base, 'AES-GCM', true, ['encrypt', 'decrypt']); };
      return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
    } }),
  };
  const sculpture = new Uint8Array(32).fill(17);
  const first = await seal({ ...message, sculpture }, null, fixed);
  const same = await seal({ ...message, sculpture }, null, fixed);
  const other = await seal({ ...message, sculpture: new Uint8Array(32).fill(18) }, null, fixed);
  assert.equal(first.secret, same.secret);
  assert.notEqual(first.secret, other.secret);
  assert.equal(generated, 3);
  assert.equal(first.sculpture, '11'.repeat(32));
  assert.deepEqual(await unseal(first.compact, first.secret), { ...message, sculpture: first.sculpture });
  if (hasIndependentCrypto) {
    const python = spawnSync('python3', ['-c', `
import base64
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
key=HKDF(algorithm=hashes.SHA256(),length=32,salt=bytes(32),info=b'ESIK/local-vault/sculpture/v1\\x00'+bytes([17])*32).derive(bytes(range(32)))
print('ESIK1-'+base64.urlsafe_b64encode(key).decode().rstrip('='))
`], { encoding: 'utf8' });
    assert.equal(python.status, 0, python.stderr);
    assert.equal(first.secret, python.stdout.trim());
  }
});

test('sculpture context is validated and cannot replace the secure key generator', async () => {
  for (const sculpture of [new Uint8Array(31), new Uint8Array(33), '11'.repeat(32)]) await assert.rejects(seal({ ...message, sculpture }), /heykel/);
  await assert.rejects(seal({ ...message, sculpture: new Uint8Array(32) }, null, {}), /güvenli şifreleme/);
  await assert.rejects(seal({ ...message, sculpture: new Uint8Array(32) }, new Uint8Array(31)), /kaynak/);
});
