import { normalizeCode } from '../vdo.js';

const invalid = () => new Error('Это не QR подключения OBS. Открой в OBS «Показать сведения о подключении».');

// OBS's ConnectInfo.cpp encodes obsws://host:port/<percent-encoded password>.
// Never echo the payload: it contains the OBS password.
export function parseObsQr(value) {
  if (typeof value !== 'string' || value.length > 4096) throw invalid();
  const text = value.trim();
  if (!/^obsws:\/\//i.test(text) || /[\x00-\x20\x7f]/.test(text)) throw invalid();
  let url, password;
  try {
    url = new URL(text);
    password = decodeURIComponent(url.pathname.slice(1));
  } catch { throw invalid(); }
  const port = Number(url.port);
  if (!url.hostname || !/^\d+$/.test(url.port) || port < 1 || port > 65535 ||
      url.username || url.password || url.search || url.hash ||
      /[\x00-\x1f\x7f]/.test(password)) throw invalid();
  return { url: 'ws://' + url.host, password };
}

// Both the dock and "this computer" mode talk to their own OBS, not its LAN IP.
export function localObsUrl(value) {
  const url = new URL(value);
  return 'ws://127.0.0.1:' + (url.port || '4455');
}

export function pairingUrl(base, code) {
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error('Неверный код связи.');
  const url = new URL('/', base);
  url.hash = new URLSearchParams({ obs: normalized }).toString();
  return url.href;
}
export function parsePairingQr(value, base) {
  const error = () => new Error('Нужен QR «Подключить телефон» из дока Oneshot. QR самого OBS загрузи в доке на компьютере.');
  if (typeof value !== 'string' || value.length > 2048) throw error();
  let url;
  try { url = new URL(value.trim()); } catch { throw error(); }
  const code = normalizeCode(new URLSearchParams(url.hash.slice(1)).get('obs'));
  if (url.origin !== new URL(base).origin || url.pathname !== '/' ||
      url.search || url.username || url.password || !code) throw error();
  return code;
}

export async function drawQr(canvas, text) {
  const { default: qrcode } = await import('./vendor/qrcode.js');
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const count = qr.getModuleCount(), quiet = 4, cell = 6;
  canvas.width = canvas.height = (count + quiet * 2) * cell;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
    if (qr.isDark(row, col)) ctx.fillRect((col + quiet) * cell, (row + quiet) * cell, cell, cell);
  }
}

let decoder;
async function decode(source, width, height) {
  decoder ||= import('./vendor/jsqr.js').then(module => module.default);
  const jsQR = await decoder;
  const scale = Math.min(1, 1600 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data || '';
}

// No upload and no BarcodeDetector dependency: also works in Safari/OBS CEF.
export function mountQrReader(root, { title = 'Заполнить по QR', hint, onRead }) {
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const details = make('details', '', 'obs-qr-reader');
  const summary = make('summary', title);
  const intro = make('p', hint, 'obs-field-hint');
  const actions = make('div', '', 'obs-qr-actions');
  const scan = make('button', 'Сканировать камерой', 'button small');
  const upload = make('button', 'Загрузить QR / скриншот', 'button small');
  const file = make('input');
  file.type = 'file';
  file.accept = 'image/png,image/jpeg,image/webp,image/bmp';
  file.hidden = true;
  file.setAttribute('aria-label', 'Изображение с QR-кодом');
  scan.type = upload.type = 'button';
  actions.append(scan, upload, file);
  const video = make('video', '', 'obs-qr-video');
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.hidden = true;
  const stop = make('button', 'Выключить камеру', 'text-button');
  stop.type = 'button';
  stop.hidden = true;
  const manual = make('details', '', 'obs-qr-manual');
  const input = make('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Содержимое QR-кода');
  const label = make('label', 'Вставь содержимое QR, если оно уже скопировано');
  label.append(input);
  const apply = make('button', 'Заполнить поля', 'button small');
  apply.type = 'button';
  manual.append(make('summary', 'Вставить содержимое QR текстом'), label, apply);
  const status = make('p', '', 'obs-qr-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  details.append(summary, intro, actions, video, stop, manual, status);
  root.append(details);

  let stream = null, timer, startupTimer, generation = 0;
  const report = (text, bad = false) => {
    status.textContent = text;
    status.dataset.kind = bad ? 'bad' : '';
  };
  function stopCamera() {
    generation++;
    clearTimeout(timer);
    clearTimeout(startupTimer);
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    video.hidden = stop.hidden = true;
    scan.disabled = false;
  }
  function accept(text) {
    try {
      const message = onRead(text);
      input.value = '';
      stopCamera();
      report(message || 'Поля заполнены. Проверь данные и сохрани подключение.');
      return true;
    } catch (error) {
      report(error.message, true);
      return false;
    }
  }
  scan.addEventListener('click', async () => {
    stopCamera();
    const current = generation;
    scan.disabled = true;
    report('Разреши доступ к камере и наведи её на QR.');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera unavailable');
      const next = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false
      });
      if (current !== generation) { next.getTracks().forEach(track => track.stop()); return; }
      stream = next;
      video.srcObject = stream;
      video.hidden = stop.hidden = false;
      startupTimer = setTimeout(() => {
        if (current !== generation || (video.videoWidth && video.videoHeight)) return;
        stopCamera();
        report('Камера не передаёт изображение. Загрузи скриншот QR или введи данные вручную.', true);
      }, 10000);
      await video.play();
      async function tick() {
        if (current !== generation) return;
        try {
          if (video.videoWidth && video.videoHeight) {
            clearTimeout(startupTimer);
            const text = await decode(video, video.videoWidth, video.videoHeight);
            if (current !== generation) return;
            if (text) {
              if (accept(text)) return;
              stopCamera();
              return;
            }
          }
        } catch {
          stopCamera();
          report('Не удалось прочитать камеру. Загрузи скриншот QR или введи данные вручную.', true);
          return;
        }
        timer = setTimeout(tick, 200);
      }
      tick();
    } catch {
      if (current !== generation) return;
      stopCamera();
      report('Камера недоступна. Разреши доступ в браузере или загрузи скриншот QR. Поля можно заполнить вручную.', true);
    }
  });
  stop.addEventListener('click', stopCamera);
  upload.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const selected = file.files?.[0];
    file.value = '';
    if (!selected) return;
    stopCamera();
    const current = generation;
    if (selected.size > 12 * 1024 * 1024) return report('Изображение больше 12 МБ. Выбери скриншот поменьше.', true);
    report('Читаем QR на этом устройстве…');
    let bitmap;
    try {
      // createImageBitmap does not require blob: or data: in img-src.
      bitmap = await createImageBitmap(selected);
      if (bitmap.width * bitmap.height > 40_000_000) throw new Error('too large');
      const text = await decode(bitmap, bitmap.width, bitmap.height);
      if (current !== generation) return;
      if (text) accept(text);
      else report('QR не найден. Выбери чёткий скриншот, где код виден целиком.', true);
    } catch {
      if (current === generation) report('Не удалось прочитать изображение. Выбери PNG или JPG с QR-кодом.', true);
    } finally { bitmap?.close(); }
  });
  apply.addEventListener('click', () => accept(input.value));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); accept(input.value); }
  });
  details.addEventListener('toggle', () => { if (!details.open) stopCamera(); });
  root.closest('form')?.addEventListener('submit', stopCamera);
  root.closest('form')?.addEventListener('change', event => {
    if (event.target.name === 'obsMode') stopCamera();
  });
  const parent = root.closest('details');
  parent?.addEventListener('toggle', () => { if (!parent.open) stopCamera(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
  document.addEventListener('oneshot:view', event => { if (event.detail !== 'prep') stopCamera(); });
  window.addEventListener('pagehide', stopCamera);
  return { stop: stopCamera };
}
