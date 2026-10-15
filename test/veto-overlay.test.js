import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(m.maps.find(map=>map.name==='Mirage').status,'pending');
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
