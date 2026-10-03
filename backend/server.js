import { createServer } from 'node:http';
import { webcrypto, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { seal, unseal, base64url, fromBase64url, MAX_BYTES, MAX_PACKAGE_CHARS, VaultError } from '../vault-crypto.js';

export const MAX_BODY_BYTES = MAX_PACKAGE_CHARS + 16384;
const openapi = JSON.parse(readFileSync(new URL('./openapi.json', import.meta.url), 'utf8'));
class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function reply(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
    throw new HttpError(415, 'unsupported_media_type', 'Use an uncompressed application/json body.');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Input exceeds the 10 MiB content limit.');
  const chunks = []; let size = 0;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Input exceeds the 10 MiB content limit.');
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    try {
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      return data;
    } catch { throw new HttpError(400, 'invalid_json', 'A JSON object is required.'); }
    finally { buffer.fill(0); }
  } finally { for (const chunk of chunks) chunk.fill(0); }
}
function checkFields(data, allowed) {
  if (Object.keys(data).some((key) => !allowed.includes(key))) throw new HttpError(400, 'unknown_field', 'Request contains an unsupported field.');
}
function digest(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new HttpError(400, 'invalid_sculpture', 'sculpture must be a 64-character SHA-256 hexadecimal digest.');
  return Uint8Array.from(value.match(/../g), (pair) => parseInt(pair, 16));
}
async function encrypt(data) {
  checkFields(data, ['text', 'data', 'name', 'mime', 'sculpture']);
  const text = typeof data.text === 'string';
  if (text === (typeof data.data === 'string') || (!text && data.text !== undefined) || (text && data.data !== undefined)) throw new HttpError(400, 'invalid_input', 'Provide either text or base64url data, exclusively.');
  for (const key of ['name', 'mime']) if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > 255)) throw new HttpError(400, 'invalid_metadata', `${key} must be a string of at most 255 characters.`);
  let bytes, sculpture;
  try {
    sculpture = digest(data.sculpture);
    try { bytes = text ? new TextEncoder().encode(data.text) : fromBase64url(data.data); }
    catch { throw new HttpError(400, 'invalid_data', 'data must use canonical, unpadded base64url.'); }
    if (bytes.length > MAX_BYTES) throw new HttpError(413, 'payload_too_large', 'Input exceeds the 10 MiB content limit.');
    const result = await seal({ kind: text ? 'text' : 'file', name: data.name ?? (text ? 'koza-metin.txt' : 'file.bin'), mime: data.mime ?? (text ? 'text/plain' : 'application/octet-stream'), bytes, sculpture }, null, webcrypto);
    return { jwe: result.compact, key: result.secret, algorithm: 'A256GCM', ...(result.sculpture ? { sculpture: result.sculpture } : {}) };
  } finally { bytes?.fill(0); sculpture?.fill(0); }
}
async function decrypt(data) {
  checkFields(data, ['jwe', 'key']);
  if (typeof data.jwe !== 'string' || typeof data.key !== 'string') throw new HttpError(400, 'invalid_input', 'jwe and key strings are required.');
  const result = await unseal(data.jwe, data.key, webcrypto);
  try {
    const payload = result.kind === 'text' ? { text: new TextDecoder('utf-8', { fatal: true }).decode(result.bytes) } : { data: base64url(result.bytes) };
    return { kind: result.kind, name: result.name, mime: result.mime, ...payload, ...(result.sculpture ? { sculpture: result.sculpture } : {}) };
  } finally { result.bytes.fill(0); }
}

// Stateless HTTP adapter; browser and server use the same crypto module.
export function createApiServer({ token, rateLimit = 60, windowMs = 60000, maxConcurrent = 2 } = {}) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('KOZA_API_TOKEN must contain 32–256 printable non-space ASCII characters.');
  const expected = Buffer.from(`Bearer ${token}`);
  let windowStart = Date.now(), requests = 0, active = 0;
  const server = createServer(async (req, res) => {
    let processing = false;
    try {
      const path = req.url?.split('?')[0];
      if (req.method === 'GET' && path === '/healthz') { reply(res, 200, { status: 'ok' }); return; }
      if (req.method === 'GET' && path === '/api/v1/openapi.json') { reply(res, 200, openapi); return; }
      if (!['/api/v1/encrypt', '/api/v1/decrypt'].includes(path)) throw new HttpError(404, 'not_found', 'Endpoint not found.');
      if (req.method !== 'POST') { reply(res, 405, { error: { code: 'method_not_allowed', message: 'Use POST.' } }, { Allow: 'POST' }); req.resume(); return; }
      const received = Buffer.from(req.headers.authorization || '');
      const authorized = received.length === expected.length && timingSafeEqual(received, expected);
      received.fill(0);
      if (!authorized) { reply(res, 401, { error: { code: 'unauthorized', message: 'A valid API bearer token is required.' } }, { 'WWW-Authenticate': 'Bearer' }); req.resume(); return; }
      const now = Date.now();
      if (now - windowStart >= windowMs) { windowStart = now; requests = 0; }
      if (++requests > rateLimit) { reply(res, 429, { error: { code: 'rate_limited', message: 'Request limit reached.' } }, { 'Retry-After': String(Math.max(1, Math.ceil((windowMs - now + windowStart) / 1000))) }); req.resume(); return; }
      if (active >= maxConcurrent) throw new HttpError(503, 'busy', 'Try again after the current operations complete.');
      active++; processing = true;
      const body = await readJson(req);
      const output = await (path.endsWith('/encrypt') ? encrypt(body) : decrypt(body));
      reply(res, 200, output);
    } catch (error) {
      if (res.destroyed) return;
      const status = error instanceof HttpError ? error.status : error instanceof VaultError || error instanceof TypeError ? 422 : 500;
      reply(res, status, { error: { code: error instanceof HttpError ? error.code : status === 422 ? 'invalid_package' : 'internal_error', message: error instanceof HttpError ? error.message : status === 422 ? 'Invalid input, key or authenticated package.' : 'Operation failed.' } });
      req.resume();
    } finally { if (processing) active--; }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;
  server.on('close', () => expected.fill(0));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.KOZA_API_TOKEN_FILE ? readFileSync(process.env.KOZA_API_TOKEN_FILE, 'utf8').trim() : process.env.KOZA_API_TOKEN;
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const server = createApiServer({ token });
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.info(`Koza API listening on port ${port}`));
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
