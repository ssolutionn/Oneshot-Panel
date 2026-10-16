// Bounded public upstream reads. The deadline still works in runtimes or
// test servers which ignore AbortSignal; late responses are closed.
const timeoutError = () => new Error('долго не отвечает');
function cancel(value) { try { const p=value?.cancel(); p?.catch?.(()=>{}); } catch { /* already closed */ } }
export async function readPublicText(url, fetchImpl, {timeoutMs=18000,maxBytes=16*1024*1024,headers={}}={}) {
  const controller=new AbortController();
  let timer, expired=false, response, reader;
  const release=()=>reader ? cancel(reader) : !response?.body?.locked && cancel(response?.body);
  const task=(async()=>{
    response=await fetchImpl(url,{headers,signal:controller.signal,redirect:'manual'});
    if(expired){release();throw timeoutError();}
    if(!response.ok)throw new Error('HTTP '+response.status);
    if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('слишком большой ответ источника');
    reader=response.body?.getReader();
    if(!reader)return '';
    const decoder=new TextDecoder();let text='',total=0;
    while(true){
      const {value,done}=await reader.read();
      if(expired)throw timeoutError();
      if(done)break;
      total+=value.length;
      if(total>maxBytes)throw new Error('слишком большой ответ источника');
      text+=decoder.decode(value,{stream:true});
    }
    return text+decoder.decode();
  })();
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
    expired=true;controller.abort();reject(timeoutError());release();
  },timeoutMs);});
  try{return await Promise.race([task,deadline]);}
  finally{clearTimeout(timer);controller.abort();release();}
}
export async function openPublicSocket(url,fetchImpl,timeoutMs=18000,headers={}) {
  const controller=new AbortController();let timer,expired=false,returned=false;
  const task=(async()=>{
    const response=await fetchImpl(url,{
      headers:{...headers,Upgrade:'websocket'},signal:controller.signal,redirect:'manual'
    });
    if(expired){try{response.webSocket?.close();}catch{}cancel(response.body);throw timeoutError();}
    if(response.status!==101||!response.webSocket){
      cancel(response.body);throw new Error('HTTP '+response.status+' — публичный поток недоступен');
    }
    return response.webSocket;
  })();
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
    expired=true;controller.abort();reject(timeoutError());
  },timeoutMs);});
  try{const socket=await Promise.race([task,deadline]);returned=true;return socket;}
  finally{clearTimeout(timer);if(!returned)controller.abort();}
}
