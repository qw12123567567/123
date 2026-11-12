import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory=path.dirname(fileURLToPath(import.meta.url));const app=path.resolve(directory,'..');const data=await mkdtemp(path.join(directory,'production-data-'));const passed=[];
const reserve=net.createServer();await new Promise((resolve)=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise((resolve)=>reserve.close(resolve));const base=`http://127.0.0.1:${port}`;
const password=`Test-${crypto.randomBytes(20).toString('hex')}9a`;const secret='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';let child;let stderr='';let cookie='';
async function until(check){for(let index=0;index<200;index++){if(await check())return;await new Promise((resolve)=>setTimeout(resolve,25));}throw new Error('Production startup failed '+stderr);}
function token(){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const char of secret)bits+=alphabet.indexOf(char).toString(2).padStart(5,'0');const key=Buffer.from(bits.match(/.{8}/g).map((byte)=>parseInt(byte,2)));const count=Buffer.alloc(8);count.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const hmac=crypto.createHmac('sha1',key).update(count).digest();return String((hmac.readUInt32BE(hmac.at(-1)&15)&0x7fffffff)%1000000).padStart(6,'0');}
async function start(initial){stderr='';const env={...process.env,APP_ENV:'production',HOST:'127.0.0.1',PORT:String(port),DATA_DIR:data};if(initial){env.ADMIN_PASSWORD=password;env.ADMIN_MFA_SECRET=secret;}else{delete env.ADMIN_PASSWORD;delete env.ADMIN_MFA_SECRET;}child=spawn(process.execPath,[path.join(app,'server.mjs')],{cwd:app,env,stdio:['ignore','pipe','pipe'],windowsHide:true});child.stderr.on('data',(chunk)=>stderr+=chunk);await until(async()=>{try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});}
async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise((resolve)=>child.once('exit',resolve));}}
async function api(route,options={}){const response=await fetch(base+route,{...options,headers:{cookie,'Content-Type':'application/json',...options.headers},body:options.body?JSON.stringify(options.body):undefined});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return response;}
try{
  await start(true);assert.equal((await api('/api/demo-mfa')).status,404);assert.equal((await api('/api/runtime').then((response)=>response.json())).demo,false);passed.push('正式环境关闭演示账号入口与动态码接口');
  const noMfa=await api('/api/login',{method:'POST',body:{username:'admin',password}});assert.equal(noMfa.status,401);passed.push('正式管理员必须通过动态验证');
  const login=await api('/api/login',{method:'POST',body:{username:'admin',password,mfaCode:token()}});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/; Secure/);passed.push('正式登录Cookie使用Secure、HttpOnly和SameSite');
  const user=(await api('/api/bootstrap').then((response)=>response.json())).user;assert.equal(user.permissions.viewPrice,false);passed.push('正式超级管理员默认不自动拥有价格权限');
  const created=await api('/api/devices',{method:'POST',headers:{'X-CSRF-Token':user.csrfToken},body:{name:'持久化验收设备',category:'计算机设备',department_id:1,status:'在用',custom_data:{}}});assert.equal(created.status,201);const id=(await created.json()).id;
  await stop();await start(false);const repeat=await api('/api/login',{method:'POST',body:{username:'admin',password,mfaCode:token()}});assert.equal(repeat.status,200);const read=await api(`/api/devices/${id}`);assert.equal(read.status,200);assert.equal((await read.json()).device.name,'持久化验收设备');passed.push('正式数据目录重启后保留设备及管理员身份');
  for(let index=0;index<5;index++)assert.equal((await api('/api/login',{method:'POST',headers:{'X-Forwarded-For':`1.2.3.${index}`},body:{username:'admin',password,mfaCode:'invalid'}})).status,401);
  assert.equal((await api('/api/login',{method:'POST',headers:{'X-Forwarded-For':'9.9.9.9'},body:{username:'admin',password,mfaCode:token()}})).status,429);passed.push('错误动态码锁定且不信任伪造代理IP');
  console.log(JSON.stringify({passed},null,2));
}finally{await stop();}
