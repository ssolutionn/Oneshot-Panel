// Cloudflare Pages Function для /api/ebot-admin: тот же контракт, что
// Netlify-функция (netlify/functions/ebot-admin.mjs). Секреты EBOT_URL /
// EBOT_USER / EBOT_PASSWORD — переменные Pages. AES для edge — статически:
// node:fs/node:vm на Cloudflare недоступны, поэтому vendored файл
// исполняется через Function (глобальные Aes/Utf8/Base64, наружу только Aes).
import { proxyEbotAdmin } from '../../netlify/functions/ebot-admin.mjs';
import AES_SRC from '../../server/vendor/aes-ctr.js?raw';
import { createEbotAdmin } from '../../server/ebot-admin.js';

let aesCache = null;
const loadAes = () => {
  if (aesCache) return Promise.resolve(aesCache);
  const ctx = { String, Math, Date, parseInt, isNaN, fromCharCode: String.fromCharCode };
  new Function('window', 'globalThis', AES_SRC).call(ctx, ctx, ctx);
  aesCache = { Aes: ctx.Aes };
  return Promise.resolve(aesCache);
};

export const onRequest = ({ request, env }) => proxyEbotAdmin(request, {
  EBOT_URL: env?.EBOT_URL || '',
  EBOT_USER: env?.EBOT_USER || '',
  EBOT_PASSWORD: env?.EBOT_PASSWORD || ''
}, loadAes);
