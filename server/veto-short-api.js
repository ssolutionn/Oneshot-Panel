import {reply, relayHeaders, readJsonBody} from './veto-relay-api.js';
import {SHORT_LINK_MAX_BYTES, shortIdValid, shortRecordValid} from '../assets/veto-short-protocol.js';

// A record is write-once and has no automatic expiry. It never contains the
// URL fragment key or a plaintext captain secret. New matches use new records.
export async function handleShortLink(request, store) {
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:relayHeaders});
  if(!['GET','POST'].includes(request.method))return reply({error:'method'},405);
  if(!store)return reply({error:'short-links-not-configured'},503);
  const params=new URL(request.url).searchParams;
  if(request.method==='GET'){
    const id=params.get('id');
    if([...params.keys()].length!==1||!shortIdValid(id))return reply({error:'id'},400);
    try{
      const row=await store.read(id);
      return shortRecordValid(row)&&row.id===id?reply(row):reply({error:'not-found'},404);
    }catch{return reply({error:'storage'},503);}
  }
  if([...params.keys()].length)return reply({error:'query'},400);
  let record;
  try{record=await readJsonBody(request,SHORT_LINK_MAX_BYTES);}
  catch(error){return reply({error:'record'},error.message==='size'?413:400);}
  if(!shortRecordValid(record))return reply({error:'record'},400);
  try{
    await store.update(record.id,old=>{
      if(old && (old.v!==record.v||old.id!==record.id||old.slug!==record.slug||
          old.box?.iv!==record.box.iv||old.box?.data!==record.box.data))throw Error('exists');
      return old||record;
    });
    return reply({v:1,accepted:true,id:record.id});
  }catch(error){return reply({error:error.message==='exists'?'exists':'storage'},error.message==='exists'?409:503);}
}
