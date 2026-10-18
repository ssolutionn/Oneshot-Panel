import {shortPathValid} from '../assets/veto-short-protocol.js';
export function onRequest({request,env,next}) {
  const url=new URL(request.url);
  if(!['GET','HEAD'].includes(request.method)||!shortPathValid(url.pathname))return next();
  // Cloudflare canonicalizes /veto.html to /veto. Fetch the clean asset
  // internally so its redirect cannot replace the personal pretty address.
  url.pathname='/veto';
  return env.ASSETS.fetch(new Request(url,request));
}
