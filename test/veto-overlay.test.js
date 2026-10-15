import test from 'node:test';
import assert from 'node:assert/strict';
import { appendVeto } from '../core.js';
import { MAP_POOL, snapshot, viewModel, demoState } from '../assets/veto-overlay/model.js';

test('overlay preserves the existing veto rules for all formats and first teams',()=>{
  for(const format of ['BO1','BO2','BO3','BO5'])for(const first of [0,1]) {
    for(let step=0;step<=6;step++) {
      const m=viewModel(demoState(format,step,first));
      assert.equal(m.finished,step===6);
      assert.equal(m.maps.filter(map=>['ban','pick'].includes(map.status)).length,step);
      assert.equal(m.maps.filter(map=>map.status==='leftover').length,step===6?1:0);
      assert.deepEqual(m.maps.map(map=>map.name),MAP_POOL);
      if(step<6)assert.equal(m.nextTeam,(first+step)%2);
    }
    assert.equal(viewModel(demoState(format,6,first)).series.length,Number(format.slice(2)));
  }
});

test('overlay attributes the selected starting side to the opposing team',()=>{
  const m=viewModel(demoState('BO3',3));
  const pick=m.maps.find(map=>map.status==='pick');
  assert.equal(pick.team,0);
  assert.equal(pick.sideTeam,1);
  assert.equal(pick.side,'CT');
  assert.equal(pick.ownSide,'T');
  assert.equal(m.teams[pick.sideTeam],'Johnny Speeds');
});

test('BO2 leftover is played as map two, without calling it a deciding map',()=>{
  const m=viewModel(demoState('BO2',6));
  assert.equal(m.series.length,2);
  assert.equal(m.leftoverLabel,'MAP 02');
});

test('pending picks remain uncommitted until a starting side is chosen',()=>{
  const base=demoState('BO3',2);
  const m=viewModel({...base,pending:'Mirage'});
  assert.equal(m.actions.length,2);
  assert.equal(m.series.length,0);
  const pick=m.maps.find(map=>map.name==='Mirage');
  assert.equal(pick.status,'pending');
  assert.equal(pick.team,0);
  assert.equal(pick.sideTeam,1);
  assert.throws(()=>snapshot({...base,pending:'Ancient'}));
  assert.throws(()=>snapshot({...demoState('BO3',0),pending:'Mirage'}));
});

test('overlay rejects malformed snapshots without mutating the supplied state',()=>{
  const original=demoState('BO3',3),copy=structuredClone(original);
  const clean=snapshot(original);
  clean.actions[0].map='Nuke';clean.teams[0]='Other';
  assert.deepEqual(original,copy);
  assert.throws(()=>snapshot({...original,teams:['same','same']}));
  assert.throws(()=>snapshot({...original,teams:['A\nB','C']}));
  assert.throws(()=>snapshot({...original,actions:[...original.actions,original.actions[0]]}));
  assert.throws(()=>snapshot({...original,actions:original.actions.map((a,i)=>i===2?{...a,side:'wrong'}:a)}));
});

test('BO3 broadcast slots keep turn order even when maps are chosen out of pool order',()=>{
  const roles=['ban','ban','pick','pick','ban','ban','leftover'];
  const names=['Nuke','Mirage','Cache','Ancient','Inferno','Dust2'];
  let actions=[];
  for(let step=0;step<=6;step++) {
    const state={...demoState('BO3',0),actions};
    const model=viewModel(state);
    assert.deepEqual(model.slots.map(slot=>slot.role),roles);
    assert.deepEqual(model.slots.map(slot=>slot.id),['turn-1','turn-2','turn-3','turn-4','turn-5','turn-6','turn-7']);
    assert.deepEqual(model.slots.map(slot=>slot.step),[1,2,3,4,5,6,7]);
    assert.deepEqual(model.slots.slice(0,step).map(slot=>slot.name),names.slice(0,step));
    assert.ok(model.slots.slice(step,6).every(slot=>slot.name===''&&slot.status==='available'));
    assert.equal(model.slots[6].name,step===6?'Anubis':'');
    if(step<6)actions=appendVeto(actions,'BO3',0,names[step],'CT');
  }
});

test('pending pick, commit, undo and replacement occupy the same broadcast slot',()=>{
  const before=demoState('BO3',2);
  const pending=viewModel({...before,pending:'Mirage'});
  assert.equal(pending.slots[2].name,'Mirage');
  assert.equal(pending.slots[2].status,'pending');
  assert.equal(pending.slots[2].step,3);
  assert.ok(pending.slots.slice(3).every(slot=>slot.name===''));
  const picked=viewModel(demoState('BO3',3));
  assert.equal(picked.slots[2].id,pending.slots[2].id);
  assert.equal(picked.slots[2].name,'Mirage');
  const undone=viewModel(before);
  assert.deepEqual(undone.slots.slice(0,2),picked.slots.slice(0,2));
  assert.equal(undone.slots[2].name,'');
  const replaced=viewModel({...before,actions:appendVeto(before.actions,'BO3',0,'Nuke','T')});
  assert.equal(replaced.slots[2].id,picked.slots[2].id);
  assert.equal(replaced.slots[2].name,'Nuke');
});

test('undoing the last ban clears its slot and the decider without moving prior turns',()=>{
  const completed=viewModel(demoState('BO3',6));
  const undone=viewModel(demoState('BO3',5));
  assert.deepEqual(undone.slots.slice(0,5),completed.slots.slice(0,5));
  assert.equal(undone.slots[5].name,'');
  assert.equal(undone.slots[6].name,'');
  assert.equal(undone.slots[6].role,'leftover');
});
