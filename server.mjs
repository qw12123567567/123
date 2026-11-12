import http from 'node:http';
import path from 'node:path';
import { readFile,stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { paths,db,cloudDatabase } from './db.mjs';
import { api } from './routes.mjs';
import { fail } from './http.mjs';
import { createBackup,pruneBackups,listBackups } from './backups.mjs';
import { sendReminderDigest } from './notifications.mjs';

const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
async function staticFile(res,url){
  const request=url.pathname==='/'?'/index.html':url.pathname;const normalized=path.normalize(request).replace(/^(\.\.[/\\])+/,'');const file=path.join(paths.public,normalized);
  if(!file.startsWith(paths.public)||!existsSync(file)||(await stat(file)).isDirectory())return false;const data=await readFile(file);
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':data.length,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'self'; frame-ancestors 'none'"});res.end(data);return true;
}

async function dispatch(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  if(process.env.APP_ENV==='production')res.setHeader('Strict-Transport-Security','max-age=31536000');
  try{
    const url=new URL(req.url,'http://localhost');
    // Vercel rewrites API paths to this bundled function and adds the
    // original route in __route while preserving the request query.
    if(url.pathname==='/api/index'&&url.searchParams.has('__route')){
      const route=url.searchParams.get('__route');
      if(!route||route.split('/').some(part=>!part||part==='.'||part==='..'))return fail(res,404,'接口不存在');
      url.pathname=`/api/${route}`;
      url.searchParams.delete('__route');
    }
    if(url.pathname==='/api/cron'){
      if(req.method!=='GET'||!process.env.CRON_SECRET||req.headers.authorization!==`Bearer ${process.env.CRON_SECRET}`)return fail(res,401,'未授权');
      await scheduledBackup();res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true}));
    }
    if(url.pathname.startsWith('/api/'))return await api(req,res,url);
    if(await staticFile(res,url))return;
    const data=await readFile(path.join(paths.public,'index.html'));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-cache'});
    res.end(data);
  }catch(cause){
    if(!cause.status||cause.status>=500)console.error(cause);
    if(!res.headersSent)fail(res,cause.status||500,cause.status?cause.message:'服务器内部错误');else res.end();
  }
}
// A libSQL connection owns its transaction. Keep asynchronous file operations
// from interleaving two requests on that connection within one function instance.
let requestQueue=Promise.resolve();
export async function handleRequest(req,res){
  if(!cloudDatabase)return dispatch(req,res);
  const previous=requestQueue;let release;requestQueue=new Promise(resolve=>{release=resolve;});
  await previous;
  try{return await dispatch(req,res);}finally{try{if(db.inTransaction)db.exec('ROLLBACK');}finally{release();}}
}
const server=http.createServer(handleRequest);
server.headersTimeout=15000;
server.requestTimeout=60000;
server.maxHeadersCount=100;
const port=Number(process.env.PORT||4173);const host=process.env.HOST||(process.env.APP_ENV==='production'?'0.0.0.0':'127.0.0.1');
if(!process.env.VERCEL)server.listen(port,host,()=>console.log(`设备台账管理系统已启动：http://${host}:${port}`));
let backupDate='';
async function scheduledBackup(){
  db.prepare('DELETE FROM attachment_upload_sessions WHERE expires_at<?').run(new Date().toISOString());
  const current=new Date();const today=new Date(current.getTime()-current.getTimezoneOffset()*60000).toISOString().slice(0,10);if(current.getHours()<2||backupDate===today)return;
  const existing=await listBackups();if(!existing.some((entry)=>entry.fileName.startsWith(`device-ledger-${today}`)))await createBackup();
  backupDate=today;await pruneBackups();await sendReminderDigest();
}
if(!process.env.VERCEL){scheduledBackup().catch(console.error);setInterval(()=>scheduledBackup().catch(console.error),60*60*1000).unref();}
function shutdown(){server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
if(!process.env.VERCEL){process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);}
