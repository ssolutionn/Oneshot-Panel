// Portable Node >=22 relay. Put HTTPS nginx/Caddy in front of this loopback port.
import http from 'node:http';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {handleRelay,reply} from './veto-relay-api.js';
import {FileRelayStore} from './veto-relay-file.js';
export async function nodeRelay(request,response,store) {
 if(request.url!=='/api/veto-relay'&&!request.url.startsWith('/api/veto-relay?'))return false;
 try{
  const controller=new AbortController();
  request.on('aborted',()=>controller.abort());
  const input=new Request('http://localhost'+request.url,{
   method:request.method,headers:request.headers,signal:controller.signal,
   ...(['GET','HEAD'].includes(request.method)?{}:{body:Readable.toWeb(request),duplex:'half'})});
  const output=await handleRelay(input,store);
  response.writeHead(output.status,Object.fromEntries(output.headers));
  response.end(Buffer.from(await output.arrayBuffer()));
 }catch{
  if(!response.headersSent){const out=reply({error:'request'},400);response.writeHead(out.status,Object.fromEntries(out.headers));}
  response.end();
 }
 return true;
}
export function relayServer(store){
 return http.createServer(async(req,res)=>{
  if(await nodeRelay(req,res,store))return;
  res.writeHead(404,{'content-type':'text/plain','x-content-type-options':'nosniff'});res.end('Not found');
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const store=new FileRelayStore(process.env.VETO_RELAY_DIR||'.veto-relay-data');
 const server=relayServer(store);
 server.requestTimeout=15000;server.headersTimeout=10000;
 const cleanup=setInterval(()=>store.prune().catch(()=>{}),3600000);cleanup.unref();
 server.listen(Number(process.env.PORT||3101),process.env.HOST||'127.0.0.1',
  ()=>console.log('Veto relay ready (HTTP; HTTPS terminates at your proxy)'));
}
