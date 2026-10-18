import {mkdir,readFile,writeFile,rename,unlink,readdir} from 'node:fs/promises';
import path from 'node:path';
import {topicValid} from '../assets/veto-relay-protocol.js';
export class FileRelayStore {
 constructor(directory,valid=topicValid){this.directory=path.resolve(directory);this.queues=new Map();this.valid=valid;}
 file(topic){if(!this.valid(topic))throw Error('topic');return path.join(this.directory,topic+'.json');}
 async read(topic){
  try{return JSON.parse(await readFile(this.file(topic),'utf8'));}
  catch(e){if(e.code==='ENOENT')return null;throw Error('storage');}
 }
 async update(topic,change){
  const previous=this.queues.get(topic)||Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{
   const old=await this.read(topic),value=change(old);
   if(value===old)return value;
   if(value===null){await unlink(this.file(topic)).catch(e=>{if(e.code!=='ENOENT')throw e;});return null;}
   await mkdir(this.directory,{recursive:true,mode:0o700});
   const target=this.file(topic),temporary=target+'.'+crypto.randomUUID()+'.tmp';
   try{await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,target);}
   finally{await unlink(temporary).catch(()=>{});}
   return value;
  });
  this.queues.set(topic,next);
  try{return await next;}finally{if(this.queues.get(topic)===next)this.queues.delete(topic);}
 }
 async prune(now=Date.now()){
  let names;try{names=await readdir(this.directory);}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const name of names){
   const topic=name.replace(/\.json$/,'');if(name!==topic+'.json'||!this.valid(topic))continue;
   await this.update(topic,row=>row&&row.expiresAt<=now?null:row);
  }
 }
}
