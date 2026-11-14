import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
function setup(){
 const state={activeDay:'2026-11-14',service:{requirements:[],teams:[{id:'AUDIO'},{id:'LIGHTS'}],workers:Array.from({length:8},(_,i)=>({id:'W'+i,personal:'Worker '+i,movil:'60000000'+i,included:true,serviceDate:'2026-11-14',trabajo:'LOAD IN',teamId:'AUDIO'}))}};
 const slice=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
 let group=['LOAD IN'];
 const fn=new Function('state','normalize','NO_TEAMS_REQUIREMENT_TEAM_ID','crewStaffingGroupFor',
  slice('function allRequirementsForWork','function workHasNoTeams')+
  slice('function requirementsForWork','function staffingSummaryForWork')+';return requirementsForWork'
 )(state,x=>String(x||'').toUpperCase(),'NO_TEAMS',()=>group);
 return {state,read:()=>fn('LOAD IN'),link:()=>{group=['LOAD IN','LOAD OUT'];}};
}
test('eight assigned workers create an automatic target which follows additions/removals',()=>{
 const x=setup();assert.equal(x.read()[0].requiredCount,8);assert.equal(x.read()[0].automatic,true);
 x.state.service.workers.pop();assert.equal(x.read()[0].requiredCount,7);
 x.state.service.workers[0].teamId='LIGHTS';
 assert.equal(x.read().find(r=>r.teamId==='AUDIO').requiredCount,6);
 assert.equal(x.read().find(r=>r.teamId==='LIGHTS').requiredCount,1);
 assert.deepEqual(x.state.service.requirements,[],'derived counts must not become frozen manual goals');
});
test('explicit targets including zero are respected and clearing restores automatic count',()=>{
 const x=setup();const manual={serviceDate:x.state.activeDay,trabajo:'LOAD IN',teamId:'AUDIO',requiredCount:12};
 x.state.service.requirements=[manual];assert.equal(x.read()[0].requiredCount,12);
 manual.requiredCount=0;assert.equal(x.read()[0].requiredCount,0);
 x.state.service.requirements=[];assert.equal(x.read()[0].requiredCount,8);
});
test('automatic requirements respect day, inclusion, linked shifts and no-team configuration',()=>{
 const x=setup();x.state.service.workers.push({...x.state.service.workers[0],id:'COPY',trabajo:'LOAD OUT'});
 x.link();assert.equal(x.read()[0].requiredCount,8,'linked shifts count a person only once');
 x.state.service.workers[1].included=false;x.state.service.workers[2].serviceDate='2026-11-15';
 assert.equal(x.read()[0].requiredCount,6);
 x.state.service.requirements=[{serviceDate:x.state.activeDay,trabajo:'LOAD IN',teamId:'NO_TEAMS',requiredCount:0}];
 assert.deepEqual(x.read(),[]);
});
