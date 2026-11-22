// System notifications for an open panel. The worker handles display/clicks;
// it does not cache pages, poll FACEIT or subscribe the device to Web Push.
let workerPromise;
const permission = () => typeof Notification==='undefined' ? 'unsupported' : Notification.permission;
const sectionOf = value => ['veto','qualifications'].includes(value) ? value : 'lobby';
async function bounded(task) {
  let timer;
  try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Notification API timeout')),8000);})]);}
  finally{clearTimeout(timer);}
}

async function notificationWorker() {
  if(!navigator.serviceWorker)throw new Error('Service worker unavailable');
  if(!workerPromise)workerPromise=(async()=>{
    const registration=await bounded(navigator.serviceWorker.register('/notification-worker.js',{updateViaCache:'none'}));
    if(registration.active?.state==='activated')return registration;
    // Registration can resolve before an installing worker is exposed.
    // The browser's ready promise waits for the active worker in our scope.
    return await bounded(navigator.serviceWorker.ready);
  })().catch(error=>{workerPromise=null;throw error;});
  return workerPromise;
}

// The alert sound, shared by the lobby and the qualifications desk. It has to
// be created after a user gesture, otherwise the browser blocks it.
let audio = null;
export function unlockAudio() {
  try {
    audio ||= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
  } catch { audio = null; }
}
export function beep() {
  if (!audio) return;
  const now = audio.currentTime;
  [[880, 0], [660, 0.22], [880, 0.44]].forEach(([freq, at]) => {
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.35, now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.2);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.21);
  });
}

export const notificationPermission = permission;
export async function enableNotifications() {
  if(permission()==='unsupported')return 'unsupported';
  if(permission()==='default')await Notification.requestPermission();
  return permission();
}
export async function showNotification(title,body,{tag='oneshot',section='lobby',requireInteraction=true}={}) {
  if(permission()!=='granted')return false;
  section=sectionOf(section);
  const options={body,tag,requireInteraction,icon:'/assets/favicon.png',data:{section}};
  try {
    const worker=await notificationWorker();
    await bounded(worker.showNotification(title,options));
    return true;
  } catch { /* Desktop browsers can still use their direct API. */ }
  try {
    const note=new Notification(title,options);
    note.onclick=()=>{window.focus();window.dispatchEvent(new CustomEvent('oneshot:notification-open',{detail:section}));note.close();};
    return true;
  } catch {return false;}
}
if(navigator.serviceWorker)navigator.serviceWorker.addEventListener('message',event=>{
  if(event.data?.type==='oneshot-notification-open')window.dispatchEvent(
    new CustomEvent('oneshot:notification-open',{detail:sectionOf(event.data.section)}));
});

