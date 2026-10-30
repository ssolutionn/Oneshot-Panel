// Cloudflare Pages Function for /api/ebot: the same eBot match-list proxy
// as the Netlify function and server.js (netlify/functions/ebot.mjs). The
// eBot server URL is the Pages secret EBOT_URL (default: the Flegma build).
import { proxyEbot } from '../../netlify/functions/ebot.mjs';

export const onRequest = ({ request, env }) => proxyEbot(request, env?.EBOT_URL);
