const json=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra}});
const err=(message,status=400)=>json({ok:false,error:message},status);
const encoder=new TextEncoder();
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const sign=async(secret,data)=>{const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',key,encoder.encode(data)))};
const safeEqual=(a,b)=>{if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0};
async function authenticated(request,env){
  const cookie=request.headers.get('cookie')||'';
  const token=cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('cc_session='))?.slice(11);
  if(!token||!env.SESSION_SECRET)return false;
  const parts=token.split('.');
  if(parts.length!==2)return false;
  const expiry=Number(parts[0]);
  if(!Number.isSafeInteger(expiry)||expiry<Date.now()||expiry>Date.now()+86400000)return false;
  return safeEqual(parts[1],await sign(env.SESSION_SECRET,parts[0]));
}
async function body(request){const value=await request.json();if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid JSON object');return value}
const str=(v,max=500)=>String(v??'').slice(0,max);
export default {
 async fetch(request,env){
  const url=new URL(request.url),p=url.pathname,m=request.method;
  if(!p.startsWith('/api/'))return env.ASSETS.fetch(request);
  if(p==='/api/health'&&m==='GET'){
   if(!env.DB)return err('D1 binding DB missing',503);
   try{await env.DB.prepare('SELECT 1').first();return json({ok:true,database:'d1'})}catch{return err('D1 unavailable',503)}
  }
  if(p==='/api/login'&&m==='POST'){
   if(!env.ADMIN_PASSWORD||!env.SESSION_SECRET)return err('Login not configured: set ADMIN_PASSWORD and SESSION_SECRET as Worker secrets',503);
   try{
    const input=await body(request);
    if(!safeEqual(str(input.password,512),env.ADMIN_PASSWORD))return err('Invalid credentials',401);
    const expires=String(Date.now()+8*3600000),sig=await sign(env.SESSION_SECRET,expires);
    return json({ok:true},200,{'set-cookie':`cc_session=${expires}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`});
   }catch{return err('Invalid request')}
  }
  if(p==='/api/logout'&&m==='POST')return json({ok:true},200,{'set-cookie':'cc_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});
  if(!await authenticated(request,env))return err('Authentication required',401);
  if(!env.DB)return err('D1 not configured',503);
  if(p==='/api/session'&&m==='GET')return json({ok:true,authenticated:true});
  try{
   if(p==='/api/services'&&m==='GET'){
    const result=await env.DB.prepare('SELECT id,code,name,service_date,venue,closed,created_at FROM services ORDER BY created_at DESC LIMIT 200').all();
    return json({ok:true,services:result.results});
   }
   if(p==='/api/services'&&m==='POST'){
    const v=await body(request),id=crypto.randomUUID(),code=str(v.code||id,80).trim();
    if(!code)return err('Service code required');
    await env.DB.prepare('INSERT INTO services(id,code,name,service_date,venue) VALUES(?,?,?,?,?)').bind(id,code,str(v.name,200),str(v.service_date,20),str(v.venue,200)).run();
    return json({ok:true,id,code},201);
   }
   const match=p.match(/^\/api\/services\/([^/]+)(?:\/(workers|teams|scenarios|incidents|requirements))?$/);
   if(match){
    const code=decodeURIComponent(match[1]),section=match[2];
    const service=await env.DB.prepare('SELECT * FROM services WHERE code=?').bind(code).first();
    if(!service)return err('Service not found',404);
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
    const current=await env.DB.prepare('SELECT w.*,s.closed FROM workers w JOIN services s ON s.id=w.service_id WHERE w.id=?').bind(id).first();
    if(!current)return err('Worker not found',404);
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