import {cloudflareRelay,cloudflareShortLink} from './server/veto-relay-cloudflare.js';
import {shortPathValid} from './assets/veto-short-protocol.js';
export {VetoRelayTopic} from './server/veto-relay-cloudflare.js';
export default {
 fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/api/veto-relay')return cloudflareRelay(request,env);
  if(url.pathname==='/api/veto-link')return cloudflareShortLink(request,env);
  if(['GET','HEAD'].includes(request.method)&&shortPathValid(url.pathname)){
   url.pathname='/veto';return env.ASSETS.fetch(new Request(url,request));
  }
  return env.ASSETS.fetch(request);
 }
};
