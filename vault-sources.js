// Supplemental samples are never assigned an entropy estimate. The mandatory
// cryptographic key generator remains secure without any of these samples.
export const SCULPTURE_SAMPLE_SIZE = 64;
const sculptureDomain = new TextEncoder().encode('KOZA/sculpture-frame/v1\n');

export async function hashSculptureFrame(pixels, state, cryptoProvider = globalThis.crypto) {
  if (!(pixels instanceof Uint8Array) || pixels.length !== SCULPTURE_SAMPLE_SIZE ** 2 * 4 || !cryptoProvider?.subtle) throw new Error('Heykel karesi okunamadı.');
  const metadata = new TextEncoder().encode(JSON.stringify(state));
  if (!metadata.length || metadata.length > 8192) throw new Error('Heykel durumu geçersiz.');
  const input = new Uint8Array(sculptureDomain.length + 4 + metadata.length + pixels.length);
  input.set(sculptureDomain);
  new DataView(input.buffer).setUint32(sculptureDomain.length, metadata.length);
  input.set(metadata, sculptureDomain.length + 4);
  input.set(pixels, sculptureDomain.length + 4 + metadata.length);
  try { return new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', input)); }
  finally { input.fill(0); metadata.fill(0); }
}

export class SourceMixer {
  constructor(cryptoProvider = globalThis.crypto, onSample = () => {}) {
    this.crypto = cryptoProvider;
    this.onSample = onSample;
    this.digest = new Uint8Array(32);
    this.count = 0;
    this.epoch = 0;
    this.pending = Promise.resolve();
    this.busy = false;
  }
  add(bytes) {
    if (this.busy || !this.crypto?.subtle) return Promise.resolve(false);
    this.busy = true;
    const epoch = this.epoch;
    const input = new Uint8Array(this.digest.length + bytes.length);
    input.set(this.digest); input.set(bytes, this.digest.length);
    this.pending = this.crypto.subtle.digest('SHA-256', input).then((hash) => {
      if (this.epoch !== epoch) return false;
      this.digest.fill(0); this.digest = new Uint8Array(hash); this.count++;
      this.onSample(this.count);
      return true;
    }).catch(() => false).finally(() => { input.fill(0); if (this.epoch === epoch) this.busy = false; });
    return this.pending;
  }
  async snapshot() {
    await this.pending;
    return this.count ? this.digest.slice() : null;
  }
  reset() {
    this.epoch++; this.digest.fill(0); this.digest = new Uint8Array(32);
    this.count = 0; this.busy = false; this.pending = Promise.resolve(); this.onSample(0);
  }
}

export class CameraSampler {
  constructor({ mediaDevices, video, canvas, mixer, onChange = () => {} }) {
    Object.assign(this, { mediaDevices, video, canvas, mixer, onChange });
    this.stream = null;
    this.timer = null;
    this.epoch = 0;
  }
  async start() {
    if (!this.mediaDevices?.getUserMedia) throw new Error('Bu tarayıcıda kamera kullanılamıyor. Güvenli temel kaynakla devam edebilirsin.');
    this.stop();
    const epoch = this.epoch;
    const stream = await this.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 160 }, height: { ideal: 120 }, frameRate: { ideal: 8, max: 10 } } });
    if (this.epoch !== epoch) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream; this.video.srcObject = stream;
    try { await this.video.play(); }
    catch (error) { this.stop(); throw error; }
    if (this.epoch !== epoch) return;
    this.video.hidden = false; this.onChange(true);
    stream.getTracks().forEach((track) => track.addEventListener('ended', () => { if (this.stream === stream) this.stop(); }, { once: true }));
    this.timer = setInterval(() => this.sample(), 250);
  }
  sample() {
    if (!this.stream || this.video.readyState < 2 || this.mixer.busy) return;
    try {
      const context = this.canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(this.video, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      void this.mixer.add(pixels);
      pixels.fill(0);
      context.clearRect(0, 0, 32, 32);
    } catch { this.stop(); }
  }
  stop() {
    this.epoch++; clearInterval(this.timer); this.timer = null;
    this.stream?.getTracks().forEach((track) => track.stop()); this.stream = null;
    this.video.pause(); this.video.srcObject = null; this.video.hidden = true;
    this.canvas.getContext('2d')?.clearRect(0, 0, 32, 32);
    this.onChange(false);
  }
}
