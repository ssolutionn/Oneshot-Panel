// Same protocol on Cloudflare and a self-hosted HTTP server. No VDO frames.
import {relayEndpoint,signRelayPacket,verifyRelayPacket,topicValid} from './veto-relay-protocol.js';
const timeout = ms => {const c=new AbortController();const timer=setTimeout(()=>c.abort(),ms);return{signal:c.signal,stop:()=>clearTimeout(timer)};};
export async function checkRelay(endpoint) {
  const deadline=timeout(8000);
  try{
    const url=new URL(endpoint);url.searchParams.set('health','1');
    const r=await fetch(url,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:deadline.signal});
    const body=await r.json();
    if(!r.ok||body?.protocol!==1||body.ready!==true)throw Error('offline');
  }catch{throw Error('Сервер вето недоступен или ещё не настроен. Комната не создана.');}
  finally{deadline.stop();}
}
export class RelayClient {
  constructor(endpoint,topics,onPacket,{publisher=null,onStatus=()=>{},interval=1000,fetchImpl=globalThis.fetch.bind(globalThis)}={}) {
    this.endpoint=relayEndpoint(endpoint,globalThis.location?.href);
    this.topics=[...new Set(topics)];
    if(!this.topics.length||this.topics.length>4||!this.topics.every(topicValid))throw Error('Invalid topics');
    Object.assign(this,{onPacket,publisher,onStatus,interval,fetchImpl});
    this.seen=new Map();this.stopped=false;this.timer=null;this.failures=0;this.lastPacketAt=0;
    this.pending=null;this.sending=null;this.writeFailed=false;this.controllers=new Set();
    this.wake=()=>{clearTimeout(this.timer);this.poll();};
    globalThis.addEventListener?.('online',this.wake);
    globalThis.addEventListener?.('pageshow',this.wake);
    this.visible=()=>{if(globalThis.document?.visibilityState==='visible')this.wake();};
    globalThis.document?.addEventListener('visibilitychange',this.visible);
    this.poll();
  }
  async request(url,init={}) {
    if(this.stopped)throw Error('closed');
    const c=new AbortController();this.controllers.add(c);const timer=setTimeout(()=>c.abort(),8000);
    try{
      const r=await this.fetchImpl(url,{...init,signal:c.signal,cache:'no-store',credentials:'omit',
        referrerPolicy:'no-referrer',redirect:'error'});
      if(!r.ok)throw Error('HTTP '+r.status);
      const body=await r.json();if(this.stopped)throw Error('closed');return body;
    }finally{clearTimeout(timer);this.controllers.delete(c);}
  }
  async poll() {
    if(this.stopped||this.polling)return;
    this.polling=true;clearTimeout(this.timer);
    try{
      const url=new URL(this.endpoint);url.searchParams.set('topics',this.topics.join(','));
      const result=await this.request(url);
      if(result?.protocol!==1||!Array.isArray(result.records)||result.records.length>4||!Number.isFinite(result.now))throw Error('Invalid relay response');
      for(const record of result.records){
        const p=record?.packet;
        if(!this.topics.includes(p?.topic)||this.seen.get(p.topic)===p.s)continue;
        if(!await verifyRelayPacket(p,p.topic))continue;
        if(this.stopped)return;
        this.seen.set(p.topic,p.s);
        const age=result.now-record.receivedAt;
        await this.onPacket(p.box,p.topic,Number.isFinite(age)&&age>=-1000&&age<8000,p.at);
      }
      this.failures=0;this.onStatus(this.writeFailed?'retry':'online');
    }catch{if(!this.stopped){this.failures++;this.onStatus('retry');}}
    finally{
      this.polling=false;
      if(!this.stopped)this.timer=setTimeout(()=>this.poll(),Math.min(8000,this.interval*Math.max(1,this.failures)));
    }
  }
  send(box) {
    if(!this.publisher||this.stopped)return Promise.resolve(false);
    this.pending=box;
    if(this.sending)return this.sending;
    this.sending=(async()=>{
      let accepted=false;
      while(this.pending&&!this.stopped){
        const next=this.pending;this.pending=null;
        try{
          const now=Math.max(Date.now(),this.lastPacketAt+1);this.lastPacketAt=now;
          const packet=await signRelayPacket(this.publisher.key,this.publisher.point,next,now);
          const reply=await this.request(this.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(packet)});
          if(reply.protocol!==1||reply.accepted!==true)throw Error('Relay did not accept packet');
          this.writeFailed=false;this.onStatus('online');accepted=true;
        }catch{
          if(!this.stopped){this.pending ||= next;this.writeFailed=true;this.onStatus('retry');}
          break;
        }
      }
      return accepted;
    })().finally(()=>{this.sending=null;});
    return this.sending;
  }
  close() {
    this.stopped=true;this.pending=null;clearTimeout(this.timer);
    globalThis.removeEventListener?.('online',this.wake);
    globalThis.removeEventListener?.('pageshow',this.wake);
    globalThis.document?.removeEventListener('visibilitychange',this.visible);
    for(const c of this.controllers)c.abort();this.controllers.clear();
  }
}
