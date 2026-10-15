# Local QR helpers

No npm install or remote scripts are used. QR images are decoded locally.

- qrcode.js: https://github.com/kazuhikoarase/qrcode-generator/blob/83b7e8fe3fddd3b0368dbafd6ce56995bd25e3c8/js/dist/qrcode.mjs (only renamed to .js, MIT; qrcode-LICENSE.txt).
- jsqr.js: https://github.com/cozmo/jsQR/blob/8e6a036beafa7053dd44b1b76ac578d22b1b3311/dist/jsQR.js (Apache-2.0; jsqr-LICENSE.txt). Only an ES module wrapper was added.

These are loaded on demand by assets/obs-qr.js. Do not replace them with CDN scripts.
