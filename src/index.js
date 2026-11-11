const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const fail = (message,status=400) => json({ok:false,error:message},status);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!env.DB) return fail('Cloudflare D1 binding DB not configured',503);
    if (url.pathname === '/api/health' && request.method === 'GET') return json({ok:true, database:'d1'});
    // SECURITY: No business-data endpoints are exposed until authentication and authorization are configured.
    // Do not add public CRUD routes for personnel records without access controls.
    return fail('API route not implemented',404);
  }
};
