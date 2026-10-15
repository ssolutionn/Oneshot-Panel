// Cloudflare Pages Function for /api/faceit: the same FACEIT proxy as the
// Netlify function and server.js (netlify/functions/faceit.mjs).
import faceit from '../../netlify/functions/faceit.mjs';

export const onRequest = ({ request }) => faceit(request);
