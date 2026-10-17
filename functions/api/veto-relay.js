// Pages forwards only this fixed API to our Durable Object Worker.
// No destination, URL or credentials are accepted from the browser.
import {reply,relayHeaders,readRelayPacket,topicList} from '../../server/veto-relay-api.js';
const UPSTREAM='https://oneshot-veto.cyberclash.workers.dev/api/veto-relay';
export async function onRequest({request}) {
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
    const response=await fetch(UPSTREAM+(request.method==='GET'?'?'+params.toString():''),{
      method:request.method,headers:body?{'content-type':'application/json'}:{},
      body,redirect:'error',signal:controller.signal});
    if(!response.headers.get('content-type')?.includes('application/json'))throw Error('unconfigured');
    return new Response(await response.text(),{status:response.status,headers:relayHeaders});
  }catch{return reply({protocol:1,ready:false,error:'relay-unavailable'},503);}
  finally{clearTimeout(timer);}
}
