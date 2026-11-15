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
const cookie=(token,maxAge)=>({'set-cookie':sessionName+'='+token+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age='+maxAge});

export async function manager(request,env,url){
 const db=env.DB;
 const action=url.pathname.slice('/api/manager/'.length);
 const writes=request.method==='POST';
 if(writes&&(request.headers.get('origin')!==url.origin||!request.headers.get('content-type')?.startsWith('application/json'))){
  return error('Solicitud fuera de Crew Control.',403);
 }
 const now=Date.now();
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
  const correct=record?equal(await passwordHash(password,record.salt),record.password_hash):
   equal(await digest(password),await digest(env.CREW_MANAGER_INITIAL_PASSWORD));
  if(input.username!==username||!correct)return error('Usuario o contraseña incorrectos.',401);
  await db.prepare('DELETE FROM crew_manager_attempts WHERE window_start < ? OR source=?').bind(windowStart,source).run();
  const token=random(32);
  const seconds=record?28800:600;
  await db.prepare('DELETE FROM crew_manager_sessions WHERE expires_at <= ?').bind(now).run();
  await db.prepare('INSERT INTO crew_manager_sessions VALUES(?,?,?)').bind(await digest(token),now+seconds*1000,record?0:1).run();
  return response({setup:!record},200,cookie(token,seconds));
 }

 const token=request.headers.get('cookie')?.split(';').map(value=>value.trim())
  .find(value=>value.startsWith(sessionName+'='))?.slice(sessionName.length+1);
 if(!/^[a-f0-9]{64}$/.test(token||''))return error('Entra como gestor.',401);
 const tokenHash=await digest(token);
 const session=await db.prepare('SELECT setup FROM crew_manager_sessions WHERE token_hash=? AND expires_at>?').bind(tokenHash,now).first();
 if(!session)return error('Vuelve a entrar como gestor.',401);
 if(action==='logout'&&writes){
  await db.prepare('DELETE FROM crew_manager_sessions WHERE token_hash=?').bind(tokenHash).run();
  return response({},200,cookie('',0));
 }
 if(action==='session'&&request.method==='GET')return response({setup:!!session.setup});
 if(action==='password'&&writes){
  const {current,password}=await request.json();
  if(typeof current!=='string'||current.length>256||
     typeof password!=='string'||password.length<12||password.length>256||password===current){
   return error('Usa una contraseña nueva de al menos 12 caracteres.',400);
  }
  const record=await db.prepare('SELECT salt,password_hash FROM crew_manager WHERE id=1').first();
  if(!record&&!env.CREW_MANAGER_INITIAL_PASSWORD)return error('Configura el acceso de gestor en Cloudflare.',503);
  const correct=record?equal(await passwordHash(current,record.salt),record.password_hash):
   equal(await digest(current),await digest(env.CREW_MANAGER_INITIAL_PASSWORD));
  if(!correct)return error('La contraseña actual no coincide.',401);
  const salt=random(16),hash=await passwordHash(password,salt);
  const nextToken=random(32),nextHash=await digest(nextToken);
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
