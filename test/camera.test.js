import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildObs,cameraGeometry,cameraFrame,cameraViewUrl,cameraCss,normalizeCamera} from '../core.js';
import {slotPlan} from '../obs.js';

const template=JSON.parse(fs.readFileSync(new URL('../assets/obs-template.json',import.meta.url),'utf8'));
const team=(name)=>({name,players:Array.from({length:5},(_,i)=>({
  key:name+i,nick:'Player'+i,id:name+i,room:name,role:'Основной'
}))});

test('camera rotation keeps all four corners exactly inside the chosen frame',()=>{
  const expected=[
    {rotation:0,x:300,y:36,width:1320,height:1008},
    {rotation:90,x:1620,y:36,width:1008,height:1320},
    {rotation:180,x:1620,y:1044,width:1320,height:1008},
    {rotation:270,x:300,y:1044,width:1008,height:1320}
  ];
  for(const geometry of expected){
    const actual=cameraGeometry({camera:{rotation:geometry.rotation}});
    assert.deepEqual(actual,geometry);
    const radians=actual.rotation*Math.PI/180;
    const points=[[0,0],[actual.width,0],[0,actual.height],[actual.width,actual.height]]
      .map(([x,y])=>[actual.x+x*Math.cos(radians)-y*Math.sin(radians),
        actual.y+x*Math.sin(radians)+y*Math.cos(radians)]);
    assert.ok(Math.abs(Math.min(...points.map(p=>p[0]))-300)<1e-8);
    assert.ok(Math.abs(Math.max(...points.map(p=>p[0]))-1620)<1e-8);
    assert.ok(Math.abs(Math.min(...points.map(p=>p[1]))-36)<1e-8);
    assert.ok(Math.abs(Math.max(...points.map(p=>p[1]))-1044)<1e-8);
  }
  assert.deepEqual(cameraFrame('full43'),{x:240,y:0,width:1440,height:1080});
  assert.deepEqual(cameraFrame('wide'),{x:0,y:0,width:1920,height:1080});
  assert.deepEqual(cameraFrame('square'),{x:420,y:0,width:1080,height:1080});
  const a=team('Square A'),b=team('Square B');
  for (const rotation of [0, 90, 180, 270]) {
    const player={...a.players[0],camera:{rotation}};
    a.players[0].camera=player.camera;
    const x = rotation === 90 || rotation === 180 ? 1500 : 420;
    const y = rotation === 180 || rotation === 270 ? 1080 : 0;
    const square=cameraGeometry(player,'square');
    assert.deepEqual(square,{rotation,x,y,width:1080,height:1080});
    const document=buildObs(template,a,b,a.players.map(p=>p.key),b.players.map(p=>p.key),undefined,{cameraFrame:'square'});
    const scene=document.sources.find(s=>s.name==='Игрок 1');
    const item=scene.settings.items.find(it=>it.name.startsWith('CAM '));
    const plan=slotPlan([{inputKind:'browser_source',sourceName:'CAM old',sceneItemId:1}],
      {...player,team:a.name,slot:1},{cameraFrame:'square'});
    assert.deepEqual(item.pos,{x,y});
    assert.deepEqual(item.bounds,{x:1080,y:1080});
    assert.deepEqual([plan.camera.transform.positionX,plan.camera.transform.positionY], [x,y]);
    assert.deepEqual([plan.camera.transform.boundsWidth,plan.camera.transform.boundsHeight], [1080,1080]);
  }
});

test('a frame with 20 px to spare puts the camera 20 px past the frame on every side, in the JSON and through OBS',()=>{
  const a=team('Pad A'),b=team('Pad B');
  for (const [frame,base] of [['square_over20','square'],['inner43_over20','inner43'],['wide_over20','wide'],['full43_over20','full43']]) {
    const inner=cameraFrame(base),rect=cameraFrame(frame);
    assert.deepEqual(rect,{x:inner.x-20,y:inner.y-20,width:inner.width+40,height:inner.height+40});
    const document=buildObs(template,a,b,a.players.map(p=>p.key),b.players.map(p=>p.key),undefined,{cameraFrame:frame});
    const item=document.sources.find(s=>s.name==='Игрок 1').settings.items.find(it=>it.name.startsWith('CAM '));
    const plan=slotPlan([{inputKind:'browser_source',sourceName:'CAM old',sceneItemId:1}],{...a.players[0],team:a.name,slot:1},{cameraFrame:frame});
    assert.deepEqual([item.pos,item.bounds],[{x:rect.x,y:rect.y},{x:rect.width,y:rect.height}]);
    assert.deepEqual([plan.camera.transform.positionX,plan.camera.transform.positionY,plan.camera.transform.boundsWidth,plan.camera.transform.boundsHeight],
      [rect.x,rect.y,rect.width,rect.height]);
  }
});

test('cover and pan use VDO options with numeric CSS, and screen directions survive rotation',()=>{
  const player={id:'player',room:'team',password:'secret'};
  const url=new URL(cameraViewUrl({...player,camera:{rotation:90,panX:20,panY:70}}));
  assert.equal(url.searchParams.get('view'),'player');
  assert.equal(url.searchParams.get('password'),'secret');
  assert.ok(url.searchParams.has('cover') && url.searchParams.has('transparent'));
  assert.equal(atob(url.searchParams.get('b64css')),
    'html,body{background:transparent!important;}video{object-fit:cover!important;object-position:70% 80%!important;scale:1!important;transform-origin:70% 80%!important;}');
  assert.match(cameraCss({rotation:270,panX:20,panY:70}),/30% 20%/);
  assert.match(cameraCss({rotation:180,panX:20,panY:70}),/80% 30%/);
  assert.deepEqual(normalizeCamera({rotation:'90;bad',panX:Infinity,panY:'0;bad'}),
    {rotation:0,panX:50,panY:50,zoom:1});
  assert.deepEqual(normalizeCamera({rotation:90,panX:-50,panY:400}),
    {rotation:90,panX:0,panY:100,zoom:1});
  assert.deepEqual(cameraFrame('__proto__'),{x:300,y:36,width:1320,height:1008});
  assert.deepEqual(cameraFrame({toString:null}),{x:300,y:36,width:1320,height:1008});
});

test('zoom is bounded, remains per player, and reaches preview/export/live URLs',()=>{
  assert.equal(normalizeCamera({zoom:Infinity}).zoom,1);
  assert.equal(normalizeCamera({zoom:-4}).zoom,1);
  assert.equal(normalizeCamera({zoom:9}).zoom,3);
  assert.equal(normalizeCamera({zoom:1.254}).zoom,1.25);
  const url=new URL(cameraViewUrl({id:'p',room:'r',camera:{zoom:1.5,panX:100}}));
  const css=atob(url.searchParams.get('b64css'));
  assert.equal(url.searchParams.has('darkmode'),false,'OBS keeps its existing transparent output');
  assert.match(css,/html,body\{background:transparent!important/);
  assert.match(css,/scale:1.5!important/);
  assert.match(css,/transform-origin:100% 50%/);
  assert.deepEqual(cameraGeometry({camera:{zoom:3}}),{rotation:0,x:300,y:36,width:1320,height:1008});
});

test('an older panel keeps the previous full-frame and contain behavior through an updated dock',()=>{
  const plan=slotPlan([{inputKind:'browser_source',sourceName:'CAM old',sceneItemId:1}],
    {slot:1,team:'A',nick:'Player',id:'camera',room:'room',camera:{rotation:90}},
    {legacyCamera:true});
  assert.equal(plan.camera.settings.width,1920);
  assert.equal(plan.camera.settings.height,1080);
  assert.equal(plan.camera.transform.rotation,0);
  assert.equal(plan.camera.transform.positionX,0);
  assert.equal(new URL(plan.camera.settings.url).searchParams.has('cover'),false);
});

test('JSON export and live OBS apply share camera settings and geometry; cards stay upright',()=>{
  for(const frame of ['inner43','full43','wide','square']){
    for(const rotation of [0,90,180,270]){
      const a=team('A'),b=team('B');
      a.players[0].camera={rotation,panX:20,panY:70};
      const document=buildObs(template,a,b,a.players.map(p=>p.key),b.players.map(p=>p.key),
        undefined,{includeCards:true,cameraFrame:frame});
      const scene=document.sources.find(s=>s.name==='Игрок 1');
      const camera=scene.settings.items.find(it=>it.name.startsWith('CAM '));
      const card=scene.settings.items.find(it=>it.name.startsWith('CARD '));
      const source=document.sources.find(s=>s.uuid===camera.source_uuid);
      const plan=slotPlan([{inputKind:'browser_source',sourceName:'CAM old',sceneItemId:1}],
        {...a.players[0],team:'A',slot:1},{includeCards:true,cameraFrame:frame});
      assert.deepEqual(source.settings.url,plan.camera.settings.url);
      assert.equal(source.settings.width,plan.camera.settings.width);
      assert.equal(source.settings.height,plan.camera.settings.height);
      assert.equal(camera.rot,plan.camera.transform.rotation);
      assert.deepEqual(camera.pos,{x:plan.camera.transform.positionX,y:plan.camera.transform.positionY});
      assert.deepEqual(camera.bounds,{x:plan.camera.transform.boundsWidth,y:plan.camera.transform.boundsHeight});
      assert.equal(card.rot,0);
      const rect=cameraFrame(frame);
      assert.deepEqual(card.pos,{x:rect.x,y:rect.y});
      assert.deepEqual(card.bounds,{x:rect.width,y:rect.height});
      assert.equal(source.settings.url.includes('cover'),true);
    }
  }
});

test('a ready card page (a LAN card, a placeholder) is the frame\'s size, so it fills the frame; the site card stays 1920×1080',async()=>{
  const {cardKey,BLANK_CARD}=await import('../core.js');
  const a=team('Plate A'),b=team('Plate B');
  const docs=Object.fromEntries(b.players.map(p=>[cardKey(b.name,p.nick),BLANK_CARD]));
  const document=buildObs(template,a,b,a.players.map(p=>p.key),b.players.map(p=>p.key),undefined,{includeCards:true,cameraFrame:'square_over20',cardDocs:docs});
  const card=n=>document.sources.find(s=>s.name.startsWith(`CARD ${String(n).padStart(2,'0')} `)).settings;
  assert.deepEqual([card(6).url,card(6).width,card(6).height],[BLANK_CARD,1120,1120]);
  assert.deepEqual([card(1).width,card(1).height],[1920,1080]);
  assert.match(card(1).url,/^https:/);
  const plan=slotPlan([{inputKind:'browser_source',sourceName:'CAM old',sceneItemId:1}],{...b.players[0],team:b.name,slot:6},{includeCards:true,cameraFrame:'square_over20',cardDocs:docs});
  assert.deepEqual([plan.card.settings.url,plan.card.settings.width,plan.card.settings.height],[BLANK_CARD,1120,1120]);
});
