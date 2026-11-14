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
  const revision=snapshot._syncRevision;
  snapshot.workers[0].status='PRESENTE';
  response=await call('PUT',{service:snapshot,revision});assert.equal(response.status,200);
  snapshot=(await response.json()).service;
  response=await call('PUT',{service:{...snapshot,workers:[{id:'W1',personal:'Chris',status:'NO PRESENTADO'}]},revision});
  assert.equal(response.status,409);
  let history=await (await call('GET',null,'device_111','123456','activity')).json();
  assert.equal(history.events.length,2);
  assert.ok(history.events.some(e=>e.changes.some(c=>c.before==='PENDIENTE'&&c.after==='PRESENTE')));
  assert.equal((await (await call('GET',null,'device_222','123456','activity')).json()).events.length,0);
  assert.equal((await (await call('GET',null,'device_111','654321','activity')).json()).events.length,0);
  response=await call('PUT',{service:snapshot,revision:snapshot._syncRevision});
  assert.equal(response.status,200);snapshot=(await response.json()).service;
  assert.equal((await (await call('GET',null,'device_111','123456','activity')).json()).events.length,2,'no-op saves do not create fake changes');
  snapshot.workers[0].status='CONTACTADO';
  response=await call('PUT',{service:snapshot,revision:snapshot._syncRevision},'');
  assert.equal(response.status,200,'older clients without a device header still save');
  const denied=await worker.fetch(new Request('https://example.test/api/services/123456?format=activity&deviceId=device_111',{headers:{'x-service-code':'654321'}}),{DB});
  assert.equal(denied.status,403);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
