import { MAP_POOL, viewModel } from './model.js';
import { makeSmoke } from './smoke.js';

const C = {
  ink:'#f3fbff', muted:'#9ab8c4', faint:'#577582', accent:'#03dcf3',
  deep:'#05131d', panel:'#0a1c27', ban:'#ff6571', gold:'#e5edf1'
};
const W=1920,H=1080;
const clamp=value=>Math.max(0,Math.min(1,value));
const ease=value=>{const p=clamp(value);return p*p*(3-2*p);};
const visual=map=>({
  ban:map.status==='ban'?1:0,
  accent:['pick','pending'].includes(map.status)?1:0,
  white:map.status==='leftover'?1:0
});
const sameMap=(a,b)=>['name','status','side','team','step','sideTeam','ownSide'].every(key=>a?.[key]===b?.[key]);
const mix=(a,b,p)=>Object.fromEntries(Object.keys(b).map(key=>[key,a[key]+(b[key]-a[key])*p]));
function tint(a,b,p) {
  const rgb=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
  const x=rgb(a),y=rgb(b);
  return '#'+x.map((n,i)=>Math.round(n+(y[i]-n)*clamp(p)).toString(16).padStart(2,'0')).join('');
}
function image(url) {
  return new Promise(resolve => {
    const img=new Image();
    let settled=false;
    const done=value=>{if(settled)return;settled=true;clearTimeout(timer);img.onload=null;img.onerror=null;resolve(value);};
    const timer=setTimeout(()=>done(null),4500);
    img.onload=()=>done(img.naturalWidth ? img : null);
    img.onerror=()=>done(null);img.src=url;
  });
}
async function logos() {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4500);
  try {
    const response=await fetch('/assets/teams/teams.json',{signal:controller.signal});
    return response.ok ? await response.json() : {};
  } catch {return {};} finally {clearTimeout(timer);}
}

export async function artwork(teams) {
  const manifest=await logos();
  const list=[
    ['/background','/assets/card/background.jpg'],
    ['/event','/assets/card/cyberclash-logo.png'],
    ...MAP_POOL.map(map=>[map,`/assets/maps/${map}.jpg`]),
    ...teams.map(team=>{
      const file=Object.entries(manifest).find(([name])=>name.toLowerCase()===team.toLowerCase())?.[1];
      return [team,typeof file==='string' && /^[\w.-]+\.png$/i.test(file) ? `/assets/teams/${file}` : null];
    })
  ];
  const result=await Promise.all(list.map(async ([key,path])=>[key,path ? await image(path) : null]));
  return new Map(result);
}

export class VetoScene {
  constructor(canvas,assets,{layout='full',motion=true,animations=true,cropped=false}={}) {
    this.canvas=canvas;this.ctx=canvas.getContext('2d',{alpha:true});
    this.assets=assets;this.layout=layout;this.cropped=!!cropped;this.resize();this.motion=motion;this.animations=animations;this.changed=new Map();
    this.smoke=makeSmoke(assets.get('/background'));this.raf=0;this.lastFrame=0;
    this.frozenTime=12;this.started=performance.now();this.model=null;
    this.paint=this.paint.bind(this);
  }
  setState(value,{animate=true}={}) {
    const next=viewModel(value),now=performance.now();
    const sameMatch=this.model && JSON.stringify([this.model.teams,this.model.format,this.model.first])===
      JSON.stringify([next.teams,next.format,next.first]);
    if(!animate || !this.animations || !sameMatch)this.changed.clear();
    else {
      next.slots.forEach(map=>{
        const old=this.model.slots.find(old=>old.id===map.id);
        if(sameMap(old,map))return; // Polling identical state must not restart or cancel an animation.
        const previous=this.changed.get(map.id);
        const from=previous?this.cardVisual(old,now).value:visual(old);
        this.changed.set(map.id,{
          name:map.name||old.name,started:now,duration:map.status==='available'?650:900,
          from,to:visual(map),old:{...old}
        });
      });
    }
    this.model=next;
    this.canvas.dataset.phase=next.finished ? 'finished' : next.pending ? 'side' : 'veto';
    this.canvas.setAttribute('aria-label',this.description());
    this.start();
  }
  cardVisual(map,now) {
    const change=this.changed.get(map.id);
    if(!change)return {value:visual(map),p:1,change:null};
    const p=clamp((now-change.started)/change.duration);
    return {value:mix(change.from,change.to,ease(p)),p,change};
  }
  setAnimations(enabled) {
    this.animations=!!enabled;
    if(!this.animations)this.changed.clear();
    this.start();
  }
  description() {
    const m=this.model;
    return m ? `${m.teams.join(' против ')}. ${m.format}. ${m.finished ? 'Вето завершено. '+m.series.join(', ') :
      m.pending ? 'Выбор стороны на '+m.pending+': '+m.teams[1-m.nextTeam] : 'Ход '+(m.actions.length+1)+': '+m.teams[m.nextTeam]+', '+m.nextType}.` : 'Ожидание вето.';
  }
  resize() {
    const crop=this.cropped&&this.layout==='strip';
    this.canvas.width=W;this.canvas.height=crop?400:H;
    this.canvas.dataset.cropped=String(crop);
  }
  setLayout(layout) {this.layout=layout==='strip'?'strip':'full';this.resize();this.start();}
  setMotion(enabled) {
    if(!enabled) this.frozenTime=(performance.now()-this.started)/1000+12;
    else this.started=performance.now()-(this.frozenTime-12)*1000;
    this.motion=!!enabled;this.start();
  }
  start() {if(!this.raf)this.raf=requestAnimationFrame(this.paint);}
  paint(now) {
    this.raf=0;
    if(now-this.lastFrame<32) {this.start();return;}
    this.lastFrame=now;this.draw(now);
    for(const [name,change] of this.changed) {
      if(now-change.started>=change.duration)this.changed.delete(name);
    }
    if(this.motion || this.changed.size) this.start();
  }
  dispose() {cancelAnimationFrame(this.raf);this.smoke?.dispose();}
  text(value,x,y,size=24,color=C.ink,{weight=700,max=Infinity,align='left',alpha=1}={}) {
    const c=this.ctx;c.save();c.globalAlpha=alpha;c.fillStyle=color;
    const display=size>=22||weight>=850,stretch=display?.86:1;
    c.font=`${display?Math.min(weight,700):weight} ${size}px ${display?'"Oneshot Display", Arial, sans-serif':'Arial, sans-serif'}`;
    c.textBaseline='alphabetic';c.textAlign=align;
    const width=c.measureText(String(value)).width*stretch,scale=Math.min(1,max/Math.max(1,width));
    c.translate(x,y);c.scale(scale*stretch,1);c.fillText(String(value),0,0);c.restore();
  }
  rect(x,y,w,h,color,radius=0) {
    const c=this.ctx;c.fillStyle=color;c.beginPath();
    if(radius)c.roundRect(x,y,w,h,radius);else c.rect(x,y,w,h);
    c.fill();
  }
  line(x1,y1,x2,y2,color,width=1) {
    const c=this.ctx;c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.stroke();
  }
  cover(img,x,y,w,h,zoom=1) {
    if(!img)return;
    const scale=Math.max(w/img.width,h/img.height)*zoom,sw=w/scale,sh=h/scale;
    this.ctx.drawImage(img,(img.width-sw)/2,(img.height-sh)/2,sw,sh,x,y,w,h);
  }
  logo(key,x,y,w,h) {
    const img=this.assets.get(key);
    if(!img)return;
    const scale=Math.min(w/img.width,h/img.height),dw=img.width*scale,dh=img.height*scale;
    this.ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);
  }
  background(seconds,strip) {
    const c=this.ctx,y=strip?680:0;
    c.save();c.beginPath();c.rect(0,y,W,H-y);c.clip();
    this.rect(0,y,W,H-y,C.deep);
    const dynamic=this.smoke?.draw(seconds),background=this.assets.get('/background');
    if(dynamic)c.drawImage(dynamic,0,0,W,H);
    else if(background)this.cover(background,0,0,W,H);
    const shade=c.createLinearGradient(0,y,0,H);
    shade.addColorStop(0,strip?'#03131bf2':'#03131b70');
    shade.addColorStop(.5,strip?'#03131bba':'#03131b50');
    shade.addColorStop(1,'#03131be8');
    this.rect(0,y,W,H-y,shade);
    if(strip)this.rect(0,y,W,3,C.accent);
    else {
      this.rect(0,0,9,H,C.accent);
      const glow=c.createLinearGradient(0,0,W,0);
      glow.addColorStop(0,'#00d9ef60');glow.addColorStop(.45,'#00d9ef00');glow.addColorStop(1,'#00d9ef30');
      this.rect(0,0,W,5,glow);
    }
    c.restore();
  }
  tag(value,x,y,w,color=C.accent) {
    this.rect(x,y,w,40,color,2);
    this.text(value,x+w/2,y+28,22,C.deep,{align:'center',max:w-18});
  }
  fullHeader(m) {
    this.logo('/event',80,58,178,96);
    this.text('CYBERCLASH',295,103,25,C.ink,{weight:900});
    this.text('COUNTER-STRIKE 2',296,132,16,C.muted,{weight:400});
    this.text(m.stage.toUpperCase(),1625,113,20,C.ink,{align:'right',max:580});
    this.tag(m.format,1660,84,180);
    this.line(80,183,1840,183,'#b3e5ed42');
    this.text('MAP VETO',77,290,108,C.ink,{weight:900,max:530});
    this.text('КАРТЫ РЕШАЮТ. КОМАНДЫ ВЫБИРАЮТ.',83,329,16,C.muted,{weight:700,max:520});
    this.logo(m.teams[0],655,233,75,75);
    this.text(m.teams[0].toUpperCase(),750,278,37,C.ink,{weight:900,max:335});
    this.text('VS',1147,277,22,C.muted,{align:'center'});
    this.logo(m.teams[1],1205,233,75,75);
    this.text(m.teams[1].toUpperCase(),1300,278,37,C.ink,{weight:900,max:535});
    this.text('TEAM 01',751,308,13,C.muted);
    this.text('TEAM 02',1301,308,13,C.muted);
  }
  stripHeader(m) {
    this.logo('/event',80,704,138,78);
    this.text('MAP VETO',247,747,45,C.ink,{weight:900,max:350});
    this.text(m.stage.toUpperCase(),249,774,13,C.muted,{max:340});
    this.logo(m.teams[0],650,714,58,58);
    this.text(m.teams[0].toUpperCase(),726,751,29,C.ink,{weight:900,max:310});
    this.text('VS',1090,748,18,C.muted,{align:'center'});
    this.logo(m.teams[1],1140,714,58,58);
    this.text(m.teams[1].toUpperCase(),1216,751,29,C.ink,{weight:900,max:450});
    this.tag(m.format,1730,722,110);
  }
  card(map,index,m,now,strip) {
    const c=this.ctx,gap=14,w=(1760-gap*6)/7,x=80+index*(w+gap);
    const y=strip?806:382,h=strip?213:438;
    const {value:v,p,change}=this.cardVisual(map,now),active=!!change&&p<1;
    const color=tint(tint(tint(C.faint,C.ban,v.ban),C.accent,v.accent),C.gold,v.white);
    const accent=map.status==='pick'||map.status==='pending';
    const sideOnly=active&&change.old.status==='pending'&&map.status==='pick'&&change.old.name===map.name;
    const enteringPick=active&&accent&&!['pick','pending'].includes(change.old.status);
    const entering=active&&map.status!=='available'&&!sideOnly;
    const energy=active?Math.sin(Math.PI*p):0;
    // Cards remain anchored: only the artwork moves, never the seven-column grid.
    this.rect(x,y,w,h,C.panel,3);
    c.save();c.beginPath();c.roundRect(x,y,w,h,3);c.clip();
    const imageY=strip?y:y+51,imageH=strip?133:249;
    c.save();
    c.filter=`grayscale(${v.ban}) saturate(.85) brightness(${.9-v.ban*.32})`;
    if(active && change.old.name!==map.name)c.globalAlpha=map.name ? ease(p) : 1-ease(p);
    const artworkName=map.name || (active ? change.old.name : '');
    this.cover(this.assets.get(artworkName),x,imageY,w,imageH,1+(entering?energy*.025:0));
    c.restore();
    const nameChanged=active && change.old.name!==map.name;
    const emptyAlpha=map.name ? (nameChanged ? 1-ease(p) : 0) : (nameChanged ? ease(p) : 1);
    if(emptyAlpha>0) {
      this.text(String(index+1).padStart(2,'0'),x+w/2,imageY+imageH*.62,
        strip?54:88,C.muted,{align:'center',weight:900,alpha:emptyAlpha*.17});
    }
    const fade=c.createLinearGradient(0,imageY,0,imageY+imageH+15);
    fade.addColorStop(0,'#04131d00');fade.addColorStop(.55,'#04131d10');fade.addColorStop(1,C.panel);
    this.rect(x,imageY,w,imageH+15,fade);
    if(v.ban>0) {
      c.save();c.globalAlpha=.64;
      const cx=x+w/2,cy=strip?y+62:y+174,d=strip?29:47;
      const stroke=(a,b,progress)=>{
        const q=clamp(progress);
        if(q>0)this.line(a[0],a[1],a[0]+(b[0]-a[0])*q,a[1]+(b[1]-a[1])*q,C.ban,strip?4:5);
      };
      stroke([cx-d,cy-d],[cx+d,cy+d],v.ban*2);
      stroke([cx+d,cy-d],[cx-d,cy+d],v.ban*2-1);
      c.restore();
    }
    if(entering) {
      // A single diagonal colour sweep, without a whole-screen flash.
      c.save();c.beginPath();c.rect(x,imageY,w,imageH);c.clip();
      const cursor=x-100+(w+240)*p;
      const beam=c.createLinearGradient(cursor-95,0,cursor+45,0);
      beam.addColorStop(0,'#00000000');beam.addColorStop(.65,map.status==='ban'?'#ff657170':'#03dcf378');
      beam.addColorStop(1,'#00000000');c.globalAlpha=energy;
      c.fillStyle=beam;c.beginPath();c.moveTo(cursor-90,imageY);c.lineTo(cursor+45,imageY);
      c.lineTo(cursor-15,imageY+imageH);c.lineTo(cursor-150,imageY+imageH);c.closePath();c.fill();
      c.restore();
    }
    if(enteringPick) {
      const reveal=ease(p/.3)*(1-ease((p-.64)/.3));
      const bx=x+w/2,by=imageY+imageH*.5,sw=strip?104:142,sh=strip?38:52;
      c.save();c.globalAlpha=reveal;c.translate(bx,by+8*(1-reveal));c.scale(.9+.1*reveal,.9+.1*reveal);
      this.rect(-sw/2,-sh/2,sw,sh,C.accent,2);
      this.text('PICK',0,strip?10:14,strip?25:34,C.deep,{weight:900,align:'center',alpha:reveal});
      c.restore();
    }
    const title=(item,alpha=1)=>{
      this.text(item.name ? item.name.toUpperCase() : 'КАРТА '+String(index+1).padStart(2,'0'),
        x+16,strip?y+150:y+337,strip?29:39,
        item.name ? tint(C.ink,'#b0bec5',v.ban) : C.muted,{weight:900,max:w-30,alpha});
    };
    if(active && change.old.name!==map.name) {
      title(change.old,1-ease(p/.5));title(map,ease((p-.2)/.6));
    } else title(map);
    const roleInk=map.role==='ban'?C.ban:map.role==='pick'?C.accent:C.gold;
    const roleLabel=map.role==='ban'?'BAN':map.role==='pick'?'PICK':m.leftoverLabel;
    if(!strip) {
      this.text(String(index+1).padStart(2,'0'),x+18,y+31,18,roleInk);
      this.text(roleLabel,x+w-16,y+31,14,roleInk,{align:'right',max:w-70});
    }
    this.text(roleLabel,x+17,strip?y+181:y+373,strip?17:19,roleInk,{weight:900,max:w-32});
    const captions=(item,alpha,dy=0)=>{
      if(alpha<=0)return;
      const ban=item.status==='ban',pick=item.status==='pick',left=item.status==='leftover',pending=item.status==='pending';
      if(item.team!==null) {
        this.text(m.teams[item.team],x+17,(strip?y+202:y+401)+dy,strip?13:16,
          ban?C.muted:C.ink,{max:w-33,alpha});
      } else if(left) {
        this.text(m.format==='BO2'?'Осталась в пуле':'Решающая карта',
          x+17,(strip?y+202:y+402)+dy,strip?13:16,C.muted,{max:w-33,alpha});
      } else if(pending) {
        this.text(m.teams[m.nextTeam],x+17,(strip?y+202:y+402)+dy,
          strip?13:16,C.muted,{max:w-33,alpha});
      } else {
        this.text('Карта не выбрана',x+17,(strip?y+202:y+402)+dy,
          strip?13:16,C.muted,{max:w-33,alpha});
      }
      if(pick&&!strip) {
        this.text(`${item.side} · ${m.teams[item.sideTeam]}`,x+17,y+423+dy,13,C.muted,{max:w-33,alpha});
      } else if(pick&&strip) {
        c.save();c.globalAlpha=alpha;
        this.rect(x+w-52,y+163+dy,38,24,'#03dcf322',2);c.restore();
        this.text(item.ownSide,x+w-33,y+180+dy,13,C.accent,{align:'center',alpha});
      }
    };
    if(active) {
      const out=1-ease(p/.36),reveal=ease((p-.25)/.5);
      captions(change.old,out,-5*(1-out));
      captions(map,reveal,10*(1-reveal));
    } else captions(map,1);
    this.rect(x,y+h-4,w,4,color);
    c.restore();
    const border=tint(tint('#28414b',C.accent,v.accent),C.gold,v.white);
    c.strokeStyle=border;c.lineWidth=1+v.accent;c.beginPath();c.roundRect(x+.5,y+.5,w-1,h-1,3);c.stroke();
    if(entering) {
      c.save();
      c.strokeStyle=accent?C.accent:map.status==='ban'?C.ban:C.gold;
      c.lineWidth=strip?3:4;c.shadowColor=c.strokeStyle;c.shadowBlur=16*energy;c.globalAlpha=.35+.65*energy;
      const perimeter=2*(w+h)-6;
      c.setLineDash([perimeter*ease(p),perimeter]);c.lineDashOffset=0;
      c.beginPath();c.roundRect(x+1,y+1,w-2,h-2,3);c.stroke();
      c.restore();
    }
  }
  fullFooter(m) {
    if(m.finished) {
      this.text('ПОРЯДОК КАРТ',82,902,16,C.muted);
      this.text('ВЕТО ЗАВЕРШЕНО',1838,902,16,C.accent,{align:'right'});
      const itemW=1760/m.series.length;
      m.series.forEach((name,i)=>{
        const x=80+i*itemW;
        this.text(String(i+1).padStart(2,'0'),x,967,19,C.accent);
        this.text(name.toUpperCase(),x+42,971,37,C.ink,{weight:900,max:itemW-75});
        this.text(i===m.series.length-1?(m.format==='BO2'?'ОСТАЛАСЬ В ПУЛЕ':'РЕШАЮЩАЯ КАРТА'):'PICK',x+44,999,12,C.muted);
      });
    } else {
      const action=m.pending?'ВЫБИРАЕТ СТОРОНУ':m.nextType==='pick'?'ВЫБИРАЕТ КАРТУ':'УБИРАЕТ КАРТУ';
      const team=m.teams[m.pending?1-m.nextTeam:m.nextTeam];
      this.logo(team,82,932,60,60);
      this.text(action,162,929,15,C.accent);
      this.text(team.toUpperCase(),159,976,39,C.ink,{weight:900,max:820});
      this.text(`ХОД ${String(m.actions.length+1).padStart(2,'0')} / 06`,1839,918,17,C.muted,{align:'right'});
      for(let i=0;i<6;i++) {
        const x=1328+i*85,done=i<m.actions.length,current=i===m.actions.length;
        this.rect(x,946,70,45,done?C.accent:current?'#03dcf326':'#afcad414',2);
        this.text(String(i+1).padStart(2,'0'),x+35,977,22,done?C.deep:current?C.accent:C.faint,{align:'center'});
      }
    }
  }
  stripFooter(m) {
    if(m.finished) {
      this.text('ПОРЯДОК КАРТ',82,1055,13,C.muted);
      this.text(m.series.map(name=>name.toUpperCase()).join('  →  '),270,1057,20,C.ink,{max:1270});
      this.text('ГОТОВО',1838,1055,13,C.accent,{align:'right'});
    } else {
      const team=m.teams[m.pending?1-m.nextTeam:m.nextTeam];
      const action=m.pending?'ВЫБОР СТОРОНЫ':m.nextType==='pick'?'PICK':'BAN';
      this.text('СЕЙЧАС',82,1055,13,C.muted);
      this.text(`${team.toUpperCase()} · ${action}`,190,1057,20,C.ink,{max:1380});
      this.text(`${String(m.actions.length+1).padStart(2,'0')} / 06`,1838,1055,15,C.accent,{align:'right'});
    }
  }
  draw(now=performance.now()) {
    const c=this.ctx,strip=this.layout==='strip';
    this.canvas.dataset.animating=[...this.changed].filter(([,item])=>
      now-item.started<item.duration).map(([,item])=>item.name).join(',');
    c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,this.canvas.width,this.canvas.height);
    c.save();if(this.cropped&&strip)c.translate(0,-680);
    const seconds=this.motion?(now-this.started)/1000+12:this.frozenTime;
    this.background(seconds,strip);
    const m=this.model;
    if(!m) {
      this.logo('/event',800,360,320,180);
      this.text('ОЖИДАНИЕ ВЕТО',960,strip?920:650,44,C.ink,{align:'center'});
      c.restore();return;
    }
    if(strip)this.stripHeader(m);else this.fullHeader(m);
    m.slots.forEach((map,i)=>this.card(map,i,m,now,strip));
    if(strip)this.stripFooter(m);else this.fullFooter(m);
    c.restore();
    this.canvas.dataset.layout=this.layout;
    this.canvas.dataset.smoke=this.smoke?.kind||'static';
    this.canvas.dataset.ready='true';
  }
  async png() {
    this.changed.clear();
    this.draw();
    return new Promise((resolve,reject)=>this.canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Не удалось сохранить PNG.')),'image/png'));
  }
}
