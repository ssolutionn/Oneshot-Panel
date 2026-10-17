// Adapt the shared signed HTTP relay to the existing encrypted room messages.
import {RelayClient} from './veto-relay-client.js';
import {seal,unseal,bridgeSecrets,normalizeCode} from '../vdo.js';
import {displayRelayIdentity} from '../veto-room.js';
export class ServerRoomLink {
  constructor(room,secrets,key,onMessage,onStatus=()=>{}) {
    this.secrets=secrets;this.onMessage=onMessage;this.stopped=false;
    const me=room.me==='a'?0:room.me==='b'?1:null;
    this.client=new RelayClient(room.relay,room.fp,(box,topic,fresh)=>this.open(box,fresh?secrets.streams[room.fp.indexOf(topic)]:''),
      {publisher:me===null?null:{key,point:room.p[me]},onStatus});
  }
  async open(box,via){const msg=await unseal(this.secrets.key,box);if(msg&&!this.stopped)return this.onMessage(msg,via);}
  async send(message){if(!this.stopped)return this.client.send(await seal(this.secrets.key,message));}
  close(){this.stopped=true;this.client.close();}
}
export function connectServerWatch(room,secrets,deliver,onStatus=()=>{}) {
  const client=new RelayClient(room.relay,room.fp,(box,topic,fresh)=>deliver(box,room.fp.indexOf(topic),fresh),{onStatus});
  return {stop:()=>client.close()};
}
export class ServerDisplayLink {
  static async create(code,role,endpoint,onMessage,onStatus=()=>{},notBefore=0) {
    code=normalizeCode(code);if(!code)throw Error('Неверный код показа вето.');
    const [secrets,publisher,other]=await Promise.all([bridgeSecrets(code),displayRelayIdentity(code,role),
      displayRelayIdentity(code,role==='dock'?'veto':'dock')]);
    return new ServerDisplayLink(secrets,publisher,other.topic,endpoint,onMessage,onStatus,notBefore);
  }
  constructor(secrets,publisher,topic,endpoint,onMessage,onStatus,notBefore){
    this.secrets=secrets;this.stopped=false;
    this.client=new RelayClient(endpoint,[topic],async(box,_topic,fresh,at)=>{
      const msg=await unseal(secrets.key,box);
      // A retained snapshot can redraw a late source; a stale ACK cannot turn
      // the panel green. The source replies to a retained state with a fresh ACK.
      if(msg&&!this.stopped&&(msg.type!=='veto-received'||fresh)&&
        (msg.type!=='veto-state'||at>=notBefore))return onMessage(msg);
    },{publisher,onStatus});
  }
  async send(message){if(!this.stopped)return this.client.send(await seal(this.secrets.key,message));}
  close(){this.stopped=true;this.client.close();}
}
