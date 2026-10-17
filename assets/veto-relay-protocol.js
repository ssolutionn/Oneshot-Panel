// Signed encrypted relay packets. Shared by browsers, Workers and Node.
// No private captain key, room code, OBS password or plaintext enters a packet.
export const RELAY_VERSION = 1, MAX_PACKET_BYTES = 24000, KEEP_MS = 7*86400000;
const enc = new TextEncoder();
const pointPart = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const topicValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{14}$/.test(value);
const b64 = bytes => {
  let text=''; for(const byte of new Uint8Array(bytes))text+=String.fromCharCode(byte);
  return btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const bytes = text => Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
export async function relayTopic(point) {
  if(!Array.isArray(point)||point.length!==2||!point.every(pointPart))throw Error('Invalid publisher');
  return b64((await crypto.subtle.digest('SHA-256',enc.encode('oneshot-veto-fp|'+point[0]+'|'+point[1]))).slice(0,10));
}
export function relayEndpoint(value, base) {
  const url=new URL(value || '/api/veto-relay',base);
  const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:' && !(local&&url.protocol==='http:'))||
      url.username||url.password||url.search||url.hash||url.pathname!=='/api/veto-relay'||url.href.length>600)
    throw Error('Неверный адрес сервера вето.');
  return url.href;
}
const signed = packet => enc.encode(JSON.stringify([
  'oneshot-relay-v1',packet.topic,packet.at,packet.nonce,packet.box.iv,packet.box.data
]));
const exact = (value,keys) => value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
export function packetShape(p) {
  return exact(p,['v','topic','at','nonce','p','box','s'])&&p.v===1&&topicValid(p.topic)&&
    Number.isSafeInteger(p.at)&&p.at>0&&typeof p.nonce==='string'&&/^[A-Za-z0-9_-]{16}$/.test(p.nonce)&&
    Array.isArray(p.p)&&p.p.length===2&&p.p.every(pointPart)&&
    exact(p.box,['v','iv','data'])&&p.box.v===1&&typeof p.box.iv==='string'&&/^[A-Za-z0-9+/]{16}$/.test(p.box.iv)&&
    typeof p.box.data==='string'&&p.box.data.length>=24&&p.box.data.length<=18000&&
    p.box.data.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(p.box.data)&&
    typeof p.s==='string'&&/^[A-Za-z0-9_-]{85}[AQgw]$/.test(p.s);
}
export async function signRelayPacket(key, point, box, now=Date.now()) {
  const packet={v:1,topic:await relayTopic(point),at:now,
    nonce:b64(crypto.getRandomValues(new Uint8Array(12))),p:point,box,s:''};
  packet.s=b64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,signed(packet)));
  if(!packetShape(packet))throw Error('Неверный пакет вето.');
  return packet;
}
export async function verifyRelayPacket(packet, topic=packet?.topic) {
  if(!packetShape(packet)||packet.topic!==topic||await relayTopic(packet.p)!==topic)return false;
  try{
    const key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',
      x:packet.p[0],y:packet.p[1],ext:true},{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    return crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,bytes(packet.s),signed(packet));
  }catch{return false;}
}
