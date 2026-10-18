import {reply,relayHeaders,readJsonBody} from '../../server/veto-relay-api.js';
import {SHORT_LINK_MAX_BYTES,shortIdValid,shortRecordValid} from '../../assets/veto-short-protocol.js';
const UPSTREAM='https://oneshot-veto.cyberclash.workers.dev/api/veto-link';
export async function onRequest({request,env}) {
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:relayHeaders});
  if(!['GET','POST'].includes(request.method))return reply({error:'method'},405);
  const params=new URL(request.url).searchParams;
  let body;
  if(request.method==='GET'){
    if([...params.keys()].length!==1||!shortIdValid(params.get('id')))return reply({error:'id'},400);
  }else{
    if([...params.keys()].length)return reply({error:'query'},400);
    try{
      const record=await readJsonBody(request,SHORT_LINK_MAX_BYTES);
      if(!shortRecordValid(record))throw Error('record');
      body=JSON.stringify(record);
    }catch(error){return reply({error:'record'},error.message==='size'?413:400);}
  }
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
    const target=UPSTREAM+(request.method==='GET'?'?'+params:'');
    const options={method:request.method,headers:body?{'content-type':'application/json'}:{},body,redirect:'manual',signal:controller.signal};
    const response=await (env?.VETO_RELAY_SERVICE?env.VETO_RELAY_SERVICE.fetch(target,options):fetch(target,options));
    if(response.status>=300&&response.status<400||!response.headers.get('content-type')?.includes('application/json'))throw Error('upstream');
    return new Response(await response.text(),{status:response.status,headers:relayHeaders});
  }catch{return reply({error:'short-links-unavailable'},503);}
  finally{clearTimeout(timer);}
}
