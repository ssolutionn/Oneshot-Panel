// System notifications for an open panel. The worker handles display/clicks;
// it does not cache pages, poll FACEIT or subscribe the device to Web Push.
let workerPromise;
const permission = () => typeof Notification==='undefined' ? 'unsupported' : Notification.permission;
const sectionOf = value => value==='veto' ? 'veto' : 'lobby';

const activeTitles = new Map();
let baseTitle = typeof document !== 'undefined' ? document.title : 'Oneshot Panel';
let titleTimer = null;
let titleOn = false;

export function setFlashingTitle(key, text) {
  if (typeof document === 'undefined') return;
  if (!text) activeTitles.delete(key);
  else activeTitles.set(key, text);
  if (activeTitles.size && !titleTimer) {
    titleTimer = setInterval(() => {
      if (!activeTitles.size) {
        clearInterval(titleTimer);
        titleTimer = null;
        document.title = baseTitle;
        return;
      }
      titleOn = !titleOn;
      // When several alarms ring at once (a map ended and a captain calls),
      // the tab shows them in turn instead of overwriting each other.
      const texts = [...activeTitles.values()];
      const current = texts[Math.floor(Date.now() / 1000) % texts.length];
      document.title = titleOn ? current : baseTitle;
    }, 1000);
  } else if (!activeTitles.size && titleTimer) {
    clearInterval(titleTimer);
    titleTimer = null;
    document.title = baseTitle;
  }
}
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

