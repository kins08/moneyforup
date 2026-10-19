'use strict';
const assert=require('assert');
const g=require('./games');

// determinism
assert.deepStrictEqual(g.pulseScenario('s1',5),g.pulseScenario('s1',5));
assert.deepStrictEqual(g.trendScenario('s1','easy'),g.trendScenario('s1','easy'));
assert.notDeepStrictEqual(g.pulseScenario('s1',5),g.pulseScenario('s2',5));

// generation sanity
for(let i=0;i<200;i++){
  const p=g.pulseScenario('seed'+i,5);
  assert(g.DIRECTIONS.includes(p.direction));
  assert(Math.abs(p.change)<=0.09);
  const t=g.trendScenario('seed'+i,'hard');
  assert(g.DIRECTIONS.includes(t.direction));
  assert(t.magnitude>=0.02&&t.magnitude<=0.22);
}

// XP
assert.strictEqual(g.pulseXp(false,5,3),5);
assert.strictEqual(g.pulseXp(true,5,0),30);
assert.strictEqual(g.pulseXp(true,5,100),20+10+30); // streak capped at 10

// combo
assert.strictEqual(g.comboXp(false,5),0);
assert.strictEqual(g.comboXp(true,0),10);
assert.strictEqual(g.comboXp(true,999),10+20*5); // combo capped at 20

// arena: ownership, duplicate, invalid, closed
const round=g.makeArenaRound('r1',['1','2','2']);
assert.deepStrictEqual(round.players,['1','2']);
assert.strictEqual(g.validateSubmission(round,'1','sub1','up').ok,true);
assert.strictEqual(g.validateSubmission(round,'99','sub2','up').reason,'foreign_player');
assert.strictEqual(g.validateSubmission(round,'1','sub3','bogus').reason,'invalid_answer');
round.submissions={'1':{answer:'up'}};
assert.strictEqual(g.validateSubmission(round,'1','sub4','down').reason,'duplicate_submission');
round.status='closed';
assert.strictEqual(g.validateSubmission(round,'2','sub5','up').reason,'round_closed');
assert.strictEqual(g.validateSubmission(null,'2','sub6','up').reason,'round_closed');

console.log('OK (determinism, generation, XP, combo, ownership, duplicate, invalid, closed)');
