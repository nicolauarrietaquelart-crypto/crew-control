import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import workerApiHandler, {closedDayChanged} from '../src/index.js';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const pauseUi=readFileSync(new URL('../public/pause-return.js',import.meta.url),'utf8');
const workerApi=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');

function section(start,end){
  const a=html.indexOf(start),b=html.indexOf(end,a);
  assert.ok(a>=0&&b>a,'Source section is missing: '+start);
  return html.slice(a,b);
}


test('PDF reference reads the event name and stops before an adjacent field',()=>{
  const source=section('function extractPdfReference(', 'async function parsePennyWisePdf(');
  const reference=new Function(source+'return extractPdfReference;')();
  assert.equal(reference('REFERENCIA: Concierto Barcelona RECINTO: Sala 2'),'Concierto Barcelona');
  assert.equal(reference('Referencia ： BCN-2784 | FECHA DE SERVICIO: 16/11/2026'),'BCN-2784');
  assert.equal(reference('REFERENCIA: La Fecha de una Canción'),'La Fecha de una Canción');
  assert.equal(reference('REFERENCIA: CONTACTO: Producción'),'');
  assert.equal(reference('REFERENCIA: —'),'');
  assert.equal(reference('PREFERENCIA: AJUSTE'),'');
});

test('original PDFs round-trip across D1 chunks and legacy PDFs remain readable',async()=>{
  const code='123456',documentId='f54bbd9e-7367-4d6d-ab37-d4a3260d8ab7';
  const chunks=[];
  const oldPdf=[37,80,68,70,45,48];
  let closed=false;
  const DB={
    prepare(sql){
      return {sql,bind(...values){this.values=values;return this;},
        async first(){
          if(sql.includes('FROM services'))return {id:'S',closed:0};
          if(sql.includes('FROM service_snapshots'))return {closed:Number(closed)};
          if(sql.includes('FROM service_pdf_documents'))return {filename:'anterior.pdf',content:oldPdf};
          throw new Error(sql);
        },
        async all(){return {results:chunks.map(({filename,content})=>({filename,content:[...content]}))};}
      };
    },
    async batch(statements){
      assert.match(statements[0].sql,/^DELETE FROM service_pdf_chunks/);
      chunks.splice(0,chunks.length,...statements.slice(1).map(({values},i)=>{
        assert.deepEqual(values.slice(0,3),['S',documentId,i]);
        const content=new Uint8Array(values[4]);
        assert.ok(content.length<=1000000);
        return {filename:values[3],content};
      }));
    }
  };
  const call=(method,body)=>workerApiHandler.fetch(new Request(
    'https://example.test/api/services/'+code+'/pdf?file='+documentId,
    {method,body,headers:{'x-service-code':code,'x-pdf-filename':encodeURIComponent('Día 2.pdf')}}
  ),{DB});
  assert.deepEqual([...new Uint8Array(await (await call('GET')).arrayBuffer())],oldPdf);
  assert.equal((await call('PUT',new Uint8Array([37]))).status,400);
  const original=new Uint8Array(2300123);
  original.set([37,80,68,70,45]);
  original[999999]=12;original[1000000]=23;original[original.length-1]=34;
  assert.equal((await call('PUT',original)).status,200);
  assert.equal(chunks.length,3);
  closed=true;
  assert.equal((await call('PUT',original)).status,409);
  const restored=await call('GET');
  assert.match(restored.headers.get('content-disposition'),/D%C3%ADa%202\.pdf/);
  assert.equal(Buffer.compare(Buffer.from(await restored.arrayBuffer()),original),0);
});

test('closing waits for pending edits and only generates Excel after the server confirms',async()=>{
  const close=section('async function performCloseService(','// Excel de cierre:');
  const run=async ({offline=false,held=0,flushError,day=''}={})=>{
    const calls=[],app={},state={service:{code:'123456'},metaTimer:1,structureTimer:2};
    const scope={
      state,document:{getElementById:()=>app},navigator:{onLine:!offline},crewWorkerFlushPromise:Promise.resolve(),
      crewHeldCount:()=>held,setSaveState(){},clearTimeout(){},
      crewFlushServiceChanges:async (...args)=>{calls.push(['flush',...args]);if(flushError)throw flushError;},
      scheduleMetaSave(){},scheduleStructureSave(){},crewRetryLocalUpdates(){},
      dispatchBackend:async (name,args)=>{calls.push([name,args]);return {service:{code:'123456',closed:!day}};},
      crewCacheRoster(){},applyClosedState(){},renderPersonnel(){},renderIncidents(){},renderAudit(){},
      downloadClosedServiceExcel:async (_auto,_notify,_service,exportDay)=>calls.push(['excel',exportDay]),openCrewCloseNotify(){},
      alert:message=>calls.push(message),errorMessage:error=>error.message
    };
    await new Function(...Object.keys(scope),'let crewExitInProgress=false;'+close+'return performCloseService('+JSON.stringify(day)+')')(...Object.values(scope));
    assert.ok(!app.inert);
    return {calls,state};
  };
  assert.deepEqual((await run()).calls,[['flush','123456',true,true],['closeService',['123456']],['excel','']]);
  const day='14/11/2026';
  assert.deepEqual((await run({day})).calls,[['flush','123456',true,true],['closeService',['123456',day]],['excel',day]]);
  assert.deepEqual((await run({flushError:Error('Pausas pendientes')})).calls,[['flush','123456',true,true],'Pausas pendientes']);
  assert.match((await run({held:1})).calls[0],/fichajes sin aplicar/);
  assert.match((await run({offline:true})).calls[0],/Recupera la conexión/);
});
function helpers(){
  return new Function('crypto',
    section('function crewUniqueWorkerIds','function crewWorkerIdentityEqual')+
    ';return {crewUniqueWorkerIds,crewPruneWorkerReferences}'
  )({randomUUID});
}
function fakeDispatch({loseFirstReceipt=false,corruptReceipt=false}={}){
  const source=section('function crewCanonicalWorkerPhone','const crewPersist=')+
    section('function crewPendingIdentityMatches','// Reconcile durable edits')+
    'return async function(method,args){'+section("  if(method==='saveWorkerChanges'){","  if(method==='addManualWorker'){")+'}';
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
    if(loseFirstReceipt&&revision===1)throw new Error('Conexión interrumpida después de guardar');
    const service=clone(saved);
    if(corruptReceipt)service.workers[0].status='PENDIENTE';
    return {ok:true,revision:saved._syncRevision,service};
  };
  const dispatch=new Function('crewApi','code',
    'let crewSaveQueue=Promise.resolve();let crewLastLocalWrite=0;'+
    source
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

test('an international phone with the same last nine digits cannot match a different row',async()=>{
  const x=fakeDispatch();
  await assert.rejects(x.dispatch('saveWorkerChanges',['123456',[{
    workerId:'W1',status:'PRESENTE',_workerIdentity:{...x.identity,movil:'+39 600123456'},
    _fieldTimes:{status:1},_baseFieldTimes:{status:0}
  }]]),/Identidad del trabajador/);
  await x.dispatch('saveWorkerChanges',['123456',[{
    workerId:'W1',status:'PRESENTE',_workerIdentity:{...x.identity,movil:'0034 600123456'},
    _fieldTimes:{status:2},_baseFieldTimes:{status:0}
  }]]);
  assert.equal(x.saved.workers[0].status,'PRESENTE');
});

test('retrying a write after losing its response keeps the first confirmed arrival',async()=>{
  const x=fakeDispatch({loseFirstReceipt:true});
  const edit={workerId:'W1',status:'PRESENTE',arrivalAt:'09:04',_workerIdentity:x.identity,
    _fieldTimes:{status:100,arrivalAt:100},_baseFieldTimes:{status:0,arrivalAt:0}};
  await assert.rejects(x.dispatch('saveWorkerChanges',['123456',[edit]]),/interrumpida/);
  const resumed=await x.dispatch('saveWorkerChanges',['123456',[edit]]);
  assert.deepEqual(resumed.confirmedVersions.W1,{status:1,arrivalAt:1});
  const otherDevice=await x.dispatch('saveWorkerChanges',['123456',[{...edit,arrivalAt:'09:06'}]]);
  assert.deepEqual(otherDevice.confirmedVersions.W1,{status:1,arrivalAt:1});
  assert.equal(x.saved.workers[0].arrivalAt,'09:04');
});

test('a successful HTTP response with the wrong attendance is not an acknowledgement',async()=>{
  const x=fakeDispatch({corruptReceipt:true});
  await assert.rejects(x.dispatch('saveWorkerChanges',['123456',[{
    workerId:'W1',status:'PRESENTE',_workerIdentity:x.identity,
    _fieldTimes:{status:100},_baseFieldTimes:{status:0}
  }]]),/no confirmó los valores/);
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
});

test('all browser and Worker scripts have valid JavaScript syntax',()=>{
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  for(const match of scripts){
    if(match[1].trim())assert.doesNotThrow(()=>new Function(match[1]));
  }
  assert.doesNotThrow(()=>new Function(pauseUi));
  assert.doesNotThrow(()=>new Function(workerApi.replace(/^import .*;\n/,'').replace('export default','const app =').replaceAll('export function','function')));
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
    'const crewPendingJournal=code=>crewReadLocal(CREW_PENDING_PREFIX,code);'+
    section('function crewCanonicalWorkerPhone','const crewPersist=')+
    section('function crewCurrentWorkerJournal','function crewJournalUpdates')+
    source+';return {crewHoldMismatchedPending,crewHeldJournal,crewPendingIdentityMatches}'
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
  const source=section('function crewCanonicalWorkerPhone','const crewPersist=')+
    section("const CREW_HELD_PREFIX='crew-held-worker-updates-v1:';","function crewPendingJournal(code){")+
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

test('a PDF time correction keeps the pending edit on the same uniquely identified row',()=>{
  const updated={...recoveryWorker,id:'OLD',inicio:'08:30'};
  const x=recoveryFixture({pending:{OLD:recoveryEdit},workers:[updated]});
  x.run();
  assert.equal(x.pending().OLD._workerIdentity.inicio,'08:30');
  assert.equal(x.pending().OLD.status,'PRESENTE');
  assert.deepEqual(x.held(),{});
  const ambiguous=recoveryFixture({pending:{OLD:recoveryEdit},workers:[updated,{...updated,id:'OTHER',inicio:'09:00'}]});
  ambiguous.run();
  assert.deepEqual(ambiguous.pending(),{});
  assert.deepEqual(ambiguous.held().OLD,recoveryEdit);
});

test('a receipt preserves a second click made while offline storage is unavailable',()=>{
  const source=section('function crewMergeUpdate','function crewCacheRoster');
  const identity={...recoveryIdentity};
  const existing={id:'OLD',...identity,status:'NO PRESENTADO',_fieldTimes:{}};
  const second={...recoveryEdit,status:'NO PRESENTADO',_fieldTimes:{status:101}};
  const state={service:{code:'123456',workers:[existing]},pendingWorkerUpdates:{OLD:second}};
  const ack=new Function('state','crewPendingJournal','crewWriteLocal','CREW_PENDING_PREFIX','crewPendingIdentityMatches','crewSnapshotIsOlder','crewHeldJournal','CREW_HELD_PREFIX',
    source+';return crewAckJournal')(state,()=>({}),()=>false,'pending:',(a,b)=>a?.personal===b?.personal,()=>false,()=>({}),'held:');
  const firstReceipt={ok:true,confirmedVersions:{OLD:{status:1}},service:{workers:[{...existing,status:'PRESENTE'}]}};
  assert.throws(()=>ack('123456',[recoveryEdit],{ok:true,confirmedVersions:{}}),/no confirmó todos/);
  ack('123456',[recoveryEdit],firstReceipt);
  assert.equal(state.pendingWorkerUpdates.OLD.status,'NO PRESENTADO');
  assert.equal(state.pendingWorkerUpdates.OLD._baseFieldTimes.status,1);
  assert.equal(existing._fieldTimes.status,1);
  assert.equal(existing.status,'NO PRESENTADO');
  ack('123456',[structuredClone(state.pendingWorkerUpdates.OLD)],{ok:true,confirmedVersions:{OLD:{status:2}}});
  assert.deepEqual(state.pendingWorkerUpdates,{});
  assert.equal(existing._fieldTimes.status,2);
});

test('a pre-write polling snapshot is rejected after a newer write acknowledgement',async()=>{
  let releasePoll;
  const oldPoll=new Promise(resolve=>{releasePoll=resolve;});
  const current={code:'123456',_syncSequence:7,workers:[{id:'W1',status:'PRESENTE'}]};
  const json=service=>({ok:true,json:async()=>({ok:true,service})});
  const responses=[oldPoll,Promise.resolve(json(current))];
  const api=new Function('fetch','crewDeviceId','crewConnectionRestored','crewConnectionFailed',
    section('const crewSnapshotSequences','let crewSaveQueue=')+';return crewApi')(
    ()=>responses.shift(),'test',()=>{},()=>{}
  );
  const poll=api('123456');
  await api('123456','PUT',{service:current});
  releasePoll(json({...current,_syncSequence:6,workers:[{id:'W1',status:'PENDIENTE'}]}));
  await assert.rejects(poll,{status:425});
});

test('PDF reimport preserves unmatched check-ins while applying the revised roster',async()=>{
  const source=section('function crewUniqueWorkerIds','const crewSaveLatest=');
  const attendance={...recoveryWorker,code:'123456',status:'PRESENTE',arrivalAt:'08:04',_fieldTimes:{status:3,arrivalAt:2}};
  let cloud={code:'123456',_syncRevision:'R1',workers:[attendance]};
  const api=async(code,method='GET',body)=>{
    if(method==='GET')return {service:structuredClone(cloud)};
    cloud={...body.service,_syncRevision:'R2'};
    return {ok:true,revision:'R2',service:cloud};
  };
  const persist=new Function('crewApi','crypto','normalize','crewReviewPdfMissingWorkers',
    'let crewSaveQueue=Promise.resolve(),crewLastLocalWrite=0;'+source+';return crewPersist')(
    api,{randomUUID},s=>String(s||'').trim().toUpperCase(),
    async workers=>new Map(workers.map(w=>[String(w.id),'keep'])));
  const parsed={...attendance,id:'FROM_PDF',personal:'Chris corregido',status:'PENDIENTE',arrivalAt:'',_fieldTimes:{}};
  const saved=await persist({code:'123456',workers:[parsed]},'roster');
  assert.equal(saved.workers[0].id,'NEW');
  assert.equal(saved.workers[0].status,'PRESENTE');
  assert.equal(saved.workers[0].arrivalAt,'08:04');
  assert.deepEqual(saved.workers[0]._fieldTimes,{status:3,arrivalAt:2});
  const revised=await persist({code:'123456',workers:[{...parsed,personal:'Pau',movil:'600333333'}]},'roster');
  const retained=revised.workers.find(w=>w.id==='NEW');
  assert.equal(retained.pdfRosterMissing,true);
  assert.equal(retained.status,'PRESENTE');
  assert.equal(retained.arrivalAt,'08:04');
  assert.equal(revised.workers.find(w=>w.personal==='Pau').status,'PENDIENTE');
  assert.notEqual(revised.workers.find(w=>w.personal==='Pau').id,retained.id);
  const restored=await persist({code:'123456',workers:[parsed]},'roster');
  assert.equal(restored.workers.length,2);
  assert.equal(restored.workers.find(w=>w.personal==='Pau').pdfRosterMissing,true);
  assert.equal(restored.workers[0].id,'NEW');
  assert.equal(restored.workers[0].pdfRosterMissing,false);
  assert.equal(restored.workers[0].status,'PRESENTE');
});

test('creating a scenario cannot replace pending attendance in the current view',()=>{
  const worker={id:'W1',status:'PRESENTE'};
  const state={service:{code:'123456',workers:[worker],teams:[],scenarios:[]}};
  const backend={run:{
    withSuccessHandler(handler){this.done=handler;return this;},
    withFailureHandler(){return this;},
    addScenario(){this.done({code:'123456',workers:[{id:'W1',status:'PENDIENTE'}],teams:[],scenarios:[{id:'S1'}]});}
  }};
  const noop=()=>{};
  const add=new Function('state','backend','crewSnapshotIsOlder','renderScenarios','updateTeamSelects','renderPersonnel','setSaveState',
    section('function addScenario(){','function renameScenario')+';return addScenario')(
    state,backend,()=>false,noop,noop,noop,noop);
  add();
  assert.equal(state.service.workers[0],worker);
  assert.equal(state.service.workers[0].status,'PRESENTE');
  assert.equal(state.service.scenarios[0].id,'S1');
});


test('importing a separate day keeps all earlier workers, check-ins and PDF references',async()=>{
  const source=section('function crewUniqueWorkerIds','const crewSaveLatest=');
  const prior={...recoveryWorker,serviceDate:'14/11/2026',status:'PRESENTE',arrivalAt:'08:19'};
  const today={...prior,serviceDate:'15/11/2026',status:'PENDIENTE',arrivalAt:''};
  let cloud={code:'123456',workers:[prior],pdfDocuments:{'14/11/2026':'old-pdf'},blocks:[{id:'B1',serviceDate:prior.serviceDate}]};
  const api=async(code,method='GET',body)=>{
    if(method==='GET')return {service:structuredClone(cloud)};
    cloud={...body.service,_syncRevision:'R2'};
    return {ok:true,revision:'R2',service:cloud};
  };
  const persist=new Function('crewApi','crypto','normalize','crewReviewPdfMissingWorkers',
    'let crewSaveQueue=Promise.resolve(),crewLastLocalWrite=0;'+source+';return crewPersist')(
    api,{randomUUID},s=>String(s||'').trim().toUpperCase(),
    async workers=>new Map(workers.map(w=>[String(w.id),'keep'])));
  const saved=await persist({code:'123456',workers:[today],blocks:[{id:'new:B1',serviceDate:today.serviceDate}],
    pdfDocumentId:'new-pdf',pdfDocumentDates:[today.serviceDate]},'roster');
  assert.deepEqual(saved.workers[0],prior);
  assert.notEqual(saved.workers[1].id,prior.id);
  assert.deepEqual(saved.pdfDocuments,{'14/11/2026':'old-pdf','15/11/2026':'new-pdf'});
  assert.equal(saved.blocks.length,2);
});


test('a slow visibility save cannot resurrect a hidden group or discard a newer click',async()=>{
  const source=section("const CREW_VISIBILITY_PREFIX=", "function crewRemoveHiddenSelections");
  const state={service:{code:'123456',hiddenWorkTypes:[],workers:[{id:'1',status:'PRESENTE'}]}};
  let cloud={...state.service,hiddenWorkTypes:['Catering']};
  let release;
  const wait=new Promise(resolve=>{release=resolve;});
  const storage=new Map();
  const noop=()=>{};
  const view=new Function('state','navigator','window','crypto','normalize','crewReadLocal','crewWriteLocal','crewSaveLatest',
    'crewSnapshotIsOlder','renderPersonnel','renderOperationalWorkFilters','setSaveState','isWorkTypeHidden','setInterval',
    source+';return {hideWorkType,restoreWorkType,crewVisibilityJournal,crewApplyVisibility,crewSyncWorkVisibility}')
  (state,{onLine:true},{addEventListener:noop,setInterval:noop},{randomUUID},x=>x.toUpperCase(),(p,c)=>storage.get(p+c),
    (p,c,data)=>storage.set(p+c,structuredClone(data)),async(c,update)=>{await wait;cloud=update(cloud);return cloud;},
    ()=>false,noop,noop,noop,work=>state.service.hiddenWorkTypes.includes(work),noop);
  view.hideWorkType('Load In');
  const pending=view.crewSyncWorkVisibility('123456');
  assert.deepEqual(view.crewApplyVisibility(cloud,view.crewVisibilityJournal('123456')).hiddenWorkTypes,['Catering','Load In']);
  view.restoreWorkType('Load In');
  view.hideWorkType('Audio');
  release();
  await pending;
  assert.deepEqual(state.service.hiddenWorkTypes,['Catering','Audio']);
  await view.crewSyncWorkVisibility('123456');
  assert.deepEqual(cloud.hiddenWorkTypes,['Catering','Audio']);
  assert.deepEqual(cloud.workers,[{id:'1',status:'PRESENTE'}]);
});

test('a confirmed newer attendance choice resolves the old warning and preserves other pending edits',()=>{
  const source=section('function crewMergeUpdate','function crewCacheRoster');
  const old={...recoveryEdit,arrivalAt:'08:00',teamId:'audio',
    _fieldTimes:{status:100,arrivalAt:100,teamId:100},_baseFieldTimes:{status:0,arrivalAt:0,teamId:0}};
  const newer={...recoveryEdit,status:'NO PRESENTADO',arrivalAt:'',
    _fieldTimes:{status:101,arrivalAt:101},_baseFieldTimes:{status:1,arrivalAt:1}};
  const written=new Map();
  const state={service:{code:'123456',workers:[{id:'OLD',...recoveryIdentity}]},pendingWorkerUpdates:{}};
  const ack=new Function('state','crewPendingJournal','crewWriteLocal','CREW_PENDING_PREFIX',
    'crewPendingIdentityMatches','crewSnapshotIsOlder','crewHeldJournal','CREW_HELD_PREFIX',
    source+';return crewAckJournal')(state,()=>({}),(p,c,data)=>written.set(p,structuredClone(data)),
    'pending:',(a,b)=>a?.personal===b?.personal,()=>false,()=>({OLD:old}),'held:');
  ack('123456',[newer],{ok:true,confirmedVersions:{OLD:{status:2,arrivalAt:2}}});
  assert.equal(written.get('held:').OLD.status,undefined);
  assert.equal(written.get('held:').OLD.arrivalAt,undefined);
  assert.equal(written.get('held:').OLD.teamId,'audio');
});

test('closing one day protects its records and PDF while other days remain editable',()=>{
 const day='01/11/2026',openDay='02/11/2026';
 const closed={closedDays:{[day]:'2026-11-01T22:00:00Z'},
   workers:[{id:'A',serviceDate:'1/11/2026',status:'PRESENTE'},{id:'B',serviceDate:openDay,status:'PENDIENTE'}],
   pdfDocuments:{[day]:{id:'final'}}};
 const openDayEdited=structuredClone(closed);
 openDayEdited.workers[1].status='PRESENTE';
 openDayEdited.pdfDocuments[openDay]={id:'draft'};
 assert.equal(closedDayChanged(closed,openDayEdited),false);
 const workerEdited=structuredClone(closed);
 workerEdited.workers[0].status='PENDIENTE';
 assert.equal(closedDayChanged(closed,workerEdited),true);
 assert.equal(closedDayChanged(closed,{...closed,closedDays:{}}),true);
 assert.equal(closedDayChanged(closed,{...closed,pdfDocuments:{}}),true);
});

test('a closed day can only be reopened explicitly and without editing it in the same save',()=>{
 const day='01/11/2026',other='02/11/2026';
 const closed={closedDays:{[day]:'2026-11-01T22:00:00Z',[other]:'2026-11-02T22:00:00Z'},
   workers:[{id:'A',serviceDate:day,status:'PRESENTE'},{id:'B',serviceDate:other,status:'PRESENTE'}]};
 const reopened={...structuredClone(closed),closedDays:{[other]:closed.closedDays[other]}};
 assert.equal(closedDayChanged(closed,reopened),true);
 assert.equal(closedDayChanged(closed,reopened,day),false);
 assert.equal(closedDayChanged(closed,reopened,'1/11/2026'),false);
 const reopenedAndEdited=structuredClone(reopened);
 reopenedAndEdited.workers[0].status='PENDIENTE';
 assert.equal(closedDayChanged(closed,reopenedAndEdited,day),true);
 assert.equal(closedDayChanged(closed,{...closed,closedDays:{}},day),true);
 assert.equal(closedDayChanged(closed,reopened,'03/11/2026'),true);
});

test('PDF continuation pages keep the table columns and use the actual service day',async()=>{
  const source=section('function extractPdfReference(', 'function crewDayKey(');
  const item=(str,x,y,width=35)=>({str,width,transform:[1,0,0,1,x,y]});
  const header=[['NOMBRE',70],['ESPECIALIDAD',280],['H.LLAM.',470],['INICIO',530],
    ['FIN',590],['PAUSA',650],['N.DIETA',710],['CS',765],['TELÉFONO',810],['MÓVIL',890]]
    .map(([label,x])=>item(label,x,800));
  const row=(number,name,pause)=>[
    item(String(number),15,760,8),item(name,70,760,160),item('HAND B',280,760),
    ...['07:45','08:00','18:00',pause,'1:00'].map((value,i)=>item(value,470+i*60,760)),
    item('600000123',890,760,58)
  ];
  const pages=[[
    item('FECHA SERVICIO: 15-21/11/2026',20,960,200),
    item('FECHA SERVICIO: 17/11/2026',20,900,200),
    item('TRABAJO: TECNICA',470,850,180),...header,...row(1,'PERSONA PRIMERA','1:00')
  ],row(2,'PERSONA SEGUNDA','2:00')];
  const pdfjsLib={getDocument:()=>({promise:Promise.resolve({numPages:2,getPage:async number=>({
    getViewport:()=>({width:1000}),getTextContent:async()=>({items:pages[number-1]})
  })})})};
  const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase();
  const parse=new Function('pdfjsLib','normalize',source+'return parsePennyWisePdf;')(pdfjsLib,normalize);
  const parsed=await parse({arrayBuffer:async()=>new ArrayBuffer(0)});
  assert.equal(parsed.meta.serviceDate,'17/11/2026');
  assert.equal(parsed.workers.length,2);
  assert.equal(parsed.workers[1].personal,'PERSONA SEGUNDA');
  assert.equal(parsed.workers[1].nDieta,1);
  assert.equal(parsed.workers[1].pausa,'02:00');
  assert.equal(parsed.workers[1].movil,'600000123');
  assert.equal(parsed.blocks.length,1);
});

test('a verified worker can move work type on PDF update without losing check-in or assignments',async()=>{
  const source=section('function crewUniqueWorkerIds','const crewSaveLatest=');
  const worker={...recoveryWorker,serviceDate:'17/11/2026',trabajo:'LOCAL',status:'PRESENTE',
    arrivalAt:'07:55',teamId:'audio',notes:'Conservar',_fieldTimes:{status:2}};
  let cloud={code:'123456',workers:[worker]};
  const api=async(code,method='GET',body)=>{
    if(method==='GET')return {service:structuredClone(cloud)};
    cloud={...body.service,_syncRevision:'R2'};
    return {ok:true,revision:'R2',service:cloud};
  };
  const persist=new Function('crewApi','crypto','normalize','crewReviewPdfMissingWorkers',
    'let crewSaveQueue=Promise.resolve(),crewLastLocalWrite=0;'+source+';return crewPersist')(
    api,{randomUUID},s=>String(s||'').trim().toUpperCase(),
    async workers=>new Map(workers.map(w=>[String(w.id),'keep'])));
  const revised={...worker,id:'PDF_CHANGED',trabajo:'TECNICA',inicio:'09:00',status:'PENDIENTE',arrivalAt:''};
  const saved=await persist({code:'123456',workers:[revised]},'roster');
  assert.equal(saved.workers[0].id,worker.id);
  assert.equal(saved.workers[0].trabajo,'TECNICA');
  assert.equal(saved.workers[0].inicio,'09:00');
  assert.equal(saved.workers[0].status,'PRESENTE');
  assert.equal(saved.workers[0].arrivalAt,'07:55');
  assert.equal(saved.workers[0].teamId,'audio');
  assert.equal(saved.workers[0].notes,'Conservar');
  assert.deepEqual(saved.workers[0]._fieldTimes,{status:2});
  const phoneChanged=await persist({code:'123456',workers:[{...revised,movil:'600222333'}]},'roster');
  assert.equal(phoneChanged.workers.length,2);
  assert.equal(phoneChanged.workers.find(w=>w.id===worker.id).pdfRosterMissing,true);
  assert.equal(phoneChanged.workers.find(w=>w.movil==='600222333').status,'PENDIENTE');
});

test('PDF import waits for pending edits and the roster receipt, and prevents overlapping imports',async()=>{
  const source=section('let crewPdfImportInFlight=false;', 'function extractPdfReference(');
  let releaseFlush,releaseSave;
  const flush=new Promise(resolve=>{releaseFlush=resolve;});
  const save=new Promise(resolve=>{releaseSave=resolve;});
  const worker={id:'W1',serviceDate:'17/11/2026',personal:'Persona Prueba'};
  const service={code:'123456',workers:[worker]};
  const state={service:{code:'123456',workers:[]}},app={inert:false},calls=[];
  const noop=()=>{};
  const scope={state,document:{getElementById:()=>app},confirm:()=>true,showPdfStatus:noop,
    setSaveState:message=>calls.push(message),crewWorkerFlushPromise:Promise.resolve(),
    crewFlushServiceChanges:()=>flush,ensurePdfJs:noop,clearTimeout,
    parsePennyWisePdf:async()=>{calls.push('parse');return {meta:{},workers:[{...worker}],blocks:[]};},
    crewServiceDays:()=>[],crewDayKey:day=>day,crewDayClosed:()=>false,
    crypto:{randomUUID},fetch:async()=>({ok:true}),
    dispatchBackend:async()=>{calls.push('save');return save;},
    openServiceData:s=>{state.service=s;},getDays:()=>[worker.serviceDate],setActiveDay:noop,
    updatePdfPlacementUI:noop,workersForActiveDay:()=>[worker],renderPersonnel:noop,
    escapeHtml:x=>x,showPdfStatusHtml:noop,errorMessage:e=>e.message};
  const importPdf=new Function(...Object.keys(scope),source+'return importPdf;')(...Object.values(scope));
  let completed=false;
  const pending=importPdf({name:'personal.pdf'}).then(()=>{completed=true;});
  await new Promise(setImmediate);
  assert.equal(app.inert,true);
  assert.ok(!calls.includes('parse'));
  releaseFlush();
  await new Promise(setImmediate);
  assert.equal(calls.filter(x=>x==='parse').length,1);
  assert.ok(calls.includes('save'));
  assert.equal(completed,false);
  await importPdf({name:'segundo.pdf'});
  assert.equal(calls.filter(x=>x==='parse').length,1);
  releaseSave({service,summary:{added:1}});
  await pending;
  assert.equal(app.inert,false);
  assert.equal(state.service,service);
  assert.equal(calls.at(-1),'PDF importado y guardado');
});


test('five unmatched checked-in people survive a revised PDF with teams, shifts and notes intact',async()=>{
  const source=section('function crewUniqueWorkerIds','const crewSaveLatest=');
  const originals=Array.from({length:5},(_,index)=>({...recoveryWorker,id:'W'+index,
    personal:'Persona '+index,movil:'60000000'+index,serviceDate:'17/11/2026',
    status:'PRESENTE',arrivalAt:'07:55',teamId:'T1',notes:'Conservar '+index,
    blockId:'OLD',_fieldTimes:{status:2,arrivalAt:1}}));
  let cloud={code:'123456',workers:originals,blocks:[{id:'OLD',serviceDate:'17/11/2026'}],
    pauseShifts:[{id:'P',workerIds:['W0','W1'],returnStatuses:{W0:'PRESENTE'}}]};
  const api=async(code,method='GET',body)=>{
    if(method==='GET')return {service:structuredClone(cloud)};
    cloud={...body.service,_syncRevision:'R2'};
    return {ok:true,revision:'R2',service:cloud};
  };
  const persist=new Function('crewApi','crypto','normalize','crewReviewPdfMissingWorkers',
    'let crewSaveQueue=Promise.resolve(),crewLastLocalWrite=0;'+source+';return crewPersist')(
    api,{randomUUID},s=>String(s||'').trim().toUpperCase(),
    async workers=>new Map(workers.map(w=>[String(w.id),'keep'])));
  const revised={...originals[0],personal:'Persona Nueva',movil:'611000000',id:'W0'};
  const saved=await persist({code:'123456',workers:[revised],blocks:[{id:'NEW',serviceDate:'17/11/2026'}]},'roster');
  assert.equal(saved.workers.length,6);
  assert.equal(new Set(saved.workers.map(w=>w.id)).size,6);
  for(const old of originals)assert.deepEqual(saved.workers.find(w=>w.id===old.id),{...old,pdfRosterMissing:true});
  assert.equal(saved.workers.find(w=>w.personal==='Persona Nueva').status,'PENDIENTE');
  assert.deepEqual(saved.pauseShifts,[{id:'P',workerIds:['W0','W1'],returnStatuses:{W0:'PRESENTE'}}]);
  assert.deepEqual(saved.blocks.map(b=>b.id),['OLD','NEW']);
});

test('PDF review removes only chosen rows, cancels without saving and rechecks concurrent edits',async()=>{
  const source=section('function crewUniqueWorkerIds','const crewSaveLatest=');
  const a={...recoveryWorker,id:'A',personal:'Persona A',serviceDate:'17/11/2026',status:'PRESENTE',arrivalAt:'08:00'};
  const b={...a,id:'B',personal:'Persona B',movil:'600000002'};
  const imported={...a,id:'NEW',personal:'Persona Nueva',movil:'600000003'};
  const setup=(review,conflict=false)=>{
    let cloud={code:'123456',workers:[a,b],pauseShifts:[{id:'P',workerIds:['A','B']}],incidents:[{id:'I',workerId:'B'}]};
    let writes=0;
    const api=async(code,method='GET',body)=>{
      if(method==='GET')return {service:structuredClone(cloud)};
      writes++;
      if(conflict&&writes===1){
        cloud.workers=cloud.workers.map(w=>w.id==='B'?{...w,notes:'Cambió en otro dispositivo'}:w);
        throw Object.assign(new Error('Conflicto'),{status:409});
      }
      cloud=body.service;
      return {service:cloud};
    };
    const persist=new Function('crewApi','crypto','normalize','crewReviewPdfMissingWorkers',
      'let crewSaveQueue=Promise.resolve(),crewLastLocalWrite=0;'+source+';return crewPersist')(
      api,{randomUUID},s=>String(s||'').trim().toUpperCase(),review);
    return {run:()=>persist({code:'123456',workers:[imported]},'roster'),writes:()=>writes};
  };
  const mixed=setup(async workers=>new Map(workers.map(w=>[w.id,w.id==='A'?'keep':'remove'])));
  const saved=await mixed.run();
  assert.ok(saved.workers.some(w=>w.id==='A'&&w.pdfRosterMissing));
  assert.ok(!saved.workers.some(w=>w.id==='B'));
  assert.deepEqual(saved.pauseShifts[0].workerIds,['A']);
  assert.equal(saved.incidents[0].workerId,'');
  const cancelled=setup(async()=>{throw new Error('Importación cancelada');});
  await assert.rejects(cancelled.run(),/cancelada/);
  assert.equal(cancelled.writes(),0);
  const reviewed=[];
  const concurrent=setup(async workers=>{
    reviewed.push(workers.map(w=>w.id));
    return new Map(workers.map(w=>[w.id,w.notes?'keep':'remove']));
  },true);
  const updated=await concurrent.run();
  assert.deepEqual(reviewed,[['A','B'],['B']]);
  assert.ok(!updated.workers.some(w=>w.id==='A'));
  assert.equal(updated.workers.find(w=>w.id==='B').notes,'Cambió en otro dispositivo');
});

test('reference cleanup leaves closed-day pauses byte-for-byte intact when their workers remain',()=>{
  const {crewPruneWorkerReferences}=helpers();
  const snapshot={closedDays:{'17/11/2026':'2026-11-17T22:00:00Z'},
    workers:[{id:'A',serviceDate:'17/11/2026'},{id:'B',serviceDate:'18/11/2026'}],
    pauseShifts:[{id:'P',serviceDate:'17/11/2026',workerIds:['A']}],incidents:[]};
  const cleaned=crewPruneWorkerReferences(snapshot);
  assert.deepEqual(cleaned.pauseShifts,snapshot.pauseShifts);
  assert.equal(closedDayChanged(snapshot,cleaned),false);
});

test('PDF removal review includes pending workers with assignments and notes',async()=>{
  const source=section('function crewUniqueWorkerIds','const crewSaveLatest=');
  const pending={...recoveryWorker,status:'PENDIENTE',arrivalAt:'',teamId:'AUDIO',notes:'Asignación manual'};
  let cloud={code:'123456',workers:[pending]};
  let reviewed=[];
  const api=async(code,method='GET',body)=>{
    if(method==='GET')return {service:structuredClone(cloud)};
    cloud=body.service;
    return {service:cloud};
  };
  const persist=new Function('crewApi','crypto','normalize','crewReviewPdfMissingWorkers',
    'let crewSaveQueue=Promise.resolve(),crewLastLocalWrite=0;'+source+';return crewPersist')(
    api,{randomUUID},s=>String(s||'').trim().toUpperCase(),async workers=>{
      reviewed=workers;
      return new Map(workers.map(w=>[String(w.id),'keep']));
    });
  const saved=await persist({code:'123456',workers:[{...pending,id:'NEWPERSON',personal:'Otro trabajador',movil:'611222333'}]},'roster');
  assert.equal(reviewed.length,1);
  assert.deepEqual(saved.workers.find(w=>w.id===pending.id),{...pending,pdfRosterMissing:true});
});

test('a late manager refresh cannot replace a newer list or restore the list after logout',async()=>{
  const source=section('async function crewRefreshManager(){','async function crewManagerLogout(){');
  let releaseOld;
  const old=new Promise(resolve=>{releaseOld=resolve;});
  const responses=[old,Promise.resolve({services:[{code:'NEW'}]})];
  const rendered=[],views=[];
  const scope={crewManagerApi:()=>responses.shift(),crewManagerView:mode=>views.push(mode),
    managerUI:{status:{},list:{replaceChildren:fragment=>rendered.push(fragment.children)}},
    document:{createDocumentFragment:()=>({children:[],append(value){this.children.push(value);}})},
    crewManagerCard:service=>service.code,crewApplyManagerFilters:()=>{}};
  const ui=new Function(...Object.keys(scope),
    'let crewManagerRequestVersion=0,crewManagerServices=[];'+source+
    ';return {refresh:crewRefreshManager,invalidate(){crewManagerRequestVersion++;}};')(...Object.values(scope));
  const first=ui.refresh();
  await ui.refresh();
  releaseOld({services:[{code:'OLD'}]});
  await first;
  assert.deepEqual(rendered,[['NEW']]);
  let releaseLoggedOut;
  responses.push(new Promise(resolve=>{releaseLoggedOut=resolve;}));
  const afterLogout=ui.refresh();
  ui.invalidate();
  releaseLoggedOut({services:[{code:'EXPIRED'}]});
  await afterLogout;
  assert.deepEqual(rendered,[['NEW']]);
  assert.deepEqual(views,['services']);
});
