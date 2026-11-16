import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const directory=path.dirname(fileURLToPath(import.meta.url));
const app=path.resolve(directory,'..');
const data=await mkdtemp(path.join(directory,'data-inventory-'));
const reservation=net.createServer();
await new Promise((resolve)=>reservation.listen(0,'127.0.0.1',resolve));
const port=reservation.address().port;
await new Promise((resolve)=>reservation.close(resolve));
const base=`http://127.0.0.1:${port}`;
let child,stderr='',cookie='',csrf='';
const passed=[];
async function start(){
  child=spawn(process.execPath,[path.join(app,'server.mjs')],{cwd:app,env:{...process.env,APP_ENV:'demo',HOST:'127.0.0.1',PORT:String(port),DATA_DIR:data},stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stderr.on('data',(chunk)=>stderr+=chunk);
  for(let i=0;i<200;i++){
    try{if((await fetch(base+'/api/health')).ok)return;}catch{}
    if(child.exitCode!==null)break;
    await new Promise((resolve)=>setTimeout(resolve,25));
  }
  throw new Error('Inventory server failed '+stderr);
}
async function stop(){if(child?.exitCode===null){const exit=new Promise((resolve)=>child.once('exit',resolve));child.kill('SIGTERM');await exit;}}
async function raw(route,options={}){
  const response=await fetch(base+route,{...options,headers:{cookie,'Content-Type':'application/json','X-CSRF-Token':csrf,...options.headers},body:options.body===undefined?undefined:JSON.stringify(options.body)});
  if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  return response;
}
async function api(route,options={}){const response=await raw(route,options);const value=await response.json();assert.ok(response.ok,`${route}: ${JSON.stringify(value)}`);return value;}
async function denied(route,status,options={}){const response=await raw(route,options);assert.equal(response.status,status,`${route}: ${await response.text()}`);}
async function login(username='admin',password='Admin@123'){
  const mfaCode=username==='admin'?(await api('/api/demo-mfa')).code:undefined;
  await api('/api/login',{method:'POST',body:{username,password,mfaCode}});
  const user=(await api('/api/bootstrap')).user;csrf=user.csrfToken;return user;
}
try{
  await start();await login();
  const type=await api('/api/device-types',{method:'POST',body:{code:'PUMP_TEST',name:'测试泵类',sort_order:20}});
  await denied('/api/device-types',400,{method:'POST',body:{code:'123',name:'错误编码'}});
  await denied('/api/device-types',409,{method:'POST',body:{code:'pump_test',name:'重复编码'}});
  await denied('/api/dictionaries',409,{method:'POST',body:{dict_type:'category',code:'PUMP_SECOND',name:'测试泵类'}});
  passed.push('设备类型编码规则、跨入口名称和编码去重');
  const field=await api('/api/custom-fields',{method:'POST',body:{code:'pump_flow_test',name:'流量',field_type:'number',category:'测试泵类',exportable:true}});
  await api('/api/config/publish',{method:'POST'});
  await api(`/api/custom-fields/${field.id}`,{method:'PUT',body:{name:'额定流量',category:'测试泵类'}});
  const device=await api('/api/devices',{method:'POST',body:{code:'PUMP-TEST-1',name:'验证泵',category:'测试泵类',department_id:3,owner:'测试人',status:'在用',custom_data:{pump_flow_test:10}}});
  const original=(await api(`/api/devices/${device.id}`)).device;
  await api(`/api/dictionaries/${type.id}`,{method:'PUT',body:{name:'离心泵测试类'}});
  const renamed=(await api(`/api/devices/${device.id}`)).device;
  assert.equal(renamed.category,'离心泵测试类');assert.equal(renamed.version,original.version+1);assert.equal(renamed.custom_data.pump_flow_test,10);
  const fields=(await api('/api/custom-fields?drafts=1')).rows;
  assert.equal(fields.find((item)=>item.id===field.id).category,'离心泵测试类');
  const versions=(await api('/api/config/versions')).rows;
  assert.ok(versions.length);
  await api(`/api/config/versions/${versions[0].id}/rollback`,{method:'POST'});
  assert.equal((await api('/api/custom-fields')).rows.find((item)=>item.id===field.id).category,'离心泵测试类');
  passed.push('类型改名同步设备、参数草稿及回滚版本，保留参数值');
  await api(`/api/device-types/${type.id}`,{method:'PUT',body:{status:'disabled'}});
  await denied('/api/devices',400,{method:'POST',body:{code:'PUMP-TEST-2',name:'停用类型新设备',category:'离心泵测试类',department_id:3}});
  const old=(await api(`/api/devices/${device.id}`)).device;
  await api(`/api/devices/${device.id}`,{method:'PUT',body:{version:old.version,name:'原设备仍可维护'}});
  passed.push('停用类型禁止新增设备，已有设备允许继续维护');
  await login('dept','Dept@123');
  await denied('/api/device-types',403,{method:'POST',body:{code:'DENIED',name:'越权类型'}});
  await denied('/api/dictionaries',403,{method:'POST',body:{dict_type:'category',code:'DENIED',name:'越权类型'}});
  await login();
  const partInput={code:'SP-TEST-001',name:'深沟球轴承',category:'轴承',model:'6205',specification:'25×52×15',drawing_no:'D-6205',material:'轴承钢',manufacturer:'制造商',supplier:'供应商',unit:'个',quantity:10.5,min_stock:5,max_stock:100,warehouse:'一号库',bin_location:'A-01',compatible_device:'离心泵',department_id:3,owner:'王工程师',unit_price:123.45,parameters:[{name:'内径',value:'25',unit:'mm'},{name:'额定转速',value:'12000',unit:'r/min'}]};
  const part=await api('/api/spares',{method:'POST',body:partInput});
  const detail=await api(`/api/spares/${part.id}`);assert.equal(detail.part.quantity,10.5);assert.deepEqual(detail.part.parameters,partInput.parameters);assert.equal(detail.part.drawing_no,'D-6205');
  assert.equal(detail.movements.length,1);assert.equal(detail.movements[0].kind,'opening');
  await denied('/api/spares',409,{method:'POST',body:partInput});
  await denied('/api/spares',400,{method:'POST',body:{...partInput,code:'BAD-NUM',quantity:-1}});
  passed.push('独立备件台账保存技术参数、位置和期初库存，校验重复及负数');
  let version=detail.part.version;
  const incoming=await api(`/api/spares/${part.id}/movements`,{method:'POST',body:{kind:'in',quantity:2.25,reason:'采购到货',version}});assert.equal(incoming.quantity,12.75);version=incoming.version;
  const outgoing=await api(`/api/spares/${part.id}/movements`,{method:'POST',body:{kind:'out',quantity:8,reason:'检修领用',version}});assert.equal(outgoing.quantity,4.75);version=outgoing.version;
  const low=await api('/api/spares?lowStock=1');assert.ok(low.rows.some((row)=>row.id===part.id));assert.ok(low.summary.lowStock>=1);
  await denied(`/api/spares/${part.id}/movements`,400,{method:'POST',body:{kind:'out',quantity:5,reason:'超量',version}});
  await denied(`/api/spares/${part.id}/movements`,409,{method:'POST',body:{kind:'in',quantity:1,reason:'旧版本',version:version-1}});
  await denied(`/api/spares/${part.id}`,400,{method:'PUT',body:{version,quantity:999}});
  const adjusted=await api(`/api/spares/${part.id}/movements`,{method:'POST',body:{kind:'adjust',quantity:4.5,reason:'盘点复核',version}});assert.equal(adjusted.quantity,4.5);version=adjusted.version;
  await api(`/api/spares/${part.id}`,{method:'PUT',body:{version,notes:'更新备注',parameters:[{name:'间隙',value:'C3',unit:''}]}});
  await denied(`/api/spares/${part.id}`,409,{method:'PUT',body:{version,notes:'过期覆盖'}});
  const changed=await api(`/api/spares/${part.id}`);assert.equal(changed.part.quantity,4.5);assert.equal(changed.movements.length,4);assert.deepEqual(changed.part.parameters,[{name:'间隙',value:'C3',unit:''}]);
  passed.push('出入库和盘点流水、低库存筛选、超领及并发修改保护');
  const other=await api('/api/spares',{method:'POST',body:{...partInput,code:'SP-OUTSIDE',department_id:2,owner:'其他人'}});
  const exportAdmin=await raw('/api/spares/export');assert.equal(exportAdmin.status,200);assert.match(await exportAdmin.text(),/123.45/);
  await login('dept','Dept@123');
  assert.ok(!(await api('/api/spares')).rows.some((row)=>row.id===other.id));
  const masked=await api(`/api/spares/${part.id}`);assert.ok(!Object.hasOwn(masked.part,'unit_price'));
  await denied(`/api/spares/${other.id}`,404);
  await denied(`/api/spares/${part.id}`,403,{method:'PUT',body:{version:masked.part.version,unit_price:0}});
  await denied('/api/spares',403,{method:'POST',body:{...partInput,code:'SP-DEPT-DENIED',department_id:2}});
  const exportDept=await raw('/api/spares/export');const xml=await exportDept.text();assert.doesNotMatch(xml,/单价|123.45|SP-OUTSIDE/);
  passed.push('备件部门范围隔离、价格查看修改导出权限');
  await login('staff','Staff@123');
  assert.ok((await api('/api/spares')).rows.every((row)=>row.owner==='王工程师'));
  await denied(`/api/spares/${part.id}`,403,{method:'PUT',body:{version:changed.part.version,notes:'只读账号'}});
  await denied('/api/spares/export',403);
  await login('asset','Asset@123');const assetXml=await raw('/api/spares/export');assert.doesNotMatch(await assetXml.text(),/单价|123.45/);
  passed.push('本人范围与只读账号限制，可看价格角色仍不能越权导出价格');
  await login();
  await api(`/api/spares/${other.id}`,{method:'DELETE'});
  await denied(`/api/spares/${other.id}`,404);
  await denied('/api/spares',409,{method:'POST',body:{...partInput,code:'SP-OUTSIDE'}});
  await stop();await start();await login();
  const persisted=await api(`/api/spares/${part.id}`);assert.equal(persisted.part.quantity,4.5);assert.equal(persisted.movements.length,4);
  assert.equal((await api('/api/device-types')).rows.find((row)=>row.id===type.id).status,'disabled');
  passed.push('软删除保留编码，重启后备件参数、库存流水与设备类型持久保存');
  console.log(JSON.stringify({passed},null,2));
}finally{await stop();}
