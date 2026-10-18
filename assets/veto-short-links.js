import {decodeLink} from '../veto-room.js';
import {shortTokenValid, shortPathValid, shortRecordValid} from './veto-short-protocol.js';

export const DEFAULT_TOURNAMENT = 'CyberClash';
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal:true});
const CYRILLIC = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',
  р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',і:'i',ї:'yi',є:'ye'
};
const b64 = bytes => {
  let text=''; for(const byte of new Uint8Array(bytes))text+=String.fromCharCode(byte);
  return btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const bytes = text => Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
function slugPart(value, fallback) {
  return String(value || '').toLowerCase().replace(/[а-яёіїє]/g,c=>CYRILLIC[c]).normalize('NFKD')
    .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')
    .slice(0,48).replace(/-+$/g,'') || fallback;
}
export const captainSlug = (tournament, team) => slugPart(tournament, 'cyberclash')+'_'+slugPart(team, 'team');
async function identity(token) {
  if (!shortTokenValid(token)) throw Error('short-link-invalid');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode('oneshot-veto-short-v1|'+token)))]
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
const cipherKey = token => crypto.subtle.importKey('raw',bytes(token),'AES-GCM',false,['encrypt','decrypt']);
const aad = (id,slug) => enc.encode('oneshot-veto-short-v1|'+id+'|'+slug);
function endpoint(input) {
  const url=new URL('/api/veto-link',input);
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
    throw Error('short-link-invalid');
  if(url.username||url.password)throw Error('short-link-invalid');
  // The panel's CSP permits these two remote veto sites. A custom static
  // site keeps legacy links; a custom site's own form can use its own API.
  const own=globalThis.location?.origin;
  if(own && url.origin!==own && !['https://oneshot-veto.pages.dev','https://oneshot-veto.cyberclash.workers.dev'].includes(url.origin))
    throw Error('short-link-unavailable');
  return url;
}
export async function packCaptainLink(link, tournament = DEFAULT_TOURNAMENT) {
  const original=new URL(link),room=decodeLink(original.hash);
  if(!room || !['a','b'].includes(room.me))throw Error('short-link-invalid');
  const token=b64(crypto.getRandomValues(new Uint8Array(16))),id=await identity(token);
  const slug=captainSlug(tournament,room.t[room.me==='a'?0:1]);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(id,slug)},await cipherKey(token),
    enc.encode(JSON.stringify({v:1,hash:original.hash})));
  const record={v:1,id,slug,box:{iv:b64(iv),data:b64(data)}};
  if(!shortRecordValid(record))throw Error('short-link-invalid');
  const pretty=new URL('/'+slug,original);pretty.search='';pretty.hash='k='+token;
  return {link:pretty.href,record};
}
export async function unpackCaptainLink(link, record) {
  const url=new URL(link),params=new URLSearchParams(url.hash.slice(1)),token=params.get('k');
  if([...params.keys()].length!==1 || !shortPathValid(url.pathname) || !shortTokenValid(token))throw Error('short-link-invalid');
  const id=await identity(token),slug=url.pathname.slice(1);
  if(!shortRecordValid(record)||record.id!==id||record.slug!==slug)throw Error('short-link-invalid');
  try {
    const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(record.box.iv),additionalData:aad(id,slug)},
      await cipherKey(token),bytes(record.box.data));
    const value=JSON.parse(dec.decode(plaintext)),room=decodeLink(value.hash);
    if(value.v!==1 || !room || !['a','b'].includes(room.me))throw Error('room');
    const canonical=new URL('/veto.html',url);canonical.hash=value.hash;
    return {room,canonical:canonical.href};
  } catch {throw Error('short-link-invalid');}
}
export async function friendlyCaptainLinks(made, base, tournament = DEFAULT_TOURNAMENT, request = fetch) {
  const result={...made,tournament:String(tournament||DEFAULT_TOURNAMENT).trim()||DEFAULT_TOURNAMENT,links:{...made.links},shortLinkFallback:false};
  await Promise.all(['a','b'].map(async seat=>{
    try {
      const packed=await packCaptainLink(made.links[seat],result.tournament);
      const response=await request(endpoint(base).href,{method:'POST',credentials:'omit',cache:'no-store',
        headers:{'content-type':'application/json'},body:JSON.stringify(packed.record),signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw Error('unavailable');
      const saved=await response.json();
      if(saved.id!==packed.record.id||saved.accepted!==true)throw Error('unavailable');
      result.links[seat]=packed.link;
    } catch {result.shortLinkFallback=true;}
  }));
  return result;
}
export async function resolveRoomLink(input, request = fetch, storage) {
  const url=new URL(input),room=decodeLink(url.hash);
  if(room)return {room,canonical:url.href};
  const params=new URLSearchParams(url.hash.slice(1));
  if(!params.has('k')&&!shortPathValid(url.pathname))return null;
  const token=params.get('k');
  if([...params.keys()].length!==1||!shortPathValid(url.pathname)||!shortTokenValid(token))throw Error('short-link-invalid');
  const api=endpoint(url),id=await identity(token),cacheKey='oneshot-veto-short:'+id;
  if(storage===undefined){try{storage=globalThis.localStorage;}catch{storage=null;}}
  try {
    const cached=JSON.parse(storage?.getItem(cacheKey)||'null');
    if(cached)return await unpackCaptainLink(url.href,cached);
  } catch { /* A damaged cache is replaced from the immutable server record. */ }
  api.searchParams.set('id',id);
  let record;
  try {
    const response=await request(api.href,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(response.status===404)throw Error('short-link-missing');
    if(!response.ok)throw Error('short-link-unavailable');
    record=await response.json();
  } catch(error) {throw Error(error.message==='short-link-missing'?'short-link-missing':'short-link-unavailable');}
  const resolved=await unpackCaptainLink(url.href,record);
  try{storage?.setItem(cacheKey,JSON.stringify(record));}catch{ /* Storage is optional. */ }
  return resolved;
}
