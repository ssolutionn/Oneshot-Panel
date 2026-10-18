// Pages forwards only this fixed API to our Durable Object Worker.
// No destination, URL or credentials are accepted from the browser.
import {reply,relayHeaders,readRelayPacket,topicList} from '../../server/veto-relay-api.js';
const UPSTREAM='https://oneshot-veto.cyberclash.workers.dev/api/veto-relay';
export async function onRequest({request,env}) {
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:relayHeaders});
  if(!['GET','POST'].includes(request.method))return reply({error:'method'},405);
  const params=new URL(request.url).searchParams;
  const health=params.get('health')==='1'&&[...params.keys()].length===1;
  if(request.method==='GET'&&!health&&!topicList(request))return reply({error:'topics'},400);
  if(request.method==='POST'&&[...params.keys()].length)return reply({error:'query'},400);
  let body;
  if(request.method==='POST'){
    try{body=JSON.stringify(await readRelayPacket(request));}
    catch(e){return reply({error:'packet'},e.message==='size'?413:400);}
  }
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
    const upstream=UPSTREAM+(request.method==='GET'?'?'+params.toString():'');
    const options={
      method:request.method,headers:body?{'content-type':'application/json'}:{},
      body,redirect:'manual',signal:controller.signal};
    const response=await (env?.VETO_RELAY_SERVICE?
      env.VETO_RELAY_SERVICE.fetch(upstream,options):fetch(upstream,options));
    if(response.status>=300&&response.status<400)throw Error('redirect');
    if(!response.headers.get('content-type')?.includes('application/json'))throw Error('unconfigured');
    return new Response(await response.text(),{status:response.status,headers:relayHeaders});
  }catch{return reply({protocol:1,ready:false,error:'relay-unavailable'},503);}
  finally{clearTimeout(timer);}
}
