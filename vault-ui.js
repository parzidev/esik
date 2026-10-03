import { MAX_BYTES, MAX_PACKAGE_CHARS, seal, unseal, safeFilename, VaultError } from './vault-crypto.js';
import { SourceMixer, CameraSampler } from './vault-sources.js';

export function initVault({ notify, captureSculpture, onPhase = () => {}, initialWorkspace = 'vault' }) {
  const $ = (selector) => document.querySelector(selector);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let mode = 'seal', inputKind = 'text', busy = false, operation = 0;
  let sealed = null, opened = null, cameraPending = false, lastPointer = 0;
  const mixer = new SourceMixer(globalThis.crypto, (count) => { $('#source-count').textContent = `${count.toLocaleString('tr-TR')} ÖRNEK`; });
  const sampleCanvas = document.createElement('canvas'); sampleCanvas.width = sampleCanvas.height = 32;
  const camera = new CameraSampler({ mediaDevices: navigator.mediaDevices, video: $('#source-video'), canvas: sampleCanvas, mixer, onChange(active) {
    $('#camera-toggle').setAttribute('aria-pressed', String(active));
    $('#camera-toggle').innerHTML = active ? 'Kamerayı kapat <span aria-hidden="true">×</span>' : 'Kamera <span aria-hidden="true">↗</span>';
  } });
  const available = !!globalThis.crypto?.subtle;
  const sculptureLabel = (value) => `Heykel izi · ${value.slice(0, 16).match(/.{4}/g).join('·').toUpperCase()}`;

  function setError(id, message = '') { const node = $(id); node.textContent = message; node.hidden = !message; }
  function updateButtons() {
    $('#seal-submit').disabled = !available || busy || (inputKind === 'text' ? !$('#secret-text').value.length : !$('#secret-file').files.length);
    $('#open-submit').disabled = !available || busy || !$('#open-key').value.trim() || (!$('#sealed-text').value.trim() && !$('#sealed-file').files.length);
    for (const id of ['#secret-text', '#secret-file', '#sealed-text', '#sealed-file', '#open-key', '#input-text', '#input-file']) $(id).disabled = busy;
    $('#seal-submit').querySelector('span').textContent = busy && mode === 'seal' ? 'Şifreleniyor…' : 'Şifrele';
    $('#open-submit').querySelector('span').textContent = busy && mode === 'open' ? 'Açılıyor…' : 'Şifreyi çöz';
    $('#vault-panel').setAttribute('aria-busy', String(busy));
  }
  function chooseTab(next, focus = false) {
    mode = next;
    $('#tab-seal').setAttribute('aria-selected', String(mode === 'seal'));
    $('#tab-open').setAttribute('aria-selected', String(mode === 'open'));
    $('#tab-seal').tabIndex = mode === 'seal' ? 0 : -1;
    $('#tab-open').tabIndex = mode === 'open' ? 0 : -1;
    $('#panel-seal').hidden = mode !== 'seal'; $('#panel-open').hidden = mode !== 'open';
    if (focus) $(`#tab-${mode}`).focus();
    updateButtons();
  }
  function chooseInput(next) {
    inputKind = next;
    $('#input-text').setAttribute('aria-pressed', String(next === 'text'));
    $('#input-file').setAttribute('aria-pressed', String(next === 'file'));
    $('#seal-text-area').hidden = next !== 'text'; $('#seal-file-area').hidden = next !== 'file';
    setError('#seal-error'); updateButtons();
  }
  function dropSealed() {
    if (sealed) { sealed.secret = ''; sealed.compact = ''; sealed = null; }
    $('#sealed-key').value = ''; $('#sealed-key').type = 'password';
    $('#reveal-key').textContent = 'Göster'; $('#reveal-key').setAttribute('aria-pressed', 'false');
    $('#sealed-sculpture').textContent = '';
    $('#seal-result').hidden = true; $('#seal-form').hidden = false;
  }
  function dropOpened() {
    opened?.bytes.fill(0); opened = null;
    $('#opened-text').value = ''; $('#opened-name').textContent = ''; $('#open-result').hidden = true; $('#open-form').hidden = false;
    $('#opened-sculpture').textContent = ''; $('#opened-sculpture').hidden = true;
  }
  function clearAll(showNotice = true) {
    operation++; busy = false; camera.stop(); mixer.reset(); dropSealed(); dropOpened();
    for (const id of ['#secret-text', '#secret-file', '#sealed-text', '#sealed-file', '#open-key']) $(id).value = '';
    $('#secret-file-name').textContent = 'Bir dosya seç';
    $('#secret-file-size').textContent = 'En fazla 10 MiB';
    $('#sealed-file-name').textContent = 'Kilitli dosyayı seç';
    $('#sculpture-source-state').textContent = 'HER İŞLEMDE ÖRNEKLENİR';
    setError('#seal-error'); setError('#open-error'); onPhase('idle'); updateButtons();
    if (showNotice) notify('Temizlendi.');
  }
  function download(data, name, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([data], { type: mime });
    const href = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = href; link.download = safeFilename(name); link.click();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); notify('Kopyalandı.'); }
    catch { notify('Kopyalanamadı. İndirme seçeneğini kullanabilirsin.'); }
  }
  function setWorkspace(next, updateAddress = true) {
    document.body.dataset.workspace = next;
    $('#workspace-vault').setAttribute('aria-pressed', String(next === 'vault'));
    $('#workspace-art').setAttribute('aria-pressed', String(next === 'art'));
    const art = next === 'art';
    if (art) camera.stop();
    if (updateAddress) {
      const url = new URL(location.href); url.searchParams.set('workspace', next);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }

  $('#workspace-vault').addEventListener('click', () => setWorkspace('vault'));
  $('#workspace-art').addEventListener('click', () => setWorkspace('art'));
  $('#tab-seal').addEventListener('click', () => chooseTab('seal'));
  $('#tab-open').addEventListener('click', () => chooseTab('open'));
  for (const id of ['#tab-seal', '#tab-open']) $(id).addEventListener('keydown', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); chooseTab(event.key === 'Home' ? 'seal' : event.key === 'End' ? 'open' : mode === 'seal' ? 'open' : 'seal', true);
    }
  });
  $('#input-text').addEventListener('click', () => chooseInput('text'));
  $('#input-file').addEventListener('click', () => chooseInput('file'));
  $('#secret-text').addEventListener('input', () => { setError('#seal-error'); updateButtons(); });
  $('#open-key').addEventListener('input', () => { setError('#open-error'); updateButtons(); });
  $('#sealed-text').addEventListener('input', () => {
    $('#sealed-file').value = ''; $('#sealed-file-name').textContent = 'Kilitli dosyayı seç';
    setError('#open-error'); updateButtons();
  });
  $('#secret-file').addEventListener('change', () => {
    const file = $('#secret-file').files[0]; setError('#seal-error');
    if (file?.size > MAX_BYTES) { $('#secret-file').value = ''; setError('#seal-error', 'Dosya 10 MB sınırını aşıyor. Daha küçük bir dosya seç.'); }
    const selected = $('#secret-file').files[0];
    $('#secret-file-name').textContent = selected?.name || 'Bir dosya seç';
    $('#secret-file-size').textContent = selected ? `${(selected.size / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} KB · şifreleme bu cihazda` : 'En fazla 10 MiB';
    updateButtons();
  });
  $('#sealed-file').addEventListener('change', () => {
    const file = $('#sealed-file').files[0]; setError('#open-error');
    if (file?.size > MAX_PACKAGE_CHARS) { $('#sealed-file').value = ''; setError('#open-error', 'Kilitli dosya boyut sınırını aşıyor.'); }
    $('#sealed-text').value = ''; $('#sealed-file-name').textContent = $('#sealed-file').files[0]?.name || 'Kilitli dosyayı seç'; updateButtons();
  });
  $('#seal-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || $('#seal-submit').disabled) return;
    const id = ++operation; busy = true; setError('#seal-error'); updateButtons();
    let bytes, supplemental, sculpture;
    try {
      try { sculpture = await captureSculpture(); }
      catch { throw new VaultError('Heykel okunamadı. Yüklenmesini bekleyip yeniden dene; gerekirse sayfayı yenile.'); }
      if (!(sculpture instanceof Uint8Array) || sculpture.length !== 32) throw new VaultError('Heykel izi alınamadı. Yeniden dene.');
      if (id !== operation) return;
      onPhase('working');
      const file = inputKind === 'file' ? $('#secret-file').files[0] : null;
      bytes = file ? new Uint8Array(await file.arrayBuffer()) : encoder.encode($('#secret-text').value);
      if (id !== operation) return;
      supplemental = await mixer.snapshot();
      if (id !== operation) return;
      const result = await seal({ kind: file ? 'file' : 'text', name: file?.name || 'koza-metin.txt', mime: file?.type || 'text/plain', bytes, sculpture }, supplemental);
      if (id !== operation) { result.secret = ''; return; }
      dropSealed(); sealed = result; $('#sealed-key').value = result.secret;
      $('#sealed-sculpture').textContent = sculptureLabel(result.sculpture);
      $('#sculpture-source-state').textContent = `SON İZ · ${result.sculpture.slice(0, 8).toUpperCase()}`;
      $('#secret-text').value = ''; $('#secret-file').value = '';
      $('#secret-file-name').textContent = 'Bir dosya seç';
      $('#secret-file-size').textContent = 'En fazla 10 MiB';
      $('#seal-form').hidden = true; $('#seal-result').hidden = false; onPhase('success');
      $('#download-sealed').focus({ preventScroll: true });
    } catch (error) {
      if (id === operation) { setError('#seal-error', error instanceof VaultError ? error.message : 'Kilitlenemedi. Tarayıcıda yeterli bellek olduğundan emin olup yeniden dene.'); onPhase('idle'); }
    } finally {
      bytes?.fill(0); supplemental?.fill(0); sculpture?.fill(0);
      if (id === operation) { busy = false; updateButtons(); }
    }
  });
  $('#open-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || $('#open-submit').disabled) return;
    const id = ++operation; busy = true; setError('#open-error'); updateButtons(); onPhase('working');
    try {
      const file = $('#sealed-file').files[0];
      const compact = file ? await file.text() : $('#sealed-text').value;
      const secret = $('#open-key').value;
      if (id !== operation) return;
      const result = await unseal(compact, secret);
      if (id !== operation) { result.bytes.fill(0); return; }
      dropOpened(); opened = result;
      $('#opened-name').textContent = result.name;
      $('#opened-sculpture').hidden = !result.sculpture;
      $('#opened-sculpture').textContent = result.sculpture ? sculptureLabel(result.sculpture) : '';
      $('#opened-text').hidden = result.kind !== 'text';
      if (result.kind === 'text') $('#opened-text').value = decoder.decode(result.bytes);
      $('#open-key').value = ''; $('#sealed-text').value = ''; $('#sealed-file').value = '';
      $('#open-form').hidden = true; $('#open-result').hidden = false; onPhase('success');
      $('#download-opened').focus({ preventScroll: true });
    } catch (error) {
      if (id === operation) { dropOpened(); setError('#open-error', error instanceof VaultError ? error.message : 'Bu dosya açılamadı. Veriyi ve anahtarı kontrol et.'); onPhase('idle'); }
    } finally { if (id === operation) { busy = false; updateButtons(); } }
  });
  $('#download-sealed').addEventListener('click', () => { if (sealed) download(sealed.compact, 'koza-kilitli.jwe', 'application/jose'); });
  $('#download-key').addEventListener('click', () => { if (sealed) download(sealed.secret + '\n', 'koza-acma-anahtari.txt'); });
  $('#copy-key').addEventListener('click', () => { if (sealed) void copy(sealed.secret); });
  $('#copy-sealed').addEventListener('click', () => { if (sealed) void copy(sealed.compact); });
  $('#reveal-key').addEventListener('click', () => {
    const show = $('#sealed-key').type === 'password'; $('#sealed-key').type = show ? 'text' : 'password';
    $('#reveal-key').textContent = show ? 'Gizle' : 'Göster'; $('#reveal-key').setAttribute('aria-pressed', String(show));
  });
  $('#download-opened').addEventListener('click', () => { if (opened) download(opened.bytes, opened.name, opened.mime); });
  $('#seal-another').addEventListener('click', () => { dropSealed(); setError('#seal-error'); updateButtons(); (inputKind === 'text' ? $('#secret-text') : $('#secret-file')).focus(); });
  $('#open-another').addEventListener('click', () => { dropOpened(); $('#sealed-file-name').textContent = 'Kilitli dosyayı seç'; setError('#open-error'); updateButtons(); $('#sealed-text').focus(); });
  $('#vault-clear').addEventListener('click', () => clearAll());

  // Only pointer positions and timing are sampled; typed secrets are excluded.
  window.addEventListener('pointermove', (event) => {
    if (document.body.dataset.workspace !== 'vault' || !event.isTrusted || event.timeStamp - lastPointer < 90) return;
    lastPointer = event.timeStamp;
    void mixer.add(encoder.encode(`pointer:${event.clientX}:${event.clientY}:${event.timeStamp}`));
  }, { passive: true });
  $('#camera-toggle').addEventListener('click', async () => {
    if (cameraPending) return;
    if (camera.stream) { camera.stop(); notify('Kamera kapatıldı.'); return; }
    cameraPending = true; $('#camera-toggle').disabled = true;
    try { await camera.start(); if (camera.stream) notify('Kamera yalnızca bu cihazda işleniyor.'); }
    catch (error) {
      camera.stop(); notify(error.name === 'NotAllowedError' ? 'Kamera izni verilmedi. Güvenli temel kaynakla devam edebilirsin.' : 'Kamera açılamadı. Güvenli temel kaynak kullanılmaya devam ediyor.');
    } finally { cameraPending = false; $('#camera-toggle').disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) camera.stop(); });
  window.addEventListener('pagehide', () => clearAll(false));
  setWorkspace(initialWorkspace, false); updateButtons();
  if (!available) { setError('#seal-error', 'Bu tarayıcıda güvenli şifreleme kullanılamıyor. HTTPS üzerinden güncel bir tarayıcıyla aç.'); setError('#open-error', 'Güvenli şifreleme kullanılamıyor.'); }
}
