// Cloudflare Pages Function for /api/faceit: the same FACEIT proxy as the
// Netlify function and server.js (netlify/functions/faceit.mjs). The site's
// key is the Pages secret FACEIT_API_KEY.
import { proxyFaceit } from '../../netlify/functions/faceit.mjs';

export const onRequest = ({ request, env }) => proxyFaceit(request, env?.FACEIT_API_KEY);
