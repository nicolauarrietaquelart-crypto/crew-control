import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const pauseUi=readFileSync(new URL('../public/pause-return.js',import.meta.url),'utf8');
const workerApi=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');

function section(start,end){
  const a=html.indexOf(start),b=html.indexOf(end,a);
  assert.ok(a>=0&&b>a,'Source section is missing: '+start);
  return html.slice(a,b);
}
function helpers(){
  return new Function('crypto',
    section('function crewUniqueWorkerIds','function crewWorkerIdentityEqual')+
    ';return {crewUniqueWorkerIds,crewPruneWorkerReferences}'
  )({randomUUID});
}
function fakeDispatch(){
  const source=section("  if(method==='saveWorkerChanges'){","  if(method==='addManualWorker'){");
  let revision=0;
  let saved={
    closed:false,_syncRevision:'R0',
    workers:[{id:'W1',personal:'Alex',serviceDate:'2026-11-14',
      trabajo:'LOAD IN',movil:'600123456',inicio:'09:00',fin:'17:00',
      status:'PENDIENTE',arrivalAt:'',teamId:'',_fieldTimes:{}}]
  };
  const clone=x=>JSON.parse(JSON.stringify(x));
  const api=async(code,method='GET',body)=>{
    if(method==='GET')return {service:clone(saved)};
    assert.equal(method,'PUT');
    if(body.revision!==saved._syncRevision){
      const err=new Error('Otro dispositivo ha modificado este servicio');
      err.status=409;throw err;
    }
    saved=clone(body.service);
    saved._syncRevision='R'+(++revision);
    return {revision:saved._syncRevision};
  };
  const dispatch=new Function('crewApi','code',
    'let crewSaveQueue=Promise.resolve();let crewLastLocalWrite=0;'+
    'return async function(method,args){'+source+'}'
  )(api,'123456');
  const identity={personal:'Alex',serviceDate:'2026-11-14',
    trabajo:'LOAD IN',movil:'600123456',inicio:'09:00',fin:'17:00'};
  return {dispatch,identity,get saved(){return clone(saved)}};
}

test('all duplicate row IDs are replaced, unique IDs stay stable',()=>{
  const {crewUniqueWorkerIds}=helpers();
  const result=crewUniqueWorkerIds([
    {id:'DUP',personal:'Alex'},{id:'DUP',personal:'Chris'},
    {id:'SAFE',personal:'Pau'}
  ]);
  assert.equal(result.repaired,2);
  assert.deepEqual([...result.workers].map(w=>w.id==='DUP'),[false,false,false]);
  assert.equal(result.workers[2].id,'SAFE');
  assert.equal(new Set(result.workers.map(w=>w.id)).size,3);
});

test('old pause and incident references do not move to a repaired worker',()=>{
  const {crewUniqueWorkerIds,crewPruneWorkerReferences}=helpers();
  const fixed=crewUniqueWorkerIds([{id:'DUP'},{id:'DUP'},{id:'SAFE'}]);
  const service=crewPruneWorkerReferences({
    workers:fixed.workers,
    pauseShifts:[{workerIds:['DUP','SAFE'],returnStatuses:{DUP:'PRESENTE',SAFE:'CONTACTADO'}}],
    incidents:[{workerId:'DUP',description:'Historical note'},{workerId:'SAFE'}]
  },fixed.ambiguousIds);
  assert.deepEqual(service.pauseShifts[0].workerIds,['SAFE']);
  assert.equal(service.pauseShifts[0].returnStatuses.DUP,undefined);
  assert.equal(service.incidents[0].workerId,'');
  assert.equal(service.incidents[0].description,'Historical note');
  assert.equal(service.incidents[1].workerId,'SAFE');
});

test('attendance saves return field acknowledgements and do not affect other fields',async()=>{
  const x=fakeDispatch();
  const attendance={workerId:'W1',status:'PRESENTE',arrivalAt:'09:07',
    _workerIdentity:x.identity,_fieldTimes:{status:100,arrivalAt:100},
    _baseFieldTimes:{status:0,arrivalAt:0}};
  const result=await x.dispatch('saveWorkerChanges',['123456',[attendance]]);
  assert.equal(result.ok,true);
  assert.equal(result.confirmedVersions.W1.status,1);
  assert.equal(x.saved.workers[0].status,'PRESENTE');
  const team={workerId:'W1',teamId:'TEAM1',_workerIdentity:x.identity,
    _fieldTimes:{teamId:101},_baseFieldTimes:{teamId:0}};
  await x.dispatch('saveWorkerChanges',['123456',[team]]);
  assert.equal(x.saved.workers[0].status,'PRESENTE');
  assert.equal(x.saved.workers[0].teamId,'TEAM1');
});

test('a stale status from another device cannot be silently acknowledged',async()=>{
  const x=fakeDispatch();
  await x.dispatch('saveWorkerChanges',['123456',[{
    workerId:'W1',status:'PRESENTE',_workerIdentity:x.identity,
    _fieldTimes:{status:100},_baseFieldTimes:{status:0}
  }]]);
  await assert.rejects(x.dispatch('saveWorkerChanges',['123456',[{
    workerId:'W1',status:'NO PRESENTADO',_workerIdentity:x.identity,
    _fieldTimes:{status:200},_baseFieldTimes:{status:0}
  }]]),/Conflicto de edición/);
  assert.equal(x.saved.workers[0].status,'PRESENTE');
});

test('a mismatched identity cannot modify another worker',async()=>{
  const x=fakeDispatch();
  await assert.rejects(x.dispatch('saveWorkerChanges',['123456',[{
    workerId:'W1',status:'PRESENTE',
    _workerIdentity:{...x.identity,personal:'Chris'},
    _fieldTimes:{status:1},_baseFieldTimes:{status:0}
  }]]),/Identidad del trabajador/);
  assert.equal(x.saved.workers[0].status,'PENDIENTE');
});

test('the next click uses the last confirmed version, even with no pending write',()=>{
  const code=section('function crewRebasePendingJournal','function crewCacheRoster');
  const journal={};
  const workers=[{id:'W1',_fieldTimes:{}}];
  const state={service:{code:'123456',workers}};
  const rebase=new Function('crewPendingJournal','crewWriteLocal','state','CREW_PENDING_PREFIX',
    code+';return crewRebasePendingJournal'
  )(()=>journal,()=>true,state,'test:');
  rebase('123456',{W1:{status:1}});
  assert.equal(workers[0]._fieldTimes.status,1);
  journal.W1={workerId:'W1',status:'NO PRESENTADO',_baseFieldTimes:{status:0}};
  rebase('123456',{W1:{status:2}});
  assert.equal(journal.W1._baseFieldTimes.status,2);
});

test('return-from-break attendance is represented by durable events',()=>{
  const merger=new Function(section('function crewPauseMerge','function crewPauseSave')+
    ';return crewPauseMerge')();
  const original={
    pauseShifts:[{id:'P1',serviceDate:'2026-11-14',trabajo:'LOAD IN',
      workerIds:['W1'],returnStatuses:{W1:'CONTACTADO'}}],
    _pauseVersions:{}
  };
  const updated=merger(original,[{kind:'return',id:'P1',workerId:'W1',status:'PRESENTE',at:100}]);
  assert.equal(updated.pauseShifts[0].returnStatuses.W1,'PRESENTE');
  const removed=merger(updated,[{kind:'assign',id:'P1',workerId:'W1',
    serviceDate:'2026-11-14',trabajo:'LOAD IN',checked:false,at:101}]);
  assert.equal(removed.pauseShifts[0].returnStatuses.W1,undefined);
  assert.match(pauseUi,/crewPauseSave\(\{kind:'return'/);
});

test('D1 rejects duplicate worker IDs before committing a service snapshot',()=>{
  assert.match(workerApi,/uniqueWorkerIds\.has\(id\)/);
  assert.match(workerApi,/ID de trabajador vacío o duplicado/);
  assert.match(html,/crewRebasePendingJournal\(serviceCode,result\.confirmedVersions\)/);
});

test('all browser and Worker scripts have valid JavaScript syntax',()=>{
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  for(const match of scripts){
    if(match[1].trim())assert.doesNotThrow(()=>new Function(match[1]));
  }
  assert.doesNotThrow(()=>new Function(pauseUi));
  assert.doesNotThrow(()=>new Function(workerApi.replace('export default','const app =').replace('export function','function')));
});


test('offline mismatch preflight preserves rejected edits and keeps valid edits queued',async()=>{
  const source=section("const CREW_HELD_PREFIX='crew-held-worker-updates-v1:';","function crewPendingJournal(code){");
  const stored=new Map();
  const pending={
    OLD:{workerId:'OLD',status:'PRESENTE',_workerIdentity:{personal:'Chris',serviceDate:'2026-11-14',trabajo:'LOAD IN',movil:'600111111',inicio:'08:00',fin:'16:00'},_fieldTimes:{status:1},_baseFieldTimes:{status:0}},
    W2:{workerId:'W2',status:'CONTACTADO',_workerIdentity:{personal:'Alex',serviceDate:'2026-11-14',trabajo:'LOAD IN',movil:'600222222',inicio:'08:00',fin:'16:00'},_fieldTimes:{status:2},_baseFieldTimes:{status:0}}
  };
  stored.set('pending:123456',structuredClone(pending));
  const remote={workers:[
    {id:'OLD',personal:'Pau',serviceDate:'2026-11-14',trabajo:'LOAD IN',movil:'600333333',inicio:'08:00',fin:'16:00'},
    {id:'W2',personal:'Alex',serviceDate:'2026-11-14',trabajo:'LOAD IN',movil:'600222222',inicio:'08:00',fin:'16:00'}
  ]};
  const state={pendingWorkerUpdates:structuredClone(pending)};
  const read=(prefix,code)=>structuredClone(stored.get(prefix+code)||{});
  const write=(prefix,code,value)=>{stored.set(prefix+code,structuredClone(value));return true;};
  const setup=new Function('crewReadLocal','crewWriteLocal','crewApi','CREW_PENDING_PREFIX','state','setSaveState','crewMergeUpdate',
    'const crewPendingJournal=code=>crewReadLocal(CREW_PENDING_PREFIX,code);'+source+';return {crewHoldMismatchedPending,crewHeldJournal,crewPendingIdentityMatches}'
  );
  const result=setup(read,write,async()=>({service:remote}),'pending:',state,()=>{},
    (old,update)=>({...old,...update}));
  assert.ok(await result.crewHoldMismatchedPending('123456')>0);
  assert.deepEqual(result.crewHeldJournal('123456').OLD,pending.OLD);
  assert.deepEqual(stored.get('pending:123456'),{W2:pending.W2});
  assert.deepEqual(Object.keys(state.pendingWorkerUpdates),['W2']);
  assert.equal(result.crewPendingIdentityMatches(remote.workers[0],pending.OLD._workerIdentity),false);
  assert.equal(result.crewPendingIdentityMatches(remote.workers[1],pending.W2._workerIdentity),true);
});

function recoveryFixture({pending={},held={},workers=[],failPrefix}={}){
  const stored=new Map([['pending:123456',structuredClone(pending)],
    ['crew-held-worker-updates-v1:123456',structuredClone(held)]]);
  const state={service:{code:'123456'},pendingWorkerUpdates:structuredClone(pending)};
  const read=(prefix,code)=>structuredClone(stored.get(prefix+code)||{});
  const write=(prefix,code,value)=>{
    if(prefix===failPrefix)return false;
    stored.set(prefix+code,structuredClone(value));return true;
  };
  const source=section("const CREW_HELD_PREFIX='crew-held-worker-updates-v1:';","function crewPendingJournal(code){")+
    section('function crewMergeUpdate','function crewJournalUpdates');
  const reconcile=new Function('crewReadLocal','crewWriteLocal','CREW_PENDING_PREFIX','state',
    'const crewPendingJournal=code=>crewReadLocal(CREW_PENDING_PREFIX,code);'+source+
    ';return crewReconcileWorkerJournal')(read,write,'pending:',state);
  return {run:()=>reconcile('123456',{workers}),state,
    pending:()=>read('pending:','123456'),held:()=>read('crew-held-worker-updates-v1:','123456')};
}
const recoveryIdentity={personal:'Chris',movil:'600111111',serviceDate:'2026-11-14',
  trabajo:'LOAD IN',inicio:'08:00',fin:'16:00'};
const recoveryEdit={workerId:'OLD',_workerIdentity:recoveryIdentity,status:'PRESENTE',
  _fieldTimes:{status:100},_baseFieldTimes:{status:0}};
const recoveryWorker={...recoveryIdentity,id:'NEW',status:'PENDIENTE',_fieldTimes:{status:0}};

test('pending and previously held edits recover to a repaired ID and save to D1',async()=>{
  for(const journal of ['pending','held']){
    const x=recoveryFixture({[journal]:{OLD:recoveryEdit},workers:[recoveryWorker]});
    assert.ok(x.run()>0);
    assert.equal(x.pending().NEW.workerId,'NEW');
    assert.deepEqual(x.pending().NEW._baseFieldTimes,{status:0});
    assert.deepEqual(x.held(),{});
    assert.equal(x.run(),0,'stable reconciliation must not rewrite storage');
    // Exercise real writer validation and acknowledgement after recovery.
    const writer=fakeDispatch();
    const fixed=recoveryFixture({[journal]:{OLD:{...recoveryEdit,_workerIdentity:writer.identity}},
      workers:writer.saved.workers});
    fixed.run();
    const result=await writer.dispatch('saveWorkerChanges',['123456',Object.values(fixed.pending())]);
    assert.equal(result.confirmedVersions.W1.status,1);
    assert.equal(writer.saved.workers[0].status,'PRESENTE');
  }
});

test('reused ID cannot redirect an edit; unique full identity selects the right worker',()=>{
  const x=recoveryFixture({pending:{OLD:recoveryEdit},workers:[
    {...recoveryWorker,id:'OLD',personal:'Pau',movil:'600222222'},recoveryWorker]});
  x.run();
  assert.equal(x.pending().OLD,undefined);
  assert.equal(x.pending().NEW.status,'PRESENTE');
});

test('ambiguous, incomplete or different-shift identities remain intact for review',()=>{
  for(const workers of [
    [recoveryWorker,{...recoveryWorker,id:'OTHER'}],
    [{...recoveryWorker,inicio:'10:00'}],
    [{...recoveryWorker,movil:'600222222'}]
  ]){
    const x=recoveryFixture({pending:{OLD:recoveryEdit},workers});
    x.run();assert.deepEqual(x.pending(),{});assert.deepEqual(x.held().OLD,recoveryEdit);
  }
  const edit={...recoveryEdit,_workerIdentity:{...recoveryIdentity,movil:''}};
  const x=recoveryFixture({pending:{OLD:edit},workers:[recoveryWorker]});
  x.run();assert.deepEqual(x.held().OLD,edit);
});

test('conflicting attendance is held without blocking unrelated worker changes',()=>{
  const other={...recoveryEdit,workerId:'W2',_workerIdentity:{...recoveryIdentity,personal:'Alex'}};
  const x=recoveryFixture({pending:{OLD:recoveryEdit,W2:other},workers:[
    {...recoveryWorker,status:'NO PRESENTADO',_fieldTimes:{status:2}},
    {...recoveryWorker,id:'W2',personal:'Alex'}]});
  x.run();
  assert.deepEqual(x.held().OLD,recoveryEdit);
  assert.deepEqual(Object.keys(x.pending()),['W2']);
});

test('storage failure does not erase original pending edits or publish a partial queue',()=>{
  for(const failPrefix of ['pending:','crew-held-worker-updates-v1:']){
    const x=recoveryFixture({pending:{OLD:recoveryEdit},workers:[recoveryWorker],failPrefix});
    assert.equal(x.run(),0);
    assert.deepEqual(x.pending().OLD,recoveryEdit);
    assert.deepEqual(x.state.pendingWorkerUpdates.OLD,recoveryEdit);
  }
});

test('recovery waits for writes in flight and never changes another service queue',()=>{
  const x=recoveryFixture({held:{OLD:recoveryEdit},workers:[recoveryWorker]});
  x.state.workerSaveInFlight=true;assert.equal(x.run(),0);
  assert.deepEqual(x.held().OLD,recoveryEdit);
  x.state.workerSaveInFlight=false;x.state.service.code='654321';
  x.run();assert.deepEqual(x.state.pendingWorkerUpdates,{});
  assert.equal(x.pending().NEW.status,'PRESENTE');
});
