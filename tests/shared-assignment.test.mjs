import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function crewAssignPersonnelFromWork()'),html.indexOf('let crewStaffingAutoTimer'));
function run(method, sourceWork='SHOW CALL') {
 const worker=(id,trabajo,teamId='',extras={})=>({id,trabajo,teamId,personal:'Chris',movil:'600123456',included:true,serviceDate:'2026-11-14',...extras});
 const workers=[worker('A','LOAD IN'),worker('B','LOAD OUT'),worker('C','SHOW CALL','audio'),worker('D','LOAD OUT','',{isReserve:true,personal:'Pau'}),worker('E','OTHER')];
 const audio={id:'audio',name:'AUDIO',scenarioId:'main'};
 const reserve={id:'reserves',name:'RESERVAS'};
 workers[3].teamId=reserve.id;
 const state={activeDay:'2026-11-14',staffingWork:'LOAD IN',staffingDraft:{audio:1},service:{workers,teams:[audio,reserve]}};
 const updates=[];
 const dropdown={hidden:false};
 const trigger={expanded:'true',focused:false,setAttribute(_,value){this.expanded=value},focus(){this.focused=true}};
 const elements={crewAssignPersonnelSource:{value:sourceWork},crewAssignPersonnelDropdown:dropdown,crewAssignPersonnelToggle:trigger};
 const names=['state','document','normalize','crewStaffingWorks','crewStaffingUniqueRows','saveWorkerUpdates','alert','confirm','refreshWorkerRow','closeStaffingModal','renderPersonnel','renderStaffingRows'];
 const noop=()=>{};
 const fn=new Function(...names,source+';return '+method);
 fn(state,{getElementById:id=>elements[id]??null},v=>String(v||'').toUpperCase(),()=>['LOAD IN','LOAD OUT'],rows=>rows,items=>{
  if(method==='crewAssignPersonnelFromWork')assert.equal(dropdown.hidden,true);
  updates.push(...items);
 },noop,()=>true,noop,noop,noop,noop)();
 return {workers,updates,dropdown,trigger};
}
for(const method of ['crewAssignPersonnelFromWork','randomlyAssignHandsToTeams']){
 test(method+' saves the same team in each linked service',()=>{
  const {workers,updates}=run(method);
  assert.deepEqual(updates.map(w=>[w.workerId,w.teamId,w.scenarioId]),[['A','audio','main'],['B','audio','main']]);
  assert.equal(workers[3].teamId,'reserves');
  assert.equal(workers[4].teamId,'');
 });
}

test('copy assignment closes the popup and returns focus after choosing a source',()=>{
 const {dropdown,trigger}=run('crewAssignPersonnelFromWork');
 assert.equal(dropdown.hidden,true);
 assert.equal(trigger.expanded,'false');
 assert.equal(trigger.focused,true);
});

test('copy assignment leaves the popup open when there is no source',()=>{
 const {dropdown,updates}=run('crewAssignPersonnelFromWork','');
 assert.equal(dropdown.hidden,false);
 assert.deepEqual(updates,[]);
});

test('an older attendance poll cannot replace a confirmed local mark',()=>{
 const helper=html.slice(html.indexOf('function crewHasOlderAttendance'),html.indexOf('async function crewCheckRemoteChanges'));
 const older=new Function('crewPendingIdentityMatches',helper+';return crewHasOlderAttendance')((a,b)=>a.personal===b.personal);
 const snapshot=(status,version,personal='Chris')=>({workers:[{id:'1',personal,status,_fieldTimes:{status:version,arrivalAt:version}}]});
 const confirmed=snapshot('PRESENTE',5);
 assert.equal(older(confirmed,snapshot('PENDIENTE',4)),true);
 assert.equal(older(confirmed,snapshot('PENDIENTE',6)),false);
 assert.equal(older(confirmed,snapshot('PENDIENTE',0,'Pau')),false);
});
