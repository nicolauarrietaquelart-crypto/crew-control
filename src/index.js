import {manager} from './manager.js';
const json=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra}});
const err=(message,status=400)=>json({ok:false,error:message},status);
async function body(request){const value=await request.json();if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid JSON object');return value}
const str=(v,max=500)=>String(v??'').slice(0,max);
const snapshotConflict=()=>err('Otro dispositivo ha modificado este servicio. Actualiza para sincronizar antes de guardar.',409);

// A valid service revision is necessary, but a full snapshot can still carry
// an older copy of a row. Check attendance versions before any D1 write.
function attendanceVersionsAreValid(before,after){
 const workers=new Map();
 for(const worker of before.workers||[]){
  const id=String(worker.id||'').trim();
  workers.set(id,workers.has(id)?null:worker);
 }
 for(const worker of after.workers){
  const old=workers.get(String(worker.id||'').trim());
  if(!old)continue;
  for(const field of ['status','arrivalAt']){
   const previousVersion=Number(old._fieldTimes?.[field]||0);
   const nextVersion=Number(worker._fieldTimes?.[field]||0);
   const changed=worker[field]!==old[field];
   if(!Number.isSafeInteger(nextVersion)||nextVersion!==previousVersion+Number(changed))return false;
  }
 }
 return true;
}

// Record only differences accepted by the snapshot compare-and-swap.
export function deviceChanges(before,after){
 const changes=[];
 const previous=new Map((before.workers||[]).map(w=>[String(w.id),w]));
 const current=new Set((after.workers||[]).map(w=>String(w.id)));
 const value=v=>v===undefined||v===null||v===''?'—':typeof v==='boolean'?(v?'Sí':'No'):String(v).slice(0,200);
 for(const worker of after.workers||[]){
  const old=previous.get(String(worker.id));
  const person=str(worker.personal,200);
  if(!old){changes.push({person,field:'workerAdded',after:person});continue;}
  for(const key of new Set([...Object.keys(old),...Object.keys(worker)])){
   if(key==='id'||key.startsWith('_')||key==='sortOrder'||(worker[key]!==null&&typeof worker[key]==='object'))continue;
   if(JSON.stringify(old[key])===JSON.stringify(worker[key]))continue;
   const display=(snapshot,v)=>key==='teamId'?(snapshot.teams||[]).find(t=>t.id===v)?.name||value(v):
    key==='scenarioId'?(snapshot.scenarios||[]).find(t=>t.id===v)?.name||value(v):value(v);
   changes.push({person,field:key,before:display(before,old[key]),after:display(after,worker[key])});
  }
 }
 for(const worker of before.workers||[])if(!current.has(String(worker.id)))changes.push({person:str(worker.personal,200),field:'workerRemoved'});
 for(const key of ['serviceName','serviceDate','venue','closed','closedDays','teams','scenarios','incidents','requirements','pauseShifts','workOrder','hiddenWorkTypes']){
  if(JSON.stringify(before[key])===JSON.stringify(after[key]))continue;
  changes.push({field:key,...(Array.isArray(after[key])?{after:'Actualizado'}:{before:value(before[key]),after:value(after[key])})});
 }
 return changes;
}
function dayKey(value){
 const date=String(value||'SIN FECHA');
 const match=date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
 return match?match[1].padStart(2,'0')+'/'+match[2].padStart(2,'0')+'/'+match[3]:date;
}

// reopenDay: an explicit request to reopen one closed day. Only its closedDays
// entry may disappear; its workers, pauses and PDFs must stay unchanged in the
// same save. Without it, a missing closed day is a stale snapshot and rejected.
export function closedDayChanged(previous,next,reopenDay=''){
 const closed=previous.closedDays||{};
 const keys=new Set(Object.keys(closed));
 if(!keys.size)return false;
 const reopen=reopenDay?dayKey(reopenDay):'';
 if(reopen&&!keys.has(reopen))return true;
 if([...keys].some(day=>day===reopen?next.closedDays?.[day]!==undefined:next.closedDays?.[day]!==closed[day]))return true;
 for(const field of ['workers','pauseShifts','requirements','incidents','blocks']){
  const scoped=service=>(Array.isArray(service[field])?service[field]:[])
   .filter(entry=>keys.has(dayKey(entry?.serviceDate)));
  if(JSON.stringify(scoped(previous))!==JSON.stringify(scoped(next)))return true;
 }
 const scopedKeys=(service,field,keyOf)=>Object.entries(service[field]||{})
  .filter(([key])=>keys.has(dayKey(keyOf(key)))).sort(([a],[b])=>a.localeCompare(b));
 for(const [field,keyOf] of [['pdfDocuments',key=>key],['staffingLinkedWorks',key=>key.split('|')[0]]]){
  if(JSON.stringify(scopedKeys(previous,field,keyOf))!==JSON.stringify(scopedKeys(next,field,keyOf)))return true;
 }
 return false;
}

export default {
 async fetch(request,env){
  const url=new URL(request.url),p=url.pathname,m=request.method;
  if(!p.startsWith('/api/'))return env.ASSETS.fetch(request);
  if(p==='/api/health'&&m==='GET'){
   if(!env.DB)return err('D1 binding DB missing',503);
   try{await env.DB.prepare('SELECT 1').first();return json({ok:true,database:'d1'})}catch{return err('D1 unavailable',503)}
  }
  if(!env.DB)return err('D1 not configured',503);
  if(p.startsWith('/api/manager/')){
   try{return await manager(request,env,url);}catch{return err('Error en el acceso de gestor.',500);}
  }
  const accessCode=str(request.headers.get('x-service-code'),100).trim();
  if(!/^(?:\d{6}|[A-Za-z0-9_-]{12,80})$/.test(accessCode))return err('Código de servicio no válido',403);
  try{
   if(p==='/api/services'&&m==='POST'){
    const v=await body(request),id=crypto.randomUUID();
    const existing=await env.DB.prepare('SELECT id,code FROM services WHERE code=?').bind(accessCode).first();
    if(existing)return err('Este código ya existe; genera otro',409);
    await env.DB.prepare('INSERT INTO services(id,code,name,service_date,venue) VALUES(?,?,?,?,?)').bind(id,accessCode,str(v.name,200),str(v.service_date,20),str(v.venue,200)).run();
    return json({ok:true,id,code:accessCode},201);
   }
   const match=p.match(/^\/api\/services\/([^/]+)(?:\/(workers|teams|scenarios|incidents|requirements|pdf))?$/);
   if(match){
    const code=decodeURIComponent(match[1]),section=match[2];
    if(code!==accessCode)return err('Código de servicio incorrecto',403);
    const service=await env.DB.prepare('SELECT * FROM services WHERE code=? AND deleted_at IS NULL').bind(code).first();
    if(!service)return err('Service not found',404);
    if(section==='pdf'){
      const file=url.searchParams.get('file')||'';
      if(file&&!/^[a-f0-9-]{36}$/.test(file))return err('Identificador de PDF no válido',400);
      if(m==='PUT'){
        const snapshot=await env.DB.prepare("SELECT json_extract(snapshot,'$.closed') closed, json_extract(snapshot,'$.pdfDocuments') pdfDocuments, json_extract(snapshot,'$.closedDays') closedDays FROM service_snapshots WHERE service_id=?").bind(service.id).first();
        if(snapshot?.closed??service.closed)return err('El servicio está cerrado',409);
        const closedDays=JSON.parse(snapshot?.closedDays||'{}');
        if(file&&Object.entries(JSON.parse(snapshot?.pdfDocuments||'{}')).some(([day,id])=>id===file&&closedDays[dayKey(day)])){
          return err('El PDF pertenece a un día cerrado.',422);
        }
        const bytes=new Uint8Array(await request.arrayBuffer());
        if(!bytes.byteLength||bytes.byteLength>8000000)return err('PDF vacío o superior a 8 MB',413);
        const name=str(decodeURIComponent(request.headers.get('x-pdf-filename')||'personal.pdf'),180).replace(/[\\/]/g,'_');
        if(bytes.length<5||bytes.subarray(0,5).some((b,i)=>b!==[37,80,68,70,45][i]))return err('El archivo no es un PDF válido',400);
        const writes=[env.DB.prepare('DELETE FROM service_pdf_chunks WHERE service_id=? AND document_key=?').bind(service.id,file)];
        const chunkSize=1000000;
        for(let offset=0;offset<bytes.length;offset+=chunkSize){
          writes.push(env.DB.prepare('INSERT INTO service_pdf_chunks(service_id,document_key,position,filename,content) VALUES(?,?,?,?,?)')
            .bind(service.id,file,offset/chunkSize,name,bytes.slice(offset,offset+chunkSize).buffer));
        }
        await env.DB.batch(writes);
        return json({ok:true,filename:name});
      }
      if(m==='GET'){
        const {results:chunks}=await env.DB.prepare('SELECT filename,content FROM service_pdf_chunks WHERE service_id=? AND document_key=? ORDER BY position').bind(service.id,file).all();
        if(chunks.length){
          return new Response(new Blob(chunks.map(row=>new Uint8Array(row.content))),{headers:{'content-type':'application/pdf','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(chunks[0].filename),'cache-control':'no-store'}});
        }
        if(!file)await env.DB.prepare('CREATE TABLE IF NOT EXISTS service_pdf_files (service_id TEXT PRIMARY KEY, filename TEXT NOT NULL, content BLOB NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)').run();
        const row=file?
          await env.DB.prepare('SELECT filename,content FROM service_pdf_documents WHERE service_id=? AND document_key=?').bind(service.id,file).first():
          await env.DB.prepare('SELECT filename,content FROM service_pdf_files WHERE service_id=?').bind(service.id).first();
        if(!row)return err('No hay un PDF original guardado para este servicio',404);
        return new Response(new Uint8Array(row.content),{headers:{'content-type':'application/pdf','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(row.filename),'cache-control':'no-store'}});
      }
    }
    // Active-device presence is service-scoped and deliberately separate from
    // the service snapshot, so heartbeat updates cannot overwrite attendance.
    if(!section&&url.searchParams.get('format')==='presence'&&(m==='GET'||m==='POST')){
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS service_device_presence (service_id TEXT NOT NULL, device_id TEXT NOT NULL, label TEXT NOT NULL, last_seen INTEGER NOT NULL, pending INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(service_id,device_id))').run();
      const now=Math.floor(Date.now()/1000);
      if(m==='POST'){
        const v=await body(request),deviceId=str(v.deviceId,100);
        if(!/^[a-zA-Z0-9_-]{8,100}$/.test(deviceId))return err('Invalid device ID',400);
        const label=str(v.label||'Dispositivo',90);
        const pending=Math.max(0,Math.min(99999,Number(v.pending)||0));
        await env.DB.prepare('INSERT INTO service_device_presence(service_id,device_id,label,last_seen,pending) VALUES(?,?,?,?,?) ON CONFLICT(service_id,device_id) DO UPDATE SET label=excluded.label,last_seen=excluded.last_seen,pending=excluded.pending').bind(service.id,deviceId,label,now,pending).run();
      }
      // Retain briefly disconnected devices for visibility; purge stale records.
      await env.DB.prepare('DELETE FROM service_device_presence WHERE service_id=? AND last_seen<?').bind(service.id,now-86400).run();
      const rows=await env.DB.prepare('SELECT device_id,label,last_seen,pending FROM service_device_presence WHERE service_id=? ORDER BY last_seen DESC LIMIT 80').bind(service.id).all();
      return json({ok:true,serverTime:now,devices:rows.results||[]});
    }
    if(!section&&m==='GET'&&url.searchParams.get('format')==='activity'){
      const deviceId=str(url.searchParams.get('deviceId'),100);
      if(!/^[a-zA-Z0-9_-]{8,100}$/.test(deviceId))return err('Invalid device ID',400);
      const rows=await env.DB.prepare('SELECT id,created_at,changes FROM service_device_activity WHERE service_id=? AND device_id=? ORDER BY created_at DESC,id DESC LIMIT 30').bind(service.id,deviceId).all();
      return json({ok:true,events:(rows.results||[]).map(row=>({...row,changes:JSON.parse(row.changes)}))});
    }
    // Cheap change probe for polling devices: only the revision, not the full
    // roster, so phones and tablets do not download/parse it every second.
    if(!section&&m==='GET'&&url.searchParams.get('format')==='revision'){
      const row=await env.DB.prepare("SELECT json_extract(snapshot,'$._syncRevision') revision, json_extract(snapshot,'$._syncSequence') sequence FROM service_snapshots WHERE service_id=?").bind(service.id).first();
      return json({ok:true,revision:row?.revision||'',sequence:Number(row?.sequence||0)});
    }
    if(!section&&m==='GET'&&url.searchParams.get('format')==='snapshot'){
      const row=await env.DB.prepare('SELECT snapshot FROM service_snapshots WHERE service_id=?').bind(service.id).first();
      return json({ok:true,service:row?.snapshot?JSON.parse(row.snapshot):{code:service.code,serviceName:service.name,serviceDate:service.service_date,venue:service.venue,closed:!!service.closed,workers:[],teams:[],scenarios:[],incidents:[],requirements:[],workOrder:[],hiddenWorkTypes:[]}});
    }
    if(!section&&m==='PUT'){
      if(service.closed)return err('Service is closed',409);
      const input=await body(request),snapshot=input.service;
      if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))return err('Invalid service snapshot');
      if(!Array.isArray(snapshot.workers))return err('Lista de trabajadores no válida',422);
      const uniqueWorkerIds=new Set();
      for(const worker of snapshot.workers){
       if(!worker||typeof worker!=='object'||Array.isArray(worker))return err('Registro de trabajador no válido',422);
       const id=String(worker.id||'').trim();
       if(!id||uniqueWorkerIds.has(id))return err('ID de trabajador vacío o duplicado. Guardado bloqueado para proteger los fichajes.',422);
       uniqueWorkerIds.add(id);
      }
      const expected=String(input.revision||'');
      const oldRow=await env.DB.prepare('SELECT snapshot FROM service_snapshots WHERE service_id=?').bind(service.id).first();
      const previous=oldRow?.snapshot?JSON.parse(oldRow.snapshot):{};
      if(String(previous._syncRevision||'')!==expected)return snapshotConflict();
      if(closedDayChanged(previous,snapshot,typeof input.reopenDay==='string'?input.reopenDay.slice(0,30):''))return err('Hay cambios en un día cerrado. Actualiza el servicio; los cambios pendientes se conservan en el dispositivo.',422);
      if(!attendanceVersionsAreValid(previous,snapshot)){
        return err('El servicio contiene fichajes de una versión anterior. Recarga el servicio antes de volver a guardar.',422);
      }
      const revision=crypto.randomUUID();
      snapshot.code=service.code;
      snapshot._syncRevision=revision;
      snapshot._syncSequence=Number(previous._syncSequence||0)+1;
      const serialized=JSON.stringify(snapshot);
      if(new TextEncoder().encode(serialized).byteLength>1900000)return err('El servicio supera el tamaño máximo que se puede guardar',413);
      const changes=deviceChanges(previous,snapshot);
      const deviceId=str(request.headers.get('x-device-id'),100);
      const statements=[];
      if(!expected){
        statements.push(env.DB.prepare('INSERT OR IGNORE INTO service_snapshots(service_id,snapshot,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)').bind(service.id,serialized));
        statements.push(env.DB.prepare("UPDATE service_snapshots SET snapshot=?,updated_at=CURRENT_TIMESTAMP WHERE service_id=? AND json_extract(snapshot,'$._syncRevision') IS NULL").bind(serialized,service.id));
      }else{
        statements.push(env.DB.prepare("UPDATE service_snapshots SET snapshot=?,updated_at=CURRENT_TIMESTAMP WHERE service_id=? AND json_extract(snapshot,'$._syncRevision')=?").bind(serialized,service.id,expected));
      }
      const writeCount=statements.length;
      if(changes.length&&/^[a-zA-Z0-9_-]{8,100}$/.test(deviceId)){
        statements.push(env.DB.prepare("INSERT INTO service_device_activity(id,service_id,device_id,created_at,changes) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM service_snapshots WHERE service_id=? AND json_extract(snapshot,'$._syncRevision')=?)")
          .bind(revision,service.id,deviceId,Date.now(),JSON.stringify(changes),service.id,revision));
      }
      // D1 batch is transactional: no history for failed writes, no lost audit
      // event between a committed snapshot and a separate logging request.
      const results=await env.DB.batch(statements);
      if(!results.slice(0,writeCount).some(result=>result.meta?.changes))return snapshotConflict();
      return json({ok:true,service:snapshot,revision});
    }
    if(!section&&m==='GET'){
     const [workers,teams,scenarios,incidents,requirements]=await Promise.all([
      env.DB.prepare('SELECT * FROM workers WHERE service_id=? ORDER BY sort_order').bind(service.id).all(),
      env.DB.prepare('SELECT * FROM teams WHERE service_id=? ORDER BY sort_order').bind(service.id).all(),
      env.DB.prepare('SELECT * FROM scenarios WHERE service_id=? ORDER BY sort_order').bind(service.id).all(),
      env.DB.prepare('SELECT * FROM incidents WHERE service_id=? ORDER BY created_at DESC').bind(service.id).all(),
      env.DB.prepare('SELECT * FROM requirements WHERE service_id=?').bind(service.id).all()
     ]);
     return json({ok:true,service,workers:workers.results,teams:teams.results,scenarios:scenarios.results,incidents:incidents.results,requirements:requirements.results});
    }
    if(!section&&m==='PATCH'){
     const v=await body(request);
     await env.DB.prepare('UPDATE services SET name=?,service_date=?,venue=?,closed=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(str(v.name??service.name,200),str(v.service_date??service.service_date,20),str(v.venue??service.venue,200),v.closed===undefined?service.closed:(v.closed?1:0),service.id).run();
     return json({ok:true});
    }
    if(section==='workers'&&m==='POST'){
     if(service.closed)return err('Service is closed',409);
     const v=await body(request),id=crypto.randomUUID();
     if(!str(v.personal,200).trim())return err('Worker name required');
     await env.DB.prepare('INSERT INTO workers(id,service_id,personal,trabajo,movil,status,service_date,inicio,fin,notes) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,service.id,str(v.personal,200),str(v.trabajo,120),str(v.movil,40),str(v.status,50),str(v.service_date,20),str(v.inicio,20),str(v.fin,20),str(v.notes,1000)).run();
     return json({ok:true,id},201);
    }
   }
   const worker=p.match(/^\/api\/workers\/([^/]+)$/);
   if(worker&&m==='PATCH'){
    const v=await body(request),id=worker[1];
    const current=await env.DB.prepare('SELECT w.*,s.closed FROM workers w JOIN services s ON s.id=w.service_id WHERE w.id=? AND s.deleted_at IS NULL').bind(id).first();
    if(!current)return err('Worker not found',404);
    const owner=await env.DB.prepare('SELECT code FROM services WHERE id=?').bind(current.service_id).first();
    if(owner?.code!==accessCode)return err('Código de servicio incorrecto',403);
    if(current.closed)return err('Service is closed',409);
    const fields=['personal','trabajo','movil','status','inicio','fin','notes','team_id','scenario_id','arrival_at'];
    const updates=fields.filter(k=>Object.prototype.hasOwnProperty.call(v,k));
    if(!updates.length)return err('No fields to update');
    const values=updates.map(k=>v[k]===null?null:str(v[k],k==='notes'?1000:200));
    await env.DB.prepare(`UPDATE workers SET ${updates.map(k=>k+'=?').join(',')} WHERE id=?`).bind(...values,id).run();
    return json({ok:true});
   }
   return err('API route not implemented',404);
  }catch(e){
   if(String(e).includes('UNIQUE constraint'))return err('Duplicate code',409);
   return err('Database operation failed',500);
  }
 }
};
