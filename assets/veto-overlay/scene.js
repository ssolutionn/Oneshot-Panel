import { MAP_POOL, viewModel } from './model.js';
import { makeSmoke } from './smoke.js';

const C = {
  ink:'#f3fbff', muted:'#9ab8c4', faint:'#577582', accent:'#03dcf3',
  deep:'#05131d', panel:'#0a1c27', ban:'#ff6571', gold:'#e5edf1'
};
const W=1920,H=1080;
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
    ['/background','/assets/card/background.png'],
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
  constructor(canvas,assets,{layout='full',motion=true}={}) {
    this.canvas=canvas;this.ctx=canvas.getContext('2d',{alpha:true});
    this.assets=assets;this.layout=layout;this.motion=motion;this.changed=new Map();
    this.smoke=makeSmoke(assets.get('/background'));this.raf=0;this.lastFrame=0;
    this.frozenTime=12;this.started=performance.now();this.model=null;
    this.paint=this.paint.bind(this);
  }
  setState(value,{animate=true}={}) {
    const next=viewModel(value),now=performance.now();
    this.changed.clear();
    if(animate && this.model) {
      next.maps.forEach(map=>{
        const old=this.model.maps.find(old=>old.name===map.name);
        if(old?.status!==map.status || old?.side!==map.side) this.changed.set(map.name,now);
      });
    }
    this.model=next;
    this.canvas.dataset.phase=next.finished ? 'finished' : next.pending ? 'side' : 'veto';
    this.canvas.setAttribute('aria-label',this.description());
    this.start();
  }
  description() {
    const m=this.model;
    return m ? `${m.teams.join(' против ')}. ${m.format}. ${m.finished ? 'Вето завершено. '+m.series.join(', ') :
      m.pending ? 'Выбор стороны на '+m.pending : 'Ход '+(m.actions.length+1)+': '+m.teams[m.nextTeam]+', '+m.nextType}.` : 'Ожидание вето.';
  }
  setLayout(layout) {this.layout=layout==='strip'?'strip':'full';this.start();}
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
    const transitioning=[...this.changed.values()].some(time=>now-time<550);
    if(this.motion || transitioning) this.start();
  }
  dispose() {cancelAnimationFrame(this.raf);this.smoke?.dispose();}
  text(value,x,y,size=24,color=C.ink,{weight=700,max=Infinity,align='left',alpha=1}={}) {
    const c=this.ctx;c.save();c.globalAlpha=alpha;c.fillStyle=color;
    c.font=`${weight} ${size}px Arial, sans-serif`;c.textBaseline='alphabetic';c.textAlign=align;
    const width=c.measureText(String(value)).width,scale=Math.min(1,max/Math.max(1,width));
    c.translate(x,y);c.scale(scale,1);c.fillText(String(value),0,0);c.restore();
  }
  rect(x,y,w,h,color,radius=0) {
    const c=this.ctx;c.fillStyle=color;c.beginPath();
    if(radius)c.roundRect(x,y,w,h,radius);else c.rect(x,y,w,h);
    c.fill();
  }
  line(x1,y1,x2,y2,color,width=1) {
    const c=this.ctx;c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.stroke();
  }
  cover(img,x,y,w,h) {
    if(!img)return;
    const scale=Math.max(w/img.width,h/img.height),sw=w/scale,sh=h/scale;
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
    const ban=map.status==='ban',pick=map.status==='pick',left=map.status==='leftover',pending=map.status==='pending';
    const color=ban?C.ban:pick||pending?C.accent:left?C.gold:C.faint;
    const elapsed=now-(this.changed.get(map.name) ?? -10000),p=Math.min(1,elapsed/500);
    const lift=elapsed>=0 && p<1 ? Math.sin(p*Math.PI)*(strip?5:11) : 0;
    c.save();c.translate(0,-lift);
    this.rect(x,y,w,h,C.panel,3);
    c.save();c.beginPath();c.roundRect(x,y,w,h,3);c.clip();
    const imageY=strip?y:y+51,imageH=strip?133:249;
    c.save();
    c.filter=ban?'grayscale(1) brightness(.58)':'saturate(.85) brightness(.9)';
    this.cover(this.assets.get(map.name),x,imageY,w,imageH);c.restore();
    const fade=c.createLinearGradient(0,imageY,0,imageY+imageH+15);
    fade.addColorStop(0,'#04131d00');fade.addColorStop(.55,'#04131d10');fade.addColorStop(1,C.panel);
    this.rect(x,imageY,w,imageH+15,fade);
    if(ban) {
      c.save();c.globalAlpha=.44;
      const cx=x+w/2,cy=strip?y+64:y+177,d=strip?20:35;
      this.line(cx-d,cy-d,cx+d,cy+d,C.ban,strip?3:4);
      this.line(cx+d,cy-d,cx-d,cy+d,C.ban,strip?3:4);c.restore();
    }
    if(!strip) {
      this.text(map.step?String(map.step).padStart(2,'0'):'—',x+18,y+31,18,color);
      this.text(ban?'BAN':pick?'PICK':left?m.leftoverLabel:pending?'ВЫБОР СТОРОНЫ':'В ПУЛЕ',x+w-16,y+31,14,color,{align:'right',max:w-70});
    }
    this.text(map.name.toUpperCase(),x+16,strip?y+150:y+337,strip?29:39,ban?'#b0bec5':C.ink,{weight:900,max:w-30});
    const actionLabel=ban?'BAN':pick?'PICK':left?m.leftoverLabel:pending?'СТОРОНА':'ДОСТУПНА';
    this.text(actionLabel,x+17,strip?y+181:y+373,strip?17:19,color,{weight:900,max:w-32});
    if(map.team!==null) {
      const actor=m.teams[map.team];
      this.text(actor,x+17,strip?y+202:y+401,strip?13:16,ban?C.muted:C.ink,{max:w-33});
    } else if(left) {
      this.text(m.format==='BO2'?'Осталась в пуле':'Решающая карта',x+17,strip?y+202:y+402,strip?13:16,C.muted,{max:w-33});
    } else if(pending) {
      this.text(m.teams[1-m.nextTeam],x+17,strip?y+202:y+402,strip?13:16,C.muted,{max:w-33});
    }
    if(pick && !strip) {
      this.text(`${map.side} · ${m.teams[map.sideTeam]}`,x+17,y+423,13,C.muted,{max:w-33});
    } else if(pick && strip) {
      this.rect(x+w-52,y+163,38,24,'#03dcf322',2);
      this.text(map.ownSide,x+w-33,y+180,13,C.accent,{align:'center'});
    }
    this.rect(x,y+h-4,w,4,color);
    c.restore();
    c.strokeStyle=(pick||pending)?C.accent:left?'#cfe6ef70':'#8eb2be35';
    c.lineWidth=(pick||pending)?2:1;c.beginPath();c.roundRect(x+.5,y+.5,w-1,h-1,3);c.stroke();
    c.restore();
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
    c.clearRect(0,0,W,H);
    const seconds=this.motion?(now-this.started)/1000+12:this.frozenTime;
    this.background(seconds,strip);
    const m=this.model;
    if(!m) {
      this.logo('/event',800,360,320,180);
      this.text('ОЖИДАНИЕ ВЕТО',960,strip?920:650,44,C.ink,{align:'center'});
      return;
    }
    if(strip)this.stripHeader(m);else this.fullHeader(m);
    m.maps.forEach((map,i)=>this.card(map,i,m,now,strip));
    if(strip)this.stripFooter(m);else this.fullFooter(m);
    this.canvas.dataset.layout=this.layout;
    this.canvas.dataset.smoke=this.smoke?'webgl':'static';
    this.canvas.dataset.ready='true';
  }
  async png() {
    this.changed.clear();
    this.draw();
    return new Promise((resolve,reject)=>this.canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Не удалось сохранить PNG.')),'image/png'));
  }
}
