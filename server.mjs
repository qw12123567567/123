import http from 'node:http';
import path from 'node:path';
import { readFile,stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { paths,db } from './db.mjs';
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

const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  if(process.env.APP_ENV==='production')res.setHeader('Strict-Transport-Security','max-age=31536000');
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/'))return await api(req,res,url);
    if(await staticFile(res,url))return;
    const data=await readFile(path.join(paths.public,'index.html'));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-cache'});
    res.end(data);
  }catch(cause){
    if(!cause.status||cause.status>=500)console.error(cause);
    if(!res.headersSent)fail(res,cause.status||500,cause.status?cause.message:'服务器内部错误');else res.end();
  }
});
server.headersTimeout=15000;
server.requestTimeout=60000;
server.maxHeadersCount=100;
const port=Number(process.env.PORT||4173);const host=process.env.HOST||(process.env.APP_ENV==='production'?'0.0.0.0':'127.0.0.1');server.listen(port,host,()=>console.log(`设备台账管理系统已启动：http://${host}:${port}`));
let backupDate='';
async function scheduledBackup(){
  const current=new Date();const today=new Date(current.getTime()-current.getTimezoneOffset()*60000).toISOString().slice(0,10);if(current.getHours()<2||backupDate===today)return;
  const existing=await listBackups();if(!existing.some((entry)=>entry.fileName.startsWith(`device-ledger-${today}`)))await createBackup();
  backupDate=today;await pruneBackups();await sendReminderDigest();
}
scheduledBackup().catch(console.error);setInterval(()=>scheduledBackup().catch(console.error),60*60*1000).unref();
function shutdown(){server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
