const json=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra}});
const err=(message,status=400)=>json({ok:false,error:message},status);
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
  if(!env.DB)return err('D1 not configured',503);
  const accessCode=str(request.headers.get('x-service-code'),100).trim();
  if(!/^[A-Za-z0-9_-]{12,80}$/.test(accessCode))return err('Introduce un código de servicio de al menos 12 caracteres',403);
  try{
   if(p==='/api/services'&&m==='POST'){
    const v=await body(request),id=crypto.randomUUID();
    const existing=await env.DB.prepare('SELECT id,code FROM services WHERE code=?').bind(accessCode).first();
    if(existing)return json({ok:true,id:existing.id,code:existing.code,existing:true});
    await env.DB.prepare('INSERT INTO services(id,code,name,service_date,venue) VALUES(?,?,?,?,?)').bind(id,accessCode,str(v.name,200),str(v.service_date,20),str(v.venue,200)).run();
    return json({ok:true,id,code:accessCode},201);
   }
   const match=p.match(/^\/api\/services\/([^/]+)(?:\/(workers|teams|scenarios|incidents|requirements))?$/);
   if(match){
    const code=decodeURIComponent(match[1]),section=match[2];
    if(code!==accessCode)return err('Código de servicio incorrecto',403);
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