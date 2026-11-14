import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import worker,{deviceChanges} from '../src/index.js';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
test('device age switches from seconds to whole minutes at 300 seconds',()=>{
 const source=html.slice(html.indexOf('function crewDeviceAge('),html.indexOf('let crewActivityRequest='));
 const age=new Function(source+';return crewDeviceAge')();
 assert.equal(age(299),'299 s');assert.equal(age(300),'5 minutos');
 assert.equal(age(359),'5 minutos');assert.equal(age(413),'6 minutos');
});
test('activity describes attendance and team names, ignores version-only updates',()=>{
 const before={workers:[{id:'W1',personal:'Chris',status:'PENDIENTE',teamId:'T1',_fieldTimes:{status:1}}],teams:[{id:'T1',name:'Luces'},{id:'T2',name:'Sonido'}]};
 const after=structuredClone(before);after.workers[0]._fieldTimes.status=2;
 assert.deepEqual(deviceChanges(before,after),[]);
 after.workers[0].status='PRESENTE';after.workers[0].teamId='T2';
 assert.deepEqual(deviceChanges(before,after),[
  {person:'Chris',field:'status',before:'PENDIENTE',after:'PRESENTE'},
  {person:'Chris',field:'teamId',before:'Luces',after:'Sonido'}]);
});

test('SQLite transaction logs only accepted writes and scopes history to service and device',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'crew-audit-'));
 const dbPath=join(dir,'test.db');
 const sql=(statements)=>JSON.parse(execFileSync('python',['-c',`
import sqlite3,json,sys
con=sqlite3.connect(sys.argv[1]);con.row_factory=sqlite3.Row
out=[]
try:
 for item in json.load(sys.stdin):
  cursor=con.execute(item['sql'],item.get('args',[]))
  out.append({'results':[dict(row) for row in cursor.fetchall()],'meta':{'changes':max(cursor.rowcount,0)}})
 con.commit()
except:
 con.rollback();raise
print(json.dumps(out))
`,dbPath],{input:JSON.stringify(statements),encoding:'utf8'}));
 const DB={prepare(query){return {sql:query,args:[],bind(...args){this.args=args;return this;},
  async first(){return sql([this])[0].results[0]||null;},async all(){return sql([this])[0];},async run(){return sql([this])[0];}};},async batch(items){return sql(items);}};
 try{
  sql([
   {sql:'CREATE TABLE services(id TEXT PRIMARY KEY,code TEXT,closed INTEGER)'},
   {sql:'CREATE TABLE service_snapshots(service_id TEXT PRIMARY KEY,snapshot TEXT,updated_at TEXT)'},
   {sql:'INSERT INTO services VALUES (?,?,0)',args:['S1','123456']},
   {sql:'INSERT INTO services VALUES (?,?,0)',args:['S2','654321']},
   ...readFileSync(new URL('../db/migrations/0003_device_activity.sql',import.meta.url),'utf8').split(';').filter(s=>s.trim()).map(s=>({sql:s}))
  ]);
  const call=(method,body,device='device_111',code='123456',format='snapshot')=>worker.fetch(new Request('https://example.test/api/services/'+code+'?format='+format+(format==='activity'?'&deviceId='+device:''),{
   method,headers:{'content-type':'application/json','x-service-code':code,...(device?{'x-device-id':device}:{})},...(body?{body:JSON.stringify(body)}:{})}),{DB});
  let snapshot={workers:[{id:'W1',personal:'Chris',status:'PENDIENTE'}]};
  let response=await call('PUT',{service:snapshot,revision:''});assert.equal(response.status,200);
  snapshot=(await response.json()).service;
  assert.equal(snapshot._syncSequence,1);
  const revision=snapshot._syncRevision;
  snapshot.workers[0].status='PRESENTE';
  snapshot.workers[0].arrivalAt='09:12';
  snapshot.workers[0]._fieldTimes={status:1,arrivalAt:1};
  response=await call('PUT',{service:snapshot,revision});assert.equal(response.status,200);
  snapshot=(await response.json()).service;
  assert.equal(snapshot._syncSequence,2);
  response=await call('PUT',{service:{...snapshot,workers:[{id:'W1',personal:'Chris',status:'NO PRESENTADO'}]},revision});
  assert.equal(response.status,409);
  let history=await (await call('GET',null,'device_111','123456','activity')).json();
  assert.equal(history.events.length,2);
  assert.ok(history.events.some(e=>e.changes.some(c=>c.before==='PENDIENTE'&&c.after==='PRESENTE')));
  assert.equal((await (await call('GET',null,'device_222','123456','activity')).json()).events.length,0);
  assert.equal((await (await call('GET',null,'device_111','654321','activity')).json()).events.length,0);
  for(const oldWorker of [
   {id:'W1',personal:'Chris',status:'PENDIENTE',teamId:'LIGHTS'},
   {...snapshot.workers[0],arrivalAt:'',teamId:'LIGHTS'}
  ]){
   const rollback=await call('PUT',{service:{...snapshot,workers:[oldWorker]},revision:snapshot._syncRevision});
   assert.equal(rollback.status,422,'a fresh service revision does not authorize stale attendance');
  }
  assert.equal((await (await call('GET')).json()).service._syncSequence,2);
  response=await call('PUT',{service:snapshot,revision:snapshot._syncRevision});
  assert.equal(response.status,200);snapshot=(await response.json()).service;
  assert.equal(snapshot._syncSequence,3);
  assert.equal((await (await call('GET',null,'device_111','123456','activity')).json()).events.length,2,'no-op saves do not create fake changes');
  const teamEdit={...snapshot,workers:[{...snapshot.workers[0],teamId:'LIGHTS'}],_syncSequence:500};
  response=await call('PUT',{service:teamEdit,revision:snapshot._syncRevision},'device_222');
  assert.equal(response.status,200);snapshot=(await response.json()).service;
  assert.equal(snapshot._syncSequence,4,'the server owns revision ordering');
  assert.equal(snapshot.workers[0].status,'PRESENTE');
  assert.equal(snapshot.workers[0].arrivalAt,'09:12');
  snapshot.workers[0].status='CONTACTADO';
  snapshot.workers[0].arrivalAt='';
  snapshot.workers[0]._fieldTimes={status:2,arrivalAt:2};
  response=await call('PUT',{service:snapshot,revision:snapshot._syncRevision},'');
  assert.equal(response.status,200,'older clients without a device header still save');
  // Exercise the browser writer against the real Worker and SQLite, with
  // two independent queues competing to save different workers at once.
  const section=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
  const source=section('function crewCanonicalWorkerPhone','const crewPersist=')+
    section('function crewPendingIdentityMatches','// Reconcile durable edits')+
    'return async function(method,args){'+section("  if(method==='saveWorkerChanges'){","  if(method==='addManualWorker'){")+'}';
  const code='654321';
  const roster=['Pau','Alex'].map((personal,i)=>({id:'W'+i,personal,serviceDate:'2026-11-14',
   trabajo:'LOAD IN',movil:'60012345'+i,inicio:'09:00',fin:'17:00',status:'PENDIENTE',arrivalAt:''}));
  assert.equal((await call('PUT',{service:{workers:roster},revision:''},'',code)).status,200);
  let conflicts=0;
  let firstWrites=0,releaseFirstWrites;
  const firstWriteBarrier=new Promise(resolve=>{releaseFirstWrites=resolve;});
  function client(device){
   const api=async(_,method='GET',payload)=>{
    if(method==='PUT'&&firstWrites<2){
     if(++firstWrites===2)releaseFirstWrites();
     await firstWriteBarrier;
    }
    const res=await call(method,payload,device,code);
    const data=await res.json();
    if(!res.ok){
     if(res.status===409)conflicts++;
     throw Object.assign(new Error(data.error),{status:res.status});
    }
    return data;
   };
   return new Function('crewApi','code','let crewSaveQueue=Promise.resolve(),crewLastLocalWrite=0;'+source)(api,code);
  }
  const mac=client('device_mac'),tablet=client('device_tablet');
  await Promise.all([mac,tablet].map((dispatch,i)=>dispatch('saveWorkerChanges',[code,[{
   workerId:roster[i].id,_workerIdentity:roster[i],status:'PRESENTE',arrivalAt:'09:0'+i,
   _fieldTimes:{status:123,arrivalAt:123},_baseFieldTimes:{status:0,arrivalAt:0}
  }]])));
  const concurrent=(await (await call('GET',null,'',code)).json()).service;
  assert.ok(conflicts>0,'competing requests must exercise a retry');
  assert.equal(concurrent._syncSequence,3);
  assert.deepEqual(concurrent.workers.map(row=>[row.status,row.arrivalAt]),[['PRESENTE','09:00'],['PRESENTE','09:01']]);
  const denied=await worker.fetch(new Request('https://example.test/api/services/123456?format=activity&deviceId=device_111',{headers:{'x-service-code':'654321'}}),{DB});
  assert.equal(denied.status,403);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
