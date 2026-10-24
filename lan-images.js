// Browser-only: a cut-out photo (an iPhone «Скопировать объект» PNG) or a logo
// becomes a small, trimmed image that fits inside a card page. The card is one
// data: URL sent through a data channel, so every image is kept small.
const PHOTO = { height: 800, steps: [800, 640, 480, 360], limit: 110000, quality: 0.8 };
const LOGO = { height: 256, steps: [256, 192, 128], limit: 40000 };
const WORK = 1600; // longest side while looking for the person's edges

function canvasOf(width, height) {
  return Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });
}
// The box around everything that is not (almost) transparent.
function opaqueBox(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  let left = width, top = height, right = -1, bottom = -1, clear = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha < 250) clear++;
      if (alpha > 8) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return { box: right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }, transparent: clear > width * height * 0.01 };
}
async function encode(canvas, type, quality) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new Error('браузер не смог сжать картинку');
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('браузер не смог прочитать картинку'));
    reader.readAsDataURL(blob);
  });
  return url;
}
// A stored data: URL as a bitmap. createImageBitmap takes the bytes directly,
// so the panel's img-src 'self' policy is not involved (no <img> is used).
async function bitmapOf(dataUrl) {
  if (!dataUrl) return null;
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: dataUrl.slice(5, dataUrl.indexOf(';')) }));
}
// A small picture of a logo (whole, centred) or a photo (head and shoulders:
// the cut-out fills the width from the top), for the editor's slots.
export async function drawThumb(canvas, dataUrl, mode = 'contain') {
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  const bitmap = await bitmapOf(dataUrl).catch(() => null);
  if (!bitmap) return false;
  const k = mode === 'head' ? canvas.width / bitmap.width : Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
  const w = bitmap.width * k, h = bitmap.height * k;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, (canvas.width - w) / 2, mode === 'head' ? 0 : (canvas.height - h) / 2, w, h);
  bitmap.close?.();
  return true;
}
// The card the way OBS will show it (same 1920×1080 geometry as the card page),
// drawn on a canvas for a quick look at the crop, the logo and the nick.
export async function drawCardPreview(canvas, { team, nick, photo, logo, colors }) {
  const k = canvas.width / 1920, c = { accent: '#00d3ef', deep: '#043746', black: '#031b24', cyan: '#00bedf', teal: '#087f91', ...colors };
  const [photoBitmap, logoBitmap] = await Promise.all([bitmapOf(photo), bitmapOf(logo)]);
  const g = canvas.getContext('2d');
  g.setTransform(k, 0, 0, k, 0, 0);
  g.fillStyle = c.black; g.fillRect(0, 0, 1920, 1080);
  const base = g.createLinearGradient(0, 0, 1920, 1080);
  base.addColorStop(0, c.teal); base.addColorStop(0.48, c.deep); base.addColorStop(1, c.teal);
  g.fillStyle = base; g.fillRect(0, 0, 1920, 1080);
  const glow = g.createRadialGradient(960, 160, 0, 960, 160, 900);
  glow.addColorStop(0, c.cyan); glow.addColorStop(1, 'transparent');
  g.fillStyle = glow; g.fillRect(0, 0, 1920, 1080);
  if (photoBitmap) {
    const h = 1000, w = photoBitmap.width * h / photoBitmap.height;
    g.save(); g.shadowColor = c.teal; g.shadowBlur = 28; g.drawImage(photoBitmap, 960 - w / 2, 35, w, h); g.restore();
    const shade = g.createLinearGradient(0, 1080, 0, 1080 * 0.57);
    shade.addColorStop(0, c.black); shade.addColorStop(1, 'transparent');
    g.fillStyle = shade; g.fillRect(0, 0, 1920, 1080);
  }
  g.textAlign = 'center'; g.fillStyle = '#fff'; g.shadowColor = '#00151bb3'; g.shadowBlur = 30;
  const nickText = String(nick || 'Игрок'), small = Boolean(photoBitmap);
  let size = small ? 160 : 224;
  g.font = `900 ${size}px "Arial Black","Segoe UI",Arial,sans-serif`;
  while (g.measureText(nickText).width > 1600 && size > 52) { size -= 4; g.font = `900 ${size}px "Arial Black","Segoe UI",Arial,sans-serif`; }
  const nickY = small ? 1020 : 640;
  g.fillText(nickText, 960, nickY);
  g.shadowBlur = 14; g.fillStyle = '#d2edf1';
  g.font = `700 ${small ? 30 : 46}px "Segoe UI",Arial,sans-serif`;
  const teamText = String(team || '').toUpperCase(), teamY = nickY - size * 1.05;
  g.fillText(teamText, 960, teamY);
  if (logoBitmap) {
    if (small) { const w = 60 * logoBitmap.width / logoBitmap.height; g.drawImage(logoBitmap, 960 - g.measureText(teamText).width / 2 - w - 20, teamY - 46, w, 60); }
    else { g.drawImage(logoBitmap, 960 - 140, 150, 280, 280); }
  }
  g.shadowBlur = 0;
  if (!small) { g.fillStyle = c.accent; g.fillRect(960 - 140, nickY + 32, 280, 12); }
  photoBitmap?.close?.(); logoBitmap?.close?.();
}
// A placeholder picture for a side's cameras: the whole picture, at most
// 1280 px, JPEG small enough to travel to the OBS window (≤ 380 000 characters).
export async function processPlate(blob) {
  let bitmap;
  try { bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { throw new Error('файл не открывается как картинка'); }
  try {
    for (const side of [1280, 1080, 900, 720]) {
      const ratio = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const out = canvasOf(bitmap.width * ratio, bitmap.height * ratio);
      const context = out.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.fillStyle = '#031b24';
      context.fillRect(0, 0, out.width, out.height);
      context.drawImage(bitmap, 0, 0, out.width, out.height);
      for (const quality of [0.86, 0.78, 0.7]) {
        const url = await encode(out, 'image/jpeg', quality);
        if (url.length <= 380000) return url;
      }
    }
  } finally { bitmap.close?.(); }
  throw new Error('слишком большая даже после сжатия');
}
// kind: 'photo' | 'logo'. Resolves { url, warning }.
export async function processImage(blob, kind) {
  const spec = kind === 'logo' ? LOGO : PHOTO;
  let bitmap;
  try { bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { throw new Error('файл не открывается как картинка'); }
  try {
    const scale = Math.min(1, WORK / Math.max(bitmap.width, bitmap.height));
    const work = canvasOf(bitmap.width * scale, bitmap.height * scale);
    work.getContext('2d').drawImage(bitmap, 0, 0, work.width, work.height);
    const { box, transparent } = opaqueBox(work);
    if (!box) throw new Error('картинка целиком прозрачная');
    const warning = transparent ? '' : 'без прозрачного фона';
    for (const height of spec.steps) {
      const ratio = Math.min(1, height / box.height);
      const out = canvasOf(box.width * ratio, box.height * ratio);
      const context = out.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(work, box.x, box.y, box.width, box.height, 0, 0, out.width, out.height);
      let url = await encode(out, kind === 'logo' ? 'image/png' : 'image/webp', spec.quality);
      // Safari cannot make WebP and answers with PNG: still fine, only larger.
      if (url.length <= spec.limit || height === spec.steps.at(-1)) {
        if (url.length > 390000) throw new Error('слишком большой после сжатия');
        return { url, warning };
      }
    }
  } finally { bitmap.close?.(); }
  throw new Error('не удалось сжать');
}
