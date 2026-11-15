const username='franpenny';
const sessionName='__Host-crew-manager';
const encoder=new TextEncoder();
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const random=length=>hex(crypto.getRandomValues(new Uint8Array(length)));
const digest=async value=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));
const passwordHash=async(password,salt)=>{
 const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
 return hex(new Uint8Array(await crypto.subtle.deriveBits({
  name:'PBKDF2',salt:encoder.encode(salt),iterations:100000,hash:'SHA-256'
 },key,256)));
};
function equal(a,b){
 let different=a.length^b.length;
 for(let i=0;i<a.length;i++)different|=a.charCodeAt(i)^(b.charCodeAt(i)||0);
 return different===0;
}
const response=(value,status=200,headers={})=>Response.json(value,{status,headers:{'cache-control':'no-store',...headers}});
const error=(message,status)=>response({error:message},status);
const cookie=(token,maxAge)=>({'set-cookie':sessionName+'='+token+'; Path=/; Secure; HttpOnly; SameSite=Strict'+(maxAge===0?'; Max-Age=0':'')});

const clientSaltPrefix='browser-v1:';
const validProof=proof=>typeof proof==='string'&&/^[0-9a-f]{64}$/.test(proof);
async function checkPassword(record,password,proof){
 if(record.salt.startsWith(clientSaltPrefix)){
  return validProof(proof)&&equal(await digest(proof),record.password_hash);
 }
 return typeof password==='string'&&password.length<=256&&equal(await passwordHash(password,record.salt),record.password_hash);
}

export async function manager(request,env,url){
 const db=env.DB;
 const action=url.pathname.slice('/api/manager/'.length);
 const writes=request.method==='POST';
 if(writes&&(request.headers.get('origin')!==url.origin||!request.headers.get('content-type')?.startsWith('application/json'))){
  return error('Solicitud fuera de Crew Control.',403);
 }
 const now=Date.now();
 if(action==='challenge'&&request.method==='GET'){
  const record=await db.prepare('SELECT salt FROM crew_manager WHERE id=1').first();
  return response({salt:record?.salt.startsWith(clientSaltPrefix)?record.salt.slice(clientSaltPrefix.length):null});
 }
 const page=request.headers.get('x-crew-manager-page')||'';
 if(!/^[a-f0-9-]{36}$/.test(page))return error('Entra como gestor desde esta página.',401);
 // A restored browser cookie cannot open a manager session in a new page.
 const sessionDigest=token=>digest(token+':'+page);
 if(action==='login'&&writes){
  const input=await request.json();
  const password=typeof input.password==='string'?input.password:'';
  const record=await db.prepare('SELECT salt,password_hash FROM crew_manager WHERE id=1').first();
  if(!record&&!env.CREW_MANAGER_INITIAL_PASSWORD)return error('Configura el acceso de gestor en Cloudflare.',503);
  if(password.length>256)return error('Usuario o contraseña incorrectos.',401);
  const source=await digest(request.headers.get('cf-connecting-ip')||'unknown');
  const windowStart=Math.floor(now/900000)*900000;
  const attempt=await db.prepare('INSERT INTO crew_manager_attempts VALUES(?,?,1) ON CONFLICT(source) DO UPDATE SET window_start=excluded.window_start, attempts=CASE WHEN window_start=excluded.window_start THEN attempts+1 ELSE 1 END RETURNING attempts').bind(source,windowStart).first();
  if(attempt.attempts>8)return error('Demasiados intentos. Vuelve a probar en unos minutos.',429);
  const correct=record?await checkPassword(record,password,input.proof):
   equal(await digest(password),await digest(env.CREW_MANAGER_INITIAL_PASSWORD));
  if(input.username!==username||!correct)return error('Usuario o contraseña incorrectos.',401);
  await db.prepare('DELETE FROM crew_manager_attempts WHERE window_start < ? OR source=?').bind(windowStart,source).run();
  const token=random(32);
  const seconds=record?28800:600;
  await db.prepare('DELETE FROM crew_manager_sessions WHERE expires_at <= ?').bind(now).run();
  await db.prepare('INSERT INTO crew_manager_sessions VALUES(?,?,?)').bind(await sessionDigest(token),now+seconds*1000,record?0:1).run();
  return response({setup:!record},200,cookie(token,seconds));
 }

 const token=request.headers.get('cookie')?.split(';').map(value=>value.trim())
  .find(value=>value.startsWith(sessionName+'='))?.slice(sessionName.length+1);
 if(!/^[a-f0-9]{64}$/.test(token||''))return error('Entra como gestor.',401);
 const tokenHash=await sessionDigest(token);
 const session=await db.prepare('SELECT setup FROM crew_manager_sessions WHERE token_hash=? AND expires_at>?').bind(tokenHash,now).first();
 if(!session)return error('Vuelve a entrar como gestor.',401);
 if(action==='logout'&&writes){
  await db.prepare('DELETE FROM crew_manager_sessions WHERE token_hash=?').bind(tokenHash).run();
  return response({},200,cookie('',0));
 }
 if(action==='session'&&request.method==='GET')return response({setup:!!session.setup});
 if(action==='password'&&writes){
  const {current,password,currentProof,newProof,newSalt,newLength,fingerprint}=await request.json();
  const browser=validProof(newProof)&&typeof newSalt==='string'&&/^[a-f0-9]{32}$/.test(newSalt)&&(!session.setup||validProof(fingerprint));
  const length=browser?newLength:typeof password==='string'?password.length:0;
  if(!Number.isInteger(length)||length<12||length>256){
   return error('La contraseña nueva debe tener entre 12 y 256 caracteres.',400);
  }
  const record=await db.prepare('SELECT salt,password_hash FROM crew_manager WHERE id=1').first();
  if(session.setup){
   if(record)return error('La cuenta ya se activó. Vuelve a entrar.',409);
   if(!env.CREW_MANAGER_INITIAL_PASSWORD)return error('Configura el acceso de gestor en Cloudflare.',503);
   if(equal(browser?fingerprint:await digest(password),await digest(env.CREW_MANAGER_INITIAL_PASSWORD))){
    return error('La contraseña nueva debe ser distinta de la inicial.',400);
   }
  }else{
   if(!current&&!currentProof)return error('Escribe tu contraseña actual.',400);
   if(!record||!(await checkPassword(record,current,currentProof))){
    return error('La contraseña actual no coincide.',401);
   }
   if(!browser&&password===current)return error('La contraseña nueva debe ser distinta de la actual.',400);
  }
  // Browser-side PBKDF2 keeps activation within the Worker's CPU budget.
  // Store a digest of its output, never the proof accepted at login.
  const salt=browser?clientSaltPrefix+newSalt:random(16);
  const hash=browser?await digest(newProof):await passwordHash(password,salt);
  const nextToken=random(32),nextHash=await sessionDigest(nextToken);
  const change=record?
   db.prepare('UPDATE crew_manager SET salt=?,password_hash=? WHERE id=1 AND password_hash=?').bind(salt,hash,record.password_hash):
   db.prepare('INSERT OR IGNORE INTO crew_manager VALUES(1,?,?)').bind(salt,hash);
  const results=await db.batch([
   change,
   db.prepare('DELETE FROM crew_manager_sessions WHERE EXISTS (SELECT 1 FROM crew_manager WHERE password_hash=?)').bind(hash),
   db.prepare('INSERT INTO crew_manager_sessions SELECT ?,?,0 WHERE EXISTS (SELECT 1 FROM crew_manager WHERE password_hash=?)').bind(nextHash,now+28800000,hash)
  ]);
  if(!results[0].meta.changes)return error('Vuelve a entrar y repite el cambio.',409);
  return response({setup:false},200,cookie(nextToken,28800));
 }
 if(session.setup)return error('Cambia la contraseña inicial para ver los servicios.',403);
 if(action==='services'&&request.method==='GET'){
  const {results}=await db.prepare(`SELECT s.code,
   COALESCE(NULLIF(json_extract(p.snapshot,'$.serviceName'),''),s.name) name,
   COALESCE(json_extract(p.snapshot,'$.closed'),s.closed) closed,
   COALESCE(NULLIF(json_extract(p.snapshot,'$.serviceDate'),''),s.service_date) date,
   COALESCE(json_extract(p.snapshot,'$.pdfName'),s.pdf_name) pdf,
   COALESCE(json_array_length(p.snapshot,'$.workers'),0) workers,
   (SELECT group_concat(DISTINCT json_extract(value,'$.trabajo')) FROM json_each(p.snapshot,'$.workers')) types
   FROM services s LEFT JOIN service_snapshots p ON p.service_id=s.id
   ORDER BY COALESCE(p.updated_at,s.created_at) DESC,s.code`).all();
  return response({services:results});
 }
 return error('Acción de gestor no disponible.',404);
}
