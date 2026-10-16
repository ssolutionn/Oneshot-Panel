import test from 'node:test';
import assert from 'node:assert/strict';
import {progressView} from '../assets/veto-appearance.js';
test('veto timeline follows format, pending opponent side and delayed decider',()=>{
 const cards=[{status:'ban'},{status:'ban'},{status:'pick',side:false}];
 assert.deepEqual(progressView('BO3',cards).map(s=>s.label),['BAN','BAN','PICK','PICK','BAN','BAN','DECIDER']);
 assert.equal(progressView('BO3',cards)[2].state,'active');
 cards[2].side=true;assert.equal(progressView('BO3',cards)[3].state,'active');
 assert.deepEqual(progressView('BO5',[]).map(s=>s.label),['BAN','BAN','PICK','PICK','PICK','PICK','DECIDER']);
 assert.equal(progressView('BO1',[])[6].label,'PLAY');assert.equal(progressView('BO2',[])[6].label,'MAP 2');
 assert.ok(progressView('BO3',[],false).every(s=>s.state==='future'));
 const done=[...Array.from({length:6},()=>({status:'ban'})),{status:'decider'}];
 assert.equal(progressView('BO3',done,true,false)[6].state,'future');
 assert.ok(progressView('BO3',done).every(s=>s.state==='done'));
});
