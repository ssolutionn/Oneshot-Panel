import { ServerDisplayLink } from '../veto-relay-links.js';
import { relayEndpoint } from '../veto-relay-protocol.js';
import { snapshot, demoState, nextDemoMap } from './model.js';
import { appendVeto } from '../../core.js';
import { artwork, VetoScene } from './scene.js';
import { VETO_EVENT } from '../../obs.js';
import { VdoLink, bridgeSecrets, normalizeCode, VDO_CONNECT_TIMEOUT, VDO_IDLE_TIMEOUT } from '../../vdo.js';

const $=id=>document.getElementById(id),params=new URLSearchParams(location.search);
const preview=params.get('preview')==='1';
const cropped=params.get('crop')==='1';
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
let format=['BO1','BO2','BO3','BO5'].includes(params.get('format'))?params.get('format'):'BO3';
let layout=params.get('layout')==='strip'?'strip':'full';
let count=Number(params.get('step') ?? 2);
if(!Number.isInteger(count)||count<0||count>6)count=2;
let current=preview?demoState(format,count):null,scene,playing=false,timer,boot=0;
let displayLink=null,displayWatchdog=null,displayOpening=false;
let motion=params.get('motion')!=='off'&&!reduced.matches;
document.body.dataset.preview=String(preview);
$('previewBar').hidden=!preview;
$('format').value=format;$('layout').value=layout;$('motion').checked=motion;

function stop() {playing=false;clearTimeout(timer);$('play').textContent='Проиграть вето';}
function update() {
  const finished=current?.actions.length===6;
  $('download').disabled=!finished;$('next').disabled=!!finished;
  $('previous').disabled=!current?.actions.length&&!current?.pending;
  $('finish').disabled=!!finished&&!current?.pending;
  $('previewStatus').textContent=scene?.description()||'Загрузка оформления…';
  $('sceneStatus').textContent=scene?.description()||'Загрузка оформления…';
}
// One load per pair of teams: the panel resends the same state every 2.5 s,
// and a resend must wait for the load already running, not restart it.
const artworkLoads=new Map();
function teamArtwork(teams) {
  const key=JSON.stringify(teams);
  if(!artworkLoads.has(key)) {
    if(artworkLoads.size>8)artworkLoads.clear();
    artworkLoads.set(key,artwork(teams).catch(error=>{artworkLoads.delete(key);throw error;}));
  }
  return artworkLoads.get(key);
}
// Resolves with the drawn snapshot, or null when a newer state replaced this
// one before it was drawn (then it must not be confirmed to the panel).
async function apply(value,{animate=true}={}) {
  const next=snapshot(value);
  if(!scene)throw new Error('Оформление ещё загружается.');
  const token=++boot;
  if(JSON.stringify(current?.teams)!==JSON.stringify(next.teams)) {
    const assets=await teamArtwork(next.teams);
    if(token!==boot)return null;
    // Only team changes need an asset refresh; rendering remains atomic.
    for(const [key,img] of assets)scene.assets.set(key,img);
  }
  current=next;format=next.format;count=next.actions.length;
  scene.setState(next,{animate});update();
  return snapshot(current);
}
function demoAt(step) {return apply(demoState(format,step));}
async function next() {
  if(current.actions.length===6)return;
  const map=nextDemoMap(current);
  const state={...current,actions:appendVeto(current.actions,current.format,current.first,map,
    current.actions.length%2?'T':'CT'),pending:null};
  await apply(state);
}
async function tick() {
  if(!playing)return;
  if(current.actions.length===6){stop();return;}
  if(!current.pending && ['BO2','BO3','BO5'].includes(current.format)) {
    const state=demoState(current.format,current.actions.length+1);
    const action=state.actions.at(-1);
    if(action.type==='pick') {
      await apply({...current,pending:action.map});
      timer=setTimeout(async()=>{if(!playing)return;await next();timer=setTimeout(tick,3200);},1900);
      return;
    }
  }
  await next();timer=setTimeout(tick,3200);
}
async function download() {
  if(!scene?.model?.finished)return;
  const blob=await scene.png(),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`CyberClash_veto_${current.format}_${layout}.png`;
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function action(fn) {
  return async()=>{try{await fn();}catch(error){stop();$('previewStatus').textContent=error.message;}};
}
$('play').addEventListener('click',action(async()=>{
  if(playing){stop();return;}
  if(current.actions.length===6)await demoAt(0);
  playing=true;$('play').textContent='Пауза';timer=setTimeout(tick,350);
}));
$('restart').addEventListener('click',action(()=>{stop();return demoAt(0);}));
$('previous').addEventListener('click',action(()=>{
  stop();
  return current.pending?apply({...current,pending:null}):demoAt(Math.max(0,current.actions.length-1));
}));
$('next').addEventListener('click',action(()=>{stop();return next();}));
$('finish').addEventListener('click',action(()=>{stop();return demoAt(6);}));
$('format').addEventListener('change',action(()=>{
  stop();format=$('format').value;return demoAt(0);
}));
$('layout').addEventListener('change',()=>{
  layout=$('layout').value;scene?.setLayout(layout);
  const url=new URL(location.href);url.searchParams.set('layout',layout);history.replaceState(null,'',url);
});
$('motion').addEventListener('change',()=>{motion=$('motion').checked;scene?.setMotion(motion);});
$('download').addEventListener('click',action(download));

async function init() {
  const [assets]=await Promise.all([
    artwork(current?.teams||[]),
    document.fonts.load('700 48px "Oneshot Display"','CYBERCLASH КАРТЫ РЕШАЮТ').catch(()=>[])
  ]);
  scene=new VetoScene($('scene'),assets,{layout,motion,cropped,animations:params.get('animations')!=='off'&&!reduced.matches});
  if(current)scene.setState(current,{animate:false});else scene.start();
  // Renderer contract for the future shared-state transport. This interface
  // itself does not synchronize browsers or publish to other computers.
  window.vetoOverlay={
    setState:(state,options)=>apply(state,options),
    getState:()=>current?snapshot(current):null,
    setLayout:value=>{layout=value==='strip'?'strip':'full';scene.setLayout(layout);},
    png:()=>scene.png(),
    stopMotion:()=>{motion=false;$('motion').checked=false;scene.setMotion(false);},
    description:()=>scene.description()
  };
  window.addEventListener('pagehide',()=>{stop();scene.dispose();clearInterval(displayWatchdog);displayLink?.close();},{once:true});
  // Initial snapshot and display-only live channel from the copied OBS URL.
  // Native events remain accepted for compatibility, but do not prove delivery.
  if(!preview) {
    const initial=fromHash();
    if(initial)await apply(initial,{animate:false}).catch(()=>{});
    window.addEventListener(VETO_EVENT,event=>apply(event.detail).catch(()=>{}));
    window.addEventListener('hashchange',()=>{const state=fromHash();if(state)apply(state).catch(()=>{});});
    const code=normalizeCode(new URLSearchParams(location.hash.slice(1)).get('r'));
    if(code) {
      const secrets=await bridgeSecrets(code);
      let receivedAt=Date.now(),hasReceived=false;
      const receive=async message=>{
        if(message.type!=='veto-state'||typeof message.id!=='string')return;
        receivedAt=Date.now();
        hasReceived=true;
        try {
          // Confirm only what is actually on screen.
          if(await apply(message.state))await displayLink?.send({type:'veto-received',id:message.id});
        } catch { /* A malformed update must not replace the on-air state. */ }
      };
      const endpoint=new URLSearchParams(location.hash.slice(1)).get('relay');
      displayLink=endpoint ? await ServerDisplayLink.create(code,'veto',relayEndpoint(endpoint),receive,undefined,Number(new URLSearchParams(location.hash.slice(1)).get('at'))||0) : new VdoLink(secrets,'veto',receive);
      if(!endpoint)displayWatchdog=setInterval(async()=>{
        if(document.hidden||displayOpening||Date.now()-receivedAt<
          (hasReceived?VDO_IDLE_TIMEOUT:VDO_CONNECT_TIMEOUT))return;
        displayOpening=true;
        try {
          displayLink?.close();
          displayLink=new VdoLink(secrets,'veto',receive);
          receivedAt=Date.now();
          hasReceived=false;
        } catch { /* the next watchdog tick retries */ }
        finally {displayOpening=false;}
      },5000);
    }
  }
  update();document.body.dataset.ready='true';
}
function fromHash() {
  const packed=new URLSearchParams(location.hash.slice(1)).get('s');
  if(!packed)return null;
  try {
    const text=atob(packed.replace(/-/g,'+').replace(/_/g,'/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(text,c=>c.charCodeAt(0))));
  } catch {return null;}
}
init().catch(error=>{
  $('sceneStatus').textContent='Не удалось загрузить оформление.';
  $('previewStatus').textContent=error.message;
  const c=$('scene').getContext('2d');
  c.fillStyle='#061923';c.fillRect(0,0,1920,1080);c.fillStyle='#eefaff';
  c.font='bold 42px Arial';c.fillText('Не удалось загрузить оформление',160,550);
});
