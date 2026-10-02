// Standard JWE compact serialization (RFC 7516), direct key, A256GCM.
// A rendered sculpture digest can bind key derivation to the sampled frame.
// It is public context, never a substitute for fresh cryptographic randomness.
export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_PACKAGE_CHARS = Math.ceil((MAX_BYTES * 4 / 3 + 8192) * 4 / 3) + 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HEADER = { alg: 'dir', enc: 'A256GCM', typ: 'JWE', cty: 'application/json' };
const KEY_PREFIX = 'ESIK1-';

export class VaultError extends Error {
  constructor(message) { super(message); this.name = 'VaultError'; }
}

function provider(value) {
  if (!value?.subtle || !value?.getRandomValues) throw new VaultError('Bu tarayıcıda güvenli şifreleme kullanılamıyor. HTTPS üzerinden güncel bir tarayıcıyla aç.');
  return value;
}

export function base64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new VaultError('Geçersiz veri biçimi.');
  let binary;
  try { binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)); }
  catch { throw new VaultError('Geçersiz veri biçimi.'); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64url(bytes) !== value) throw new VaultError('Geçersiz veri biçimi.');
  return bytes;
}

export function safeFilename(value) {
  return String(value || 'esik-dosya').normalize('NFC').replace(/[\x00-\x1f\x7f/\\<>:"|?*]/g, '_').replace(/^\.+/, '_').slice(0, 160) || 'esik-dosya';
}

function validMime(value) {
  return typeof value === 'string' && value.length <= 120 && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value) ? value : 'application/octet-stream';
}

function keyBytes(secret) {
  if (typeof secret !== 'string' || secret.length > 100) throw new VaultError('Anahtar, EŞİK’in verdiği 256 bitlik anahtar olmalı.');
  const value = secret.trim().replace(/^ESIK1-/, '');
  if (value.length !== 43) throw new VaultError('Anahtar eksik veya geçersiz.');
  const bytes = fromBase64url(value);
  if (bytes.length !== 32) throw new VaultError('Anahtar eksik veya geçersiz.');
  return bytes;
}

async function newSecret(supplemental, sculpture, cryptoProvider) {
  const crypto = provider(cryptoProvider);
  if (supplemental !== null && (!(supplemental instanceof Uint8Array) || supplemental.length !== 32)) throw new VaultError('Geçersiz kaynak örneği.');
  if (sculpture !== null && (!(sculpture instanceof Uint8Array) || sculpture.length !== 32)) throw new VaultError('Geçersiz heykel izi.');
  // generateKey always supplies fresh OS-backed cryptographic randomness.
  // Sculpture/camera/pointer samples are context, with zero credited entropy.
  let key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  if (supplemental || sculpture) {
    const initial = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    try {
      const input = await crypto.subtle.importKey('raw', initial, 'HKDF', false, ['deriveKey']);
      const domain = encoder.encode(sculpture ? 'ESIK/local-vault/sculpture/v1\0' : 'ESIK/local-vault/v1');
      const info = new Uint8Array(domain.length + (sculpture?.length || 0));
      info.set(domain); if (sculpture) info.set(sculpture, domain.length);
      key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: supplemental || new Uint8Array(32), info }, input, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    } finally { initial.fill(0); }
  }
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  try {
    return { secret: KEY_PREFIX + base64url(raw), key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']) };
  } finally { raw.fill(0); }
}

export async function seal({ kind, name, mime, bytes, sculpture = null }, supplemental = null, cryptoProvider = globalThis.crypto) {
  const crypto = provider(cryptoProvider);
  if (!['text', 'file'].includes(kind) || !(bytes instanceof Uint8Array)) throw new VaultError('Geçersiz içerik.');
  if (bytes.length > MAX_BYTES) throw new VaultError('En fazla 10 MB kilitleyebilirsin.');
  if (sculpture !== null && (!(sculpture instanceof Uint8Array) || sculpture.length !== 32)) throw new VaultError('Geçersiz heykel izi.');
  sculpture = sculpture?.slice() || null;
  const fingerprint = sculpture ? Array.from(sculpture, (byte) => byte.toString(16).padStart(2, '0')).join('') : null;
  const plaintext = encoder.encode(JSON.stringify({ v: 1, kind, name: safeFilename(name), mime: validMime(mime), data: base64url(bytes), ...(fingerprint ? { sculpture: fingerprint } : {}) }));
  try {
    const { key, secret } = await newSecret(supplemental, sculpture, crypto);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const protectedHeader = base64url(encoder.encode(JSON.stringify(HEADER)));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(protectedHeader), tagLength: 128 }, key, plaintext));
    const ciphertext = encrypted.subarray(0, -16);
    const tag = encrypted.subarray(-16);
    return { secret, compact: [protectedHeader, '', base64url(iv), base64url(ciphertext), base64url(tag)].join('.'), ...(fingerprint ? { sculpture: fingerprint } : {}) };
  } finally { plaintext.fill(0); sculpture?.fill(0); }
}

export async function unseal(compact, secret, cryptoProvider = globalThis.crypto) {
  const crypto = provider(cryptoProvider);
  if (typeof compact !== 'string' || compact.length > MAX_PACKAGE_CHARS) throw new VaultError('Kilitli veri çok büyük veya geçersiz.');
  const parts = compact.trim().split('.');
  if (parts.length !== 5 || parts[1] !== '' || parts[0].length > 1024) throw new VaultError('Bir EŞİK kilitli dosyası veya şifreli metni seç.');
  let header;
  try { header = JSON.parse(decoder.decode(fromBase64url(parts[0]))); }
  catch { throw new VaultError('Kilitli dosyanın başlığı geçersiz.'); }
  if (!header || Object.keys(header).length !== 4 || Object.entries(HEADER).some(([name, value]) => header[name] !== value)) throw new VaultError('Bu şifreleme biçimi desteklenmiyor.');
  const iv = fromBase64url(parts[2]);
  const ciphertext = fromBase64url(parts[3]);
  const tag = fromBase64url(parts[4]);
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new VaultError('Kilitli dosya eksik veya bozulmuş.');
  const raw = keyBytes(secret);
  let key;
  try { key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']); }
  finally { raw.fill(0); }
  const encrypted = new Uint8Array(ciphertext.length + tag.length);
  encrypted.set(ciphertext); encrypted.set(tag, ciphertext.length);
  let plaintext;
  try { plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(parts[0]), tagLength: 128 }, key, encrypted)); }
  catch { throw new VaultError('Açılamadı. Anahtar yanlış veya kilitli veri değiştirilmiş.'); }
  try {
    const payload = JSON.parse(decoder.decode(plaintext));
    if (payload?.v !== 1 || !['text', 'file'].includes(payload.kind) || typeof payload.name !== 'string' || typeof payload.data !== 'string' || payload.data.length > Math.ceil(MAX_BYTES * 4 / 3)) throw new Error();
    if (payload.sculpture !== undefined && (typeof payload.sculpture !== 'string' || !/^[a-f0-9]{64}$/.test(payload.sculpture))) throw new Error();
    const bytes = fromBase64url(payload.data);
    if (bytes.length > MAX_BYTES) throw new Error();
    return { kind: payload.kind, name: safeFilename(payload.name), mime: validMime(payload.mime), bytes, ...(payload.sculpture ? { sculpture: payload.sculpture } : {}) };
  } catch { throw new VaultError('Dosya açıldı, ancak içerik biçimi geçersiz.'); }
  finally { plaintext.fill(0); }
}
