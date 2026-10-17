import {cloudflareRelay} from './server/veto-relay-cloudflare.js';
export {VetoRelayTopic} from './server/veto-relay-cloudflare.js';
export default {
 fetch(request,env){
  return new URL(request.url).pathname==='/api/veto-relay'?
    cloudflareRelay(request,env):env.ASSETS.fetch(request);
 }
};
