import { snapshot, demoState, nextDemoMap } from './model.js';
import { appendVeto } from '../../core.js';
import { artwork, VetoScene } from './scene.js';

const $=id=>document.getElementById(id),params=new URLSearchParams(location.search);
const preview=params.get('preview')==='1';
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
let format=['BO1','BO2','BO3','BO5'].includes(params.get('format'))?params.get('format'):'BO3';
let layout=params.get('layout')==='strip'?'strip':'full';
let count=Number(params.get('step') ?? 2);
if(!Number.isInteger(count)||count<0||count>6)count=2;
let current=preview?demoState(format,count):null,scene,playing=false,timer,boot=0;
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
async function apply(value,{animate=true}={}) {
  const next=snapshot(value);
  if(!scene)throw new Error('Оформление ещё загружается.');
  const token=++boot;
  if(JSON.stringify(current?.teams)!==JSON.stringify(next.teams)) {
    const assets=await artwork(next.teams);
    if(token!==boot)return;
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
  const assets=await artwork(current?.teams||[]);
  scene=new VetoScene($('scene'),assets,{layout,motion,animations:params.get('animations')!=='off'&&!reduced.matches});
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
  window.addEventListener('pagehide',()=>{stop();scene.dispose();},{once:true});
  update();document.body.dataset.ready='true';
}
init().catch(error=>{
  $('sceneStatus').textContent='Не удалось загрузить оформление.';
  $('previewStatus').textContent=error.message;
  const c=$('scene').getContext('2d');
  c.fillStyle='#061923';c.fillRect(0,0,1920,1080);c.fillStyle='#eefaff';
  c.font='bold 42px Arial';c.fillText('Не удалось загрузить оформление',160,550);
});
