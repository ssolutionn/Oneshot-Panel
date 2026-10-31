// Cloudflare Pages Function для /api/ebot-admin: тот же контракт, что
// Netlify-функция (netlify/functions/ebot-admin.mjs). Секреты EBOT_URL /
// EBOT_USER / EBOT_PASSWORD — переменные Pages. AES для edge — статически:
// node:fs/node:vm на Cloudflare недоступны, а прежний `?raw`-импорт с
// загрузкой через new Function не работал (импорт не резолвится, var не
// выходит из scope), поэтому берём копию с export — aes-ctr-esm.js.
import { proxyEbotAdmin } from '../../netlify/functions/ebot-admin.mjs';
import { Aes } from '../../server/vendor/aes-ctr-esm.js';

const loadAes = () => Promise.resolve({ Aes });

export const onRequest = ({ request, env }) => proxyEbotAdmin(request, {
  EBOT_URL: env?.EBOT_URL || '',
  EBOT_USER: env?.EBOT_USER || '',
  EBOT_PASSWORD: env?.EBOT_PASSWORD || '',
  EBOT_ADMIN_TOKEN: env?.EBOT_ADMIN_TOKEN || '',
  EBOT_ADMIN_OPEN: env?.EBOT_ADMIN_OPEN || ''
}, loadAes);
