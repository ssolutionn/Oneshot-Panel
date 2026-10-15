import test from 'node:test';
import assert from 'node:assert/strict';
import { parseObsQr, localObsUrl, pairingUrl, parsePairingQr } from '../assets/obs-qr.js';
import qrcode from '../assets/vendor/qrcode.js';
import jsQR from '../assets/vendor/jsqr.js';

const base = 'https://onepanel.netlify.app';
const code = 'ABCD-EFGH-JKLM-NPQR';
function roundTrip(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte'); qr.make();
  const size = (qr.getModuleCount() + 8) * 6;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < qr.getModuleCount(); y++) for (let x = 0; x < qr.getModuleCount(); x++) {
    if (!qr.isDark(y, x)) continue;
    for (let dy = 0; dy < 6; dy++) for (let dx = 0; dx < 6; dx++) {
      const at = (((y + 4) * 6 + dy) * size + (x + 4) * 6 + dx) * 4;
      pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
    }
  }
  return jsQR(pixels, size, size)?.data;
}

test('Native OBS QR: encoded password, custom port, IPv6 and no authentication', () => {
  const text = 'obsws://192.168.1.9:4466/p%40ss%2Fword%20%23%25%3F';
  assert.equal(roundTrip(text), text);
  assert.deepEqual(parseObsQr(text), { url: 'ws://192.168.1.9:4466', password: 'p@ss/word #%?' });
  assert.equal(localObsUrl(parseObsQr(text).url), 'ws://127.0.0.1:4466');
  assert.deepEqual(parseObsQr('obsws://[2001:db8::1]:4455'), { url: 'ws://[2001:db8::1]:4455', password: '' });
  assert.deepEqual(parseObsQr(' obsws://192.168.1.9:4455/ '), { url: 'ws://192.168.1.9:4455', password: '' });
});
test('Malformed or unrelated QR leaves parsing failed, without echoing secrets', () => {
  for (const value of ['hello', 'https://example.com', 'obsws://x', 'obsws://x:0/p',
    'obsws://x:65536/p', 'obsws://u:p@x:4455/p', 'obsws://x:4455/%XX',
    'obsws://x:4455/p?evil', 'obsws://x:4455/p#evil', 'obsws://x:4455/%00',
    'obsws://x:4455/a\nb', null, 'x'.repeat(5000)]) {
    assert.throws(() => parseObsQr(value), /не QR подключения OBS/);
  }
});
test('Phone pairing QR contains only its separate control code and validates origin', () => {
  const url = pairingUrl(base, code);
  assert.equal(url, base + '/#obs=' + code);
  assert.equal(roundTrip(url), url);
  assert.equal(parsePairingQr(url, base), code);
  for (const other of [
    'https://evil.example/#obs=' + code, base + '/other#obs=' + code,
    base + '/?password=secret#obs=' + code, base + '/#obs=bad',
    'obsws://192.168.1.9:4455/private-password'
  ]) assert.throws(() => parsePairingQr(other, base), /QR «Подключить телефон»/);
});
