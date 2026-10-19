'use strict';
const crypto=require('crypto');
const DIRECTIONS=['up','down','side'];
function hash(seed){return crypto.createHash('sha256').update(String(seed)).digest();}
function seeded(seed){const h=hash(seed); let n=h.readUInt32BE(0); return ()=>{n=(1664525*n+1013904223)>>>0; return n/0x100000000;};}
function pulseScenario(seed, seconds=5){const r=seeded(`pulse:${seed}:${seconds}`); const direction=DIRECTIONS[Math.floor(r()*3)]; return {seed:String(seed),seconds:Number(seconds),direction,change:Math.round((r()*.18-.09)*10000)/10000};}
function pulseXp(correct, seconds, streak=0){return correct?20+Number(seconds)*2+Math.min(Number(streak),10)*3:5;}
function trendScenario(seed,difficulty='easy'){const r=seeded(`trend:${seed}:${difficulty}`); const direction=DIRECTIONS[Math.floor(r()*3)]; const magnitude=Math.round((.02+r()*.2)*1000)/1000; return {seed:String(seed),difficulty,direction,magnitude};}
function comboXp(correct,combo){return correct?10+Math.min(Number(combo),20)*5:0;}
function makeArenaRound(seed,players=[]){return {roundId:crypto.createHash('sha256').update(`arena:${seed}`).digest('hex').slice(0,24),seed:String(seed),scenario:pulseScenario(seed,10),players:[...new Set(players.map(String))].slice(0,100),status:'open'};}
function validateSubmission(round,userId,submissionId,answer){if(!round||round.status!=='open')return {ok:false,reason:'round_closed'};if(!round.players.includes(String(userId)))return {ok:false,reason:'foreign_player'};if(round.submissions?.[String(userId)])return {ok:false,reason:'duplicate_submission'};if(!DIRECTIONS.includes(answer))return {ok:false,reason:'invalid_answer'};return {ok:true,submissionId:String(submissionId),userId:String(userId),answer};}
module.exports={DIRECTIONS,pulseScenario,pulseXp,trendScenario,comboXp,makeArenaRound,validateSubmission};
