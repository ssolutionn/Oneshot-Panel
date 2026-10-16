// Cloudflare Pages Function for /api/bookmakers: the same line check as the
// Netlify function and server.js (netlify/functions/bookmakers.mjs).
import { bookmakersResponse } from '../../netlify/functions/bookmakers.mjs';

export const onRequest = ({ request }) => bookmakersResponse(request);
