import { readFile,writeFile,unlink,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { db,paths,PRICE_FIELDS,SENSITIVE_FILE_TYPES,DEVICE_FIELDS } from './db.mjs';
import { verifyPassword,verifyTotp,totp,parseCookies,publicUser,scopeClause,canAccessDepartment,descendants,maskDevice,safeJson,audit,randomToken,clientIp,sessionCookie,fieldPermission } from './security.mjs';
import { json,fail,bodyJson,requireUser,spreadsheet } from './http.mjs';
import { validateAttachment,previewMimes } from './attachments.mjs';
import { business,configuration,nextDeviceCode } from './business.mjs';
import { publicAccount,reminderRows } from './notifications.mjs';
import { createBackup,listBackups } from './backups.mjs';
import { restoreBackup } from './backups.mjs';

const attempts=new Map();
const now=()=>new Date().toISOString();
const localStamp=()=>new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().replace(/[:.]/g,'-');
const exportDirectory=path.join(paths.data,'exports');
await mkdir(exportDirectory,{recursive:true});
db.exec("CREATE TABLE IF NOT EXISTS export_jobs(id TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),status TEXT,fingerprint TEXT,device_ids TEXT,error TEXT,created_at TEXT,expires_at TEXT)");
db.prepare("UPDATE export_jobs SET status='failed',error='服务重启，请重新导出' WHERE status='pending'").run();

function exportFingerprint(user){const account=publicUser(user);delete account.csrfToken;return createHash('sha256').update(JSON.stringify(account)).digest('hex');}

function buildExport(url,user){
  const query=filters(url,user);const rows=db.prepare(`SELECT d.*,dep.name department_name FROM devices d LEFT JOIN departments dep ON dep.id=d.department_id WHERE ${query.where} ORDER BY d.code LIMIT 10000`).all(...query.params);
  const labels={code:'设备编号',asset_code:'固定资产编号',sn:'序列号SN',name:'设备名称',category:'设备分类',model:'型号规格',brand:'品牌',manufacturer:'生产厂商',vendor:'供应商',purchase_date:'采购日期',start_date:'启用日期',department_name:'使用部门',location:'存放位置',owner:'责任人',status:'设备状态',warranty_end:'保修截止日期',maintenance_cycle:'维保周期(天)',next_maintenance:'下次维保日期',calibration_cycle:'检定周期(天)',next_calibration:'下次检定日期',scrap_date:'报废日期',critical:'关键设备',notes:'备注',purchase_price:'采购原值',unit_price:'采购单价',contract_amount:'合同金额',invoice_amount:'发票金额',residual_value:'残值',repair_cost:'维修费用'};
  const customFields=db.prepare("SELECT * FROM custom_fields WHERE status='published' AND exportable=1").all().filter((field)=>fieldPermission(user,field,'export'));for(const field of customFields)labels[`custom_${field.code}`]=field.name;
  const columns=(configuration('export').columns||[]).filter((key)=>Object.hasOwn(labels,key)&&(!PRICE_FIELDS.includes(key)||user.export_price));const headers=columns.map((key)=>({key,label:labels[key],number:PRICE_FIELDS.includes(key)}));
  const exportRows=rows.map((row)=>{const custom=maskDevice(row,user).custom_data;return Object.fromEntries(columns.map((key)=>[key,key==='critical'?(row.critical?'是':'否'):key.startsWith('custom_')?custom[key.slice(7)]:row[key]]));});
  return{xml:spreadsheet(headers,exportRows),ids:rows.map((row)=>row.id),containsPrice:columns.some((key)=>PRICE_FIELDS.includes(key))};
}

function filters(url,user) {
  const scope=scopeClause(user,'d');
  const where=['d.deleted=0',scope.sql]; const params=[...scope.params];
  const q=url.searchParams.get('q')?.trim();
  if(q){const term=`%${q}%`;const fields=['code','asset_code','sn','name','model','owner','location'];const customFields=db.prepare("SELECT * FROM custom_fields WHERE status='published'").all().filter((field)=>fieldPermission(user,field,'view'));const customKeys=customFields.map((field)=>field.code);where.push(`(${fields.map((field)=>`d.${field} LIKE ?`).join(' OR ')}${customKeys.length?` OR EXISTS(SELECT 1 FROM json_each(d.custom_data) j WHERE j.key IN(${customKeys.map(()=>'?').join(',')}) AND CAST(j.value AS TEXT) LIKE ?)` : ''})`);params.push(...Array(fields.length).fill(term),...customKeys,...(customKeys.length?[term]:[]));}
  for(const [key,value] of url.searchParams){
    if(!key.startsWith('custom_')||!value)continue;
    const field=db.prepare("SELECT * FROM custom_fields WHERE code=? AND status='published'").get(key.slice(7));
    if(!field||!field.filterable||!fieldPermission(user,field,'view'))throw Object.assign(new Error('无权使用该字段筛选'),{status:403});
    where.push('CAST(json_extract(d.custom_data,?) AS TEXT) LIKE ?');params.push(`$."${field.code}"`,`%${value}%`);
  }
  for(const key of ['category','status','location','owner']){const value=url.searchParams.get(key);if(value){where.push(`d.${key}=?`);params.push(value);}}
  const department=url.searchParams.get('department_id');if(department){where.push('d.department_id=?');params.push(Number(department));}
  if(url.searchParams.get('critical')==='1')where.push('d.critical=1');
  if(url.searchParams.get('missing_owner')==='1')where.push("(d.owner IS NULL OR TRIM(d.owner)='')");
  if(url.searchParams.get('warranty_soon')==='1')where.push("date(d.warranty_end) BETWEEN date('now') AND date('now','+30 day')");
  if(url.searchParams.get('maintenance_due')==='1')where.push("date(d.next_maintenance)<=date('now','+30 day')");
  if(url.searchParams.get('calibration_due')==='1')where.push("date(d.next_calibration)<=date('now','+30 day')");
  return {where:where.join(' AND '),params};
}

function deviceForUser(id,user){const scope=scopeClause(user,'d');return db.prepare(`SELECT d.*,dep.name department_name FROM devices d LEFT JOIN departments dep ON dep.id=d.department_id WHERE d.id=? AND d.deleted=0 AND ${scope.sql}`).get(id,...scope.params);}

function normalizeDevice(input,user,existing={}) {
  const output={};
  for(const field of DEVICE_FIELDS) if(field in input) output[field]=input[field]===''?null:input[field];
  for(const field of ['code','name','sn','asset_code','owner'])if(typeof output[field]==='string')output[field]=output[field].trim();
  if(!user.edit_price) PRICE_FIELDS.forEach((field)=>existing.id?output[field]=existing[field]:delete output[field]);
  if('custom_data' in output||!existing.id){
    const incoming=typeof output.custom_data==='string'?safeJson(output.custom_data,{}):output.custom_data;
    const original=safeJson(existing.custom_data,{});
    const fields=db.prepare('SELECT * FROM custom_fields').all();
    const custom={...original};
    for(const field of fields)if(field.status==='published'&&field.field_type!=='attachment'&&fieldPermission(user,field,'edit')&&Object.hasOwn(incoming||{},field.code))custom[field.code]=incoming[field.code];
    for(const field of fields)if(field.status==='published'&&fieldPermission(user,field,'edit')&&!Object.hasOwn(custom,field.code)){
      const settings=safeJson(field.settings_json,{});if(Object.hasOwn(settings,'defaultValue'))custom[field.code]=field.field_type==='boolean'?['true','1','是'].includes(String(settings.defaultValue)):field.field_type==='number'?Number(settings.defaultValue):settings.defaultValue;
    }
    output.custom_data=JSON.stringify(custom);
  }
  output.critical=output.critical?1:0;
  return output;
}

function validateDevice(input,user,id=0){
  const errors=[];
  if(!input.code?.trim())errors.push('设备编号必填');if(!input.name?.trim())errors.push('设备名称必填');if(!input.category?.trim())errors.push('设备分类必填');
  if(!input.department_id)errors.push('使用部门必填');else if(!canAccessDepartment(user,input.department_id))errors.push('无权选择该部门');
  if(db.prepare('SELECT id FROM devices WHERE code=? AND id<>?').get(input.code||'',id))errors.push('设备编号已存在');
  if(input.sn){const duplicate=db.prepare('SELECT code FROM devices WHERE sn=? AND deleted=0 AND id<>?').get(input.sn,id);if(duplicate)errors.push(`序列号与 ${duplicate.code} 重复`);}
  const custom=typeof input.custom_data==='string'?safeJson(input.custom_data,{}):(input.custom_data||{});
  const visible=(field)=>{const rule=safeJson(field.settings_json,{}).visibleWhen;if(!rule?.field)return true;const source=db.prepare('SELECT * FROM custom_fields WHERE code=?').get(rule.field);return source&&fieldPermission(user,source,'view')&&String(custom[rule.field]??'')===String(rule.equals??'');};
  for(const field of db.prepare("SELECT * FROM custom_fields WHERE required=1 AND status='published' AND field_type<>'attachment'").all()) if((field.category==='通用'||field.category===input.category)&&visible(field)&&fieldPermission(user,field,'edit')&&(custom[field.code]==null||custom[field.code]===''))errors.push(`${field.name}必填`);
  for(const field of db.prepare("SELECT * FROM custom_fields WHERE status='published'").all()){
    const value=custom[field.code];if(value==null||value==='')continue;
    const settings=safeJson(field.settings_json,{});if(settings.min!=null&&Number(value)<Number(settings.min))errors.push(`${field.name}不能小于${settings.min}`);if(settings.max!=null&&Number(value)>Number(settings.max))errors.push(`${field.name}不能大于${settings.max}`);if(settings.maxLength&&String(value).length>Number(settings.maxLength))errors.push(`${field.name}超过长度限制`);
    if(field.field_type==='number'&&!Number.isFinite(Number(value)))errors.push(`${field.name}必须为数字`);
    if(field.field_type==='boolean'&&typeof value!=='boolean')errors.push(`${field.name}必须为是或否`);
    if(field.field_type==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(String(value))||Number.isNaN(Date.parse(value))))errors.push(`${field.name}日期无效`);
    if(['select','multiselect'].includes(field.field_type)){
      const source=(field.validation_rule||'').startsWith('dictionary:')?db.prepare("SELECT name FROM dictionary_items WHERE dict_type=? AND status='active'").all(field.validation_rule.slice(11)).map((item)=>item.name):safeJson(field.options_json,[]);
      const selected=Array.isArray(value)?value:[value];if(selected.some((option)=>!source.includes(option)))errors.push(`${field.name}不在有效字典中`);
    }
    if(field.field_type==='device'&&!db.prepare('SELECT 1 FROM devices WHERE code=? AND deleted=0').get(String(value)))errors.push(`${field.name}引用的设备不存在`);
  }
  if(input.department_id&&!db.prepare("SELECT id FROM departments WHERE id=? AND status='active'").get(Number(input.department_id)))errors.push('使用部门不存在或已停用');
  for(const [type,value] of [['category',input.category],['status',input.status||'在用']])if(value&&!db.prepare("SELECT id FROM dictionary_items WHERE dict_type=? AND name=? AND status='active'").get(type,value))errors.push(`${type==='category'?'分类':'状态'}不在有效字典中`);
  for(const field of [...PRICE_FIELDS,'maintenance_cycle','calibration_cycle'])if(input[field]!=null&&input[field]!==''&&(!Number.isFinite(Number(input[field]))||Number(input[field])<0))errors.push(`${field}必须为非负数`);
  for(const field of ['purchase_date','start_date','warranty_end','next_maintenance','next_calibration','scrap_date'])if(input[field]&&(!/^\d{4}-\d{2}-\d{2}$/.test(input[field])||Number.isNaN(Date.parse(input[field]))||new Date(input[field]).toISOString().slice(0,10)!==input[field]))errors.push(`${field}日期无效，需使用YYYY-MM-DD`);
  return errors;
}

function importDevice(row){
  const map={'设备编号':'code','固定资产编号':'asset_code','序列号SN':'sn','设备名称':'name','设备分类':'category','型号规格':'model','品牌':'brand','生产厂商':'manufacturer','供应商':'vendor','采购日期':'purchase_date','启用日期':'start_date','采购原值':'purchase_price','采购单价':'unit_price','合同金额':'contract_amount','发票金额':'invoice_amount','残值':'residual_value','维修费用':'repair_cost','部门编码':'department_code','存放位置':'location','责任人':'owner','设备状态':'status','关键设备':'critical','保修截止日期':'warranty_end','维保周期(天)':'maintenance_cycle','下次维保日期':'next_maintenance','检定周期(天)':'calibration_cycle','下次检定日期':'next_calibration','报废日期':'scrap_date','备注':'notes'};
  const output={};const custom={};const customFields=db.prepare("SELECT code,name FROM custom_fields WHERE status='published'").all();for(const [key,value] of Object.entries(row)){const field=customFields.find((field)=>field.code===key||field.name===key);if(field)custom[field.code]=value;else output[map[key]||key]=value;}
  output.department_id=db.prepare("SELECT id FROM departments WHERE code=? AND status='active'").get(output.department_code)?.id||null;delete output.department_code;
  output.critical=['是','1','true','TRUE',true,1].includes(output.critical)?1:0;for(const field of [...PRICE_FIELDS,'maintenance_cycle','calibration_cycle'])if(output[field]!==''&&output[field]!=null)output[field]=Number(output[field]);output.custom_data=JSON.stringify(custom);return output;
}

export async function api(req,res,url){
  const accountResult=await publicAccount(req,res,url);if(accountResult!==false)return accountResult;
  if(req.method==='GET'&&url.pathname==='/api/health'){
    db.prepare('SELECT 1').get();
    return json(res,200,{status:'ok'});
  }
  if(req.method==='GET'&&url.pathname==='/api/runtime')return json(res,200,{demo:process.env.APP_ENV!=='production'});
  if(req.method==='GET'&&url.pathname==='/api/reminders'){
    const user=requireUser(req,res);if(!user)return;return json(res,200,{rows:reminderRows(user)});
  }
  if(req.method==='POST'&&url.pathname==='/api/login'){
    const ip=clientIp(req);const state=attempts.get(ip)||{count:0,until:0};
    if(state.until>Date.now())return fail(res,429,'登录尝试过多，请稍后再试');
    const body=await bodyJson(req,65536);const user=db.prepare('SELECT * FROM users WHERE username=?').get(body.username||'');
    if(!user||user.status!=='active'||!verifyPassword(body.password||'',user.password_salt,user.password_hash)){
      state.count++;if(state.count>=5){state.count=0;state.until=Date.now()+300000;}attempts.set(ip,state);audit(req,user,'login_failed','session',body.username,'登录失败');return fail(res,401,'用户名或密码错误');
    }
    if(user.mfa_enabled&&!verifyTotp(user.mfa_secret,body.mfaCode)){
      state.count++;if(state.count>=5){state.count=0;state.until=Date.now()+300000;}attempts.set(ip,state);audit(req,user,'login_failed','session',user.username,'动态验证码校验失败');return fail(res,401,'管理员动态验证码错误',{mfaRequired:true});
    }
    attempts.delete(ip);const token=randomToken();const csrf=randomToken(24);const expires=new Date(Date.now()+28800000).toISOString();
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now());db.prepare('INSERT INTO sessions(token,user_id,csrf_token,expires_at) VALUES(?,?,?,?)').run(token,user.id,csrf,expires);
    audit(req,user,'login','session',token.slice(0,8),'登录系统');return json(res,200,{ok:true},{'Set-Cookie':sessionCookie(token)});
  }
  if(req.method==='GET'&&url.pathname==='/api/demo-mfa'){
    if(process.env.APP_ENV==='production')return fail(res,404,'接口不存在');
    const admin=db.prepare("SELECT mfa_secret FROM users WHERE username='admin'").get();return json(res,200,{code:totp(admin.mfa_secret),expiresIn:30-(Math.floor(Date.now()/1000)%30)});
  }
  const user=requireUser(req,res);if(!user)return;
  const businessResult=await business(req,res,url,user);if(businessResult!==false)return businessResult;
  if(req.method==='POST'&&url.pathname==='/api/export-jobs'){
    if(!user.export_data)return fail(res,403,'无导出权限');const body=await bodyJson(req);const id=randomToken(16);const query=new URL('/api/export','http://localhost');for(const [key,value] of Object.entries(body.filters||{}))if(value!=null)query.searchParams.set(key,String(value));filters(query,user);
    for(const expired of db.prepare('SELECT id FROM export_jobs WHERE expires_at<? LIMIT 100').all(now())){await unlink(path.join(exportDirectory,`${expired.id}.xls`)).catch(()=>{});db.prepare('DELETE FROM export_jobs WHERE id=?').run(expired.id);}
    const fingerprint=exportFingerprint(user);db.prepare("INSERT INTO export_jobs(id,user_id,status,fingerprint,created_at,expires_at) VALUES(?,?,'pending',?,?,?)").run(id,user.id,fingerprint,now(),new Date(Date.now()+3600000).toISOString());
    setImmediate(async()=>{try{const {getUser}=await import('./security.mjs');const current=getUser(req);if(!current?.export_data||exportFingerprint(current)!==fingerprint)throw new Error('权限已变化，请重新发起导出');const result=buildExport(query,current);await writeFile(path.join(exportDirectory,`${id}.xls`),result.xml,{flag:'wx'});db.prepare("UPDATE export_jobs SET status='ready',device_ids=? WHERE id=?").run(JSON.stringify(result.ids),id);audit(req,current,'export','export_job',id,`异步导出设备${result.ids.length}条${result.containsPrice?'（含价格）':''}`);}catch(cause){db.prepare("UPDATE export_jobs SET status='failed',error=? WHERE id=?").run(cause.status?'无权使用该筛选':cause.message,id);}});
    return json(res,202,{id,status:'pending'});
  }
  const exportMatch=url.pathname.match(/^\/api\/export-jobs\/([a-f0-9]{32})(?:\/(download))?$/);
  if(exportMatch&&req.method==='GET'){
    const job=db.prepare('SELECT * FROM export_jobs WHERE id=? AND user_id=?').get(exportMatch[1],user.id);if(!job||!user.export_data)return fail(res,404,'导出任务不存在');if(new Date(job.expires_at)<new Date())return fail(res,410,'导出文件已过期，请重新导出');if(exportFingerprint(user)!==job.fingerprint)return fail(res,403,'权限已变化，请重新导出');
    if(!exportMatch[2])return json(res,200,{id:job.id,status:job.status,error:job.error});
    if(job.status!=='ready')return fail(res,409,'文件尚未生成');for(const id of safeJson(job.device_ids,[]))if(!deviceForUser(id,user))return fail(res,403,'设备数据范围发生变化，请重新导出');
    const data=await readFile(path.join(exportDirectory,`${job.id}.xls`));audit(req,user,'download_export','export_job',job.id,'下载台账导出文件');res.writeHead(200,{'Content-Type':'application/vnd.ms-excel; charset=utf-8','Content-Length':data.length,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(`设备台账-${now().slice(0,10)}.xls`)}`,'Cache-Control':'no-store'});return res.end(data);
  }
  if(req.method==='GET'&&url.pathname==='/api/backups'){
    if(user.role_code!=='super_admin')return fail(res,403,'无备份权限');return json(res,200,{rows:await listBackups()});
  }
  if(req.method==='POST'&&url.pathname==='/api/backup'){
    if(user.role_code!=='super_admin')return fail(res,403,'无备份权限');const fileName=await createBackup();audit(req,user,'backup','system',fileName,`创建数据库及附件备份：${fileName}`);return json(res,200,{ok:true,fileName});
  }
  if(req.method==='POST'&&url.pathname==='/api/backup/restore-check'){
    if(user.role_code!=='super_admin')return fail(res,403,'无恢复演练权限');const body=await bodyJson(req,65536);const target=path.join(paths.backups,`.restore-check-${randomToken(8)}`);
    try{const result=await restoreBackup(body.fileName,target);audit(req,user,'restore_check','system',body.fileName,`完成隔离恢复校验：${result.devices}台设备、${result.attachments}个附件`,null,result);return json(res,200,{ok:true,...result});}
    finally{await import('node:fs/promises').then(({rm})=>rm(target,{recursive:true,force:true}));}
  }
  if(req.method==='POST'&&url.pathname==='/api/logout'){const token=parseCookies(req).session;audit(req,user,'logout','session',token?.slice(0,8),'退出系统');db.prepare('DELETE FROM sessions WHERE token=?').run(token);return json(res,200,{ok:true},{'Set-Cookie':sessionCookie('',0)});}
  if(req.method==='GET'&&url.pathname==='/api/bootstrap')return json(res,200,{user:publicUser(user),system:{name:'设备台账管理系统',version:'V1.1'}});

  if(req.method==='GET'&&url.pathname==='/api/dashboard'){
    const scope=scopeClause(user,'d');const base=`d.deleted=0 AND ${scope.sql}`;const count=(condition='1=1')=>db.prepare(`SELECT COUNT(*) count FROM devices d WHERE ${base} AND ${condition}`).get(...scope.params).count;
    const status=db.prepare(`SELECT status label,COUNT(*) value FROM devices d WHERE ${base} GROUP BY status ORDER BY value DESC`).all(...scope.params);
    const urgent=db.prepare(`SELECT d.id,d.code,d.name,d.status,d.owner,d.warranty_end,d.next_maintenance,d.next_calibration,dep.name department_name FROM devices d LEFT JOIN departments dep ON dep.id=d.department_id WHERE ${base} AND (date(d.warranty_end)<=date('now','+30 day') OR date(d.next_maintenance)<=date('now','+30 day') OR date(d.next_calibration)<=date('now','+30 day')) ORDER BY COALESCE(d.next_maintenance,d.next_calibration,d.warranty_end) LIMIT 8`).all(...scope.params);
    const recent=user.view_audit?(user.data_scope==='all'?db.prepare('SELECT id,action,summary,user_name,created_at FROM audit_logs ORDER BY id DESC LIMIT 8').all():db.prepare('SELECT id,action,summary,user_name,created_at FROM audit_logs WHERE user_id=? ORDER BY id DESC LIMIT 8').all(user.id)):[];
    return json(res,200,{metrics:{total:count(),active:count("d.status='在用'"),repairing:count("d.status='维修'"),warrantySoon:count("date(d.warranty_end) BETWEEN date('now') AND date('now','+30 day')"),maintenanceDue:count("date(d.next_maintenance)<=date('now','+30 day')"),calibrationDue:count("date(d.next_calibration)<=date('now','+30 day')"),missingOwner:count("d.owner IS NULL OR TRIM(d.owner)=''"),missingAttachment:db.prepare(`SELECT COUNT(*) count FROM devices d WHERE ${base} AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.device_id=d.id)`).get(...scope.params).count,purchaseTotal:user.view_price?db.prepare(`SELECT COALESCE(SUM(purchase_price),0) total FROM devices d WHERE ${base}`).get(...scope.params).total:null},status,urgent,recent});
  }

  if(req.method==='GET'&&url.pathname==='/api/devices'){
    const query=filters(url,user);const page=Math.max(1,Number(url.searchParams.get('page')||1));const pageSize=Math.min(100,Math.max(10,Number(url.searchParams.get('pageSize')||20)));
    const allowed=new Set(['code','name','category','status','updated_at','warranty_end','next_maintenance']);const sort=allowed.has(url.searchParams.get('sort'))?url.searchParams.get('sort'):'updated_at';const direction=url.searchParams.get('direction')==='asc'?'ASC':'DESC';
    const total=db.prepare(`SELECT COUNT(*) count FROM devices d WHERE ${query.where}`).get(...query.params).count;
    const exact=url.searchParams.get('q')||'';
    const rows=db.prepare(`SELECT d.*,dep.name department_name FROM devices d LEFT JOIN departments dep ON dep.id=d.department_id WHERE ${query.where} ORDER BY CASE WHEN d.code=? THEN 0 ELSE 1 END,d.${sort} ${direction},d.id DESC LIMIT ? OFFSET ?`).all(...query.params,exact,pageSize,(page-1)*pageSize);
    if(user.view_price&&rows.length)audit(req,user,'view_price','device','list',`查看设备列表价格：${rows.length}条`);
    return json(res,200,{rows:rows.map((row)=>maskDevice(row,user)),total,page,pageSize});
  }

  const deviceMatch=url.pathname.match(/^\/api\/devices\/(\d+)$/);
  if(deviceMatch&&req.method==='GET'){
    const device=deviceForUser(Number(deviceMatch[1]),user);if(!device)return fail(res,404,'设备不存在或无权访问');
    const attachments=db.prepare('SELECT id,type,file_name,mime_type,size,uploaded_at,field_code FROM attachments WHERE device_id=? AND deleted=0 ORDER BY id DESC').all(device.id).filter((item)=>{
      if(SENSITIVE_FILE_TYPES.has(item.type)&&!user.sensitive_files)return false;
      const field=item.field_code?db.prepare('SELECT * FROM custom_fields WHERE code=?').get(item.field_code):null;
      return !item.field_code||field&&field.status==='published'&&fieldPermission(user,field,'view');
    });
    if(user.view_price)audit(req,user,'view_price','device',device.id,`查看设备价格：${device.code}`);
    return json(res,200,{device:maskDevice(device,user),attachments});
  }

  if(req.method==='POST'&&url.pathname==='/api/devices'){
    if(!user.manage_data)return fail(res,403,'无设备新增权限');
    const input=normalizeDevice(await bodyJson(req),user);if(!input.code)input.code=nextDeviceCode(input.department_id,input.category);const errors=validateDevice(input,user);if(errors.length)return fail(res,400,'设备数据校验失败',errors);
    const fields=Object.keys(input).filter((field)=>DEVICE_FIELDS.includes(field));const result=db.prepare(`INSERT INTO devices(${fields.join(',')},created_by,updated_by,created_at,updated_at) VALUES(${fields.map(()=>'?').join(',')},?,?,?,?)`).run(...fields.map((field)=>input[field]),user.id,user.id,now(),now());
    audit(req,user,'create','device',result.lastInsertRowid,`新增设备：${input.code}`,null,input);return json(res,201,{id:Number(result.lastInsertRowid)});
  }

  if(deviceMatch&&req.method==='PUT'){
    if(!user.manage_data)return fail(res,403,'无设备编辑权限');
    const id=Number(deviceMatch[1]);const old=deviceForUser(id,user);if(!old)return fail(res,404,'设备不存在或无权访问');const body=await bodyJson(req);
    if(Number(body.version)!==Number(old.version))return fail(res,409,'设备已被其他人修改，请刷新后重试');
    const input=normalizeDevice({...old,...body},user,old);const errors=validateDevice(input,user,id);if(errors.length)return fail(res,400,'设备数据校验失败',errors);
    if(input.status!==old.status){const workflow=configuration('workflow');if(!workflow.transitions[old.status]?.includes(input.status))return fail(res,400,`不允许从${old.status}转为${input.status}`);if(workflow.approvalRequired&&input.status==='报废')return fail(res,400,'请通过生命周期记录提交报废审批');}
    if(input.department_id!==old.department_id&&configuration('workflow').approvalRequired)return fail(res,400,'请通过生命周期记录提交调拨审批');
    const fields=Object.keys(input).filter((field)=>DEVICE_FIELDS.includes(field));db.prepare(`UPDATE devices SET ${fields.map((field)=>`${field}=?`).join(',')},version=version+1,updated_by=?,updated_at=? WHERE id=?`).run(...fields.map((field)=>input[field]),user.id,now(),id);
    audit(req,user,'update','device',id,`修改设备：${old.code}`,old,input);return json(res,200,{ok:true});
  }

  if(deviceMatch&&req.method==='DELETE'){
    if(!user.delete_data)return fail(res,403,'无删除权限');const id=Number(deviceMatch[1]);const old=deviceForUser(id,user);if(!old)return fail(res,404,'设备不存在或无权访问');
    db.prepare('UPDATE devices SET deleted=1,updated_by=?,updated_at=? WHERE id=?').run(user.id,now(),id);audit(req,user,'delete','device',id,`软删除设备：${old.code}`,old,{deleted:true});return json(res,200,{ok:true});
  }

  const attachmentList=url.pathname.match(/^\/api\/devices\/(\d+)\/attachments$/);
  if(attachmentList&&req.method==='POST'){
    if(!user.manage_data)return fail(res,403,'无附件上传权限');
    const device=deviceForUser(Number(attachmentList[1]),user);if(!device)return fail(res,404,'设备不存在或无权访问');const body=await bodyJson(req);
    const {fileName:name,mimeType,data,type}=validateAttachment(body);
    if(SENSITIVE_FILE_TYPES.has(type)&&!user.sensitive_files)return fail(res,403,'无合同/发票附件权限');
    const field=body.fieldCode?db.prepare("SELECT * FROM custom_fields WHERE code=? AND status='published'").get(body.fieldCode):null;
    if(body.fieldCode&&(!field||field.field_type!=='attachment'||!fieldPermission(user,field,'edit')))return fail(res,403,'无权上传至该附件字段');
    const storage=`${Date.now()}-${randomToken(8)}`;await writeFile(path.join(paths.uploads,storage),data,{flag:'wx'});
    let result;
    try{result=db.prepare('INSERT INTO attachments(device_id,type,file_name,mime_type,size,storage_name,uploaded_by,field_code) VALUES(?,?,?,?,?,?,?,?)').run(device.id,type,name,mimeType,data.length,storage,user.id,field?.code||null);if(field){const custom=safeJson(db.prepare('SELECT custom_data FROM devices WHERE id=?').get(device.id).custom_data,{});custom[field.code]=[...(Array.isArray(custom[field.code])?custom[field.code]:[]),Number(result.lastInsertRowid)];db.prepare('UPDATE devices SET custom_data=?,version=version+1,updated_by=?,updated_at=? WHERE id=?').run(JSON.stringify(custom),user.id,now(),device.id);}}catch(cause){await unlink(path.join(paths.uploads,storage)).catch(()=>{});throw cause;}
    audit(req,user,'upload_attachment','attachment',result.lastInsertRowid,`上传附件：${name}`);return json(res,201,{id:Number(result.lastInsertRowid)});
  }

  const attachmentMatch=url.pathname.match(/^\/api\/attachments\/(\d+)(?:\/(download|preview))?$/);
  if(attachmentMatch&&req.method==='GET'&&attachmentMatch[2]){
    const item=db.prepare('SELECT a.*,d.department_id,d.owner FROM attachments a JOIN devices d ON d.id=a.device_id WHERE a.id=? AND a.deleted=0 AND d.deleted=0').get(Number(attachmentMatch[1]));
    if(!item||!deviceForUser(item.device_id,user))return fail(res,404,'附件不存在或无权访问');if(SENSITIVE_FILE_TYPES.has(item.type)&&!user.sensitive_files)return fail(res,403,'无合同/发票附件权限');
    if(item.field_code){const field=db.prepare('SELECT * FROM custom_fields WHERE code=?').get(item.field_code);if(!field||field.status!=='published'||!fieldPermission(user,field,'view'))return fail(res,403,'无附件字段查看权限');}
    const preview=attachmentMatch[2]==='preview';if(preview&&!previewMimes.has(item.mime_type))return fail(res,400,'此文件请下载后查看');
    const file=path.join(paths.uploads,item.storage_name);if(!existsSync(file))return fail(res,404,'附件文件已丢失');const data=await readFile(file);audit(req,user,preview?'preview_attachment':'download_attachment','attachment',item.id,`${preview?'预览':'下载'}附件：${item.file_name}`);
    res.writeHead(200,{'Content-Type':item.mime_type,'Content-Length':data.length,'Content-Disposition':`${preview?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(item.file_name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'self'; sandbox"});return res.end(data);
  }
  if(attachmentMatch&&req.method==='DELETE'){
    if(!user.manage_data)return fail(res,403,'无附件删除权限');const item=db.prepare('SELECT a.* FROM attachments a WHERE a.id=? AND a.deleted=0').get(Number(attachmentMatch[1]));if(!item||!deviceForUser(item.device_id,user))return fail(res,404,'附件不存在或无权访问');if(SENSITIVE_FILE_TYPES.has(item.type)&&!user.sensitive_files)return fail(res,403,'无合同/发票附件权限');
    if(item.field_code){const field=db.prepare('SELECT * FROM custom_fields WHERE code=?').get(item.field_code);if(!field||!fieldPermission(user,field,'edit'))return fail(res,403,'无附件字段修改权限');const device=db.prepare('SELECT custom_data FROM devices WHERE id=?').get(item.device_id);const custom=safeJson(device.custom_data,{});custom[item.field_code]=(Array.isArray(custom[item.field_code])?custom[item.field_code]:[]).filter((id)=>id!==item.id);db.prepare('UPDATE devices SET custom_data=?,version=version+1,updated_by=?,updated_at=? WHERE id=?').run(JSON.stringify(custom),user.id,now(),item.device_id);}
    db.prepare('UPDATE attachments SET deleted=1 WHERE id=?').run(item.id);audit(req,user,'delete_attachment','attachment',item.id,`停用附件：${item.file_name}`);return json(res,200,{ok:true});
  }

  if(req.method==='GET'&&url.pathname==='/api/departments'){
    const rows=db.prepare(`SELECT d.*,p.name parent_name,(SELECT COUNT(*) FROM devices v WHERE v.department_id=d.id AND v.deleted=0) device_count FROM departments d LEFT JOIN departments p ON p.id=d.parent_id ORDER BY d.sort_order,d.id`).all();
    return json(res,200,{rows,manageableIds:user.data_scope==='all'?rows.map((row)=>row.id):descendants(user.department_id)});
  }
  if(req.method==='POST'&&url.pathname==='/api/departments'){
    if(!user.manage_config)return fail(res,403,'无部门配置权限');const body=await bodyJson(req);if(body.parent_id&&!canAccessDepartment(user,body.parent_id))return fail(res,403,'无权在该部门下创建');if(!body.code?.trim()||!body.name?.trim())return fail(res,400,'部门编码和名称必填');
    if(user.data_scope!=='all'&&!body.parent_id)return fail(res,403,'部门管理员只能在本部门及下级新建子部门');
    try{const result=db.prepare('INSERT INTO departments(code,name,parent_id,manager,sort_order,status) VALUES(?,?,?,?,?,?)').run(body.code.trim(),body.name.trim(),body.parent_id||null,body.manager||'',Number(body.sort_order||0),body.status||'active');audit(req,user,'create','department',result.lastInsertRowid,`新增部门：${body.name}`,null,body);return json(res,201,{id:Number(result.lastInsertRowid)});}catch{return fail(res,400,'部门编码已存在');}
  }
  const deptMatch=url.pathname.match(/^\/api\/departments\/(\d+)$/);
  if(deptMatch&&req.method==='PUT'){
    if(!user.manage_config)return fail(res,403,'无部门配置权限');const id=Number(deptMatch[1]);if(!canAccessDepartment(user,id))return fail(res,403,'无权修改该部门');const old=db.prepare('SELECT * FROM departments WHERE id=?').get(id);if(!old)return fail(res,404,'部门不存在');const body=await bodyJson(req);
    if('parent_id' in body&&Number(body.parent_id||0)!==Number(old.parent_id||0)){
      if(user.role_code!=='super_admin')return fail(res,403,'部门层级调整仅允许平台管理员执行');
      if(body.parent_id&&(descendants(id).includes(Number(body.parent_id))||!db.prepare('SELECT id FROM departments WHERE id=?').get(Number(body.parent_id))))return fail(res,400,'上级部门无效或会形成循环');
      db.prepare('UPDATE departments SET parent_id=? WHERE id=?').run(body.parent_id?Number(body.parent_id):null,id);
    }
    db.prepare('UPDATE departments SET name=?,manager=?,sort_order=?,status=? WHERE id=?').run(body.name||old.name,body.manager??old.manager,Number(body.sort_order??old.sort_order),body.status||old.status,id);audit(req,user,'update','department',id,`修改部门：${old.name}`,old,body);return json(res,200,{ok:true});
  }

  if(req.method==='GET'&&url.pathname==='/api/dictionaries'){
    const type=url.searchParams.get('type');const allowed=user.data_scope==='all'?null:descendants(user.department_id);const condition=allowed?`(department_id IS NULL OR department_id IN(${allowed.map(()=>'?').join(',')||'NULL'}))`:'1=1';const rows=db.prepare(`SELECT * FROM dictionary_items WHERE ${condition}${type?' AND dict_type=?':''} ORDER BY dict_type,sort_order,id`).all(...(allowed||[]),...(type?[type]:[]));return json(res,200,{rows});
  }
  if(req.method==='POST'&&url.pathname==='/api/dictionaries'){
    if(!user.manage_config)return fail(res,403,'无字典配置权限');const body=await bodyJson(req);if(!body.dict_type||!body.code||!body.name)return fail(res,400,'字典类型、编码和名称必填');const department=user.role_code==='department_admin'?user.department_id:(body.department_id||null);
    if(body.dict_type==='status')return fail(res,400,'底层状态固定，请在状态流配置中设置转换规则');
    if(!['category','location','vendor','brand'].includes(body.dict_type))return fail(res,400,'字典类型无效');
    if(db.prepare('SELECT id FROM dictionary_items WHERE dict_type=? AND code=? AND department_id IS ?').get(body.dict_type,body.code,department))return fail(res,400,'字典编码已存在');
    try{const result=db.prepare('INSERT INTO dictionary_items(dict_type,code,name,department_id,sort_order,status) VALUES(?,?,?,?,?,?)').run(body.dict_type,body.code,body.name,department,Number(body.sort_order||0),body.status||'active');audit(req,user,'create','dictionary',result.lastInsertRowid,`新增字典项：${body.name}`,null,body);return json(res,201,{id:Number(result.lastInsertRowid)});}catch{return fail(res,400,'字典编码已存在');}
  }
  const dictMatch=url.pathname.match(/^\/api\/dictionaries\/(\d+)$/);
  if(dictMatch&&req.method==='PUT'){
    if(!user.manage_config)return fail(res,403,'无字典配置权限');const id=Number(dictMatch[1]);const old=db.prepare('SELECT * FROM dictionary_items WHERE id=?').get(id);if(!old)return fail(res,404,'字典项不存在');if(user.role_code==='department_admin'&&old.department_id!==user.department_id)return fail(res,403,'只能维护本部门字典');const body=await bodyJson(req);
    if(old.dict_type==='status'&&(body.name&&body.name!==old.name||body.status==='disabled'))return fail(res,400,'系统底层状态不可重命名或停用');
    db.prepare('UPDATE dictionary_items SET name=?,sort_order=?,status=? WHERE id=?').run(body.name||old.name,Number(body.sort_order??old.sort_order),body.status||old.status,id);audit(req,user,'update','dictionary',id,`修改字典项：${old.name}`,old,body);return json(res,200,{ok:true});
  }

  if(req.method==='GET'&&url.pathname==='/api/custom-fields'){
    const rows=db.prepare('SELECT * FROM custom_fields ORDER BY sort_order,id').all().map((row)=>({...row,options:safeJson(row.options_json,[])}));return json(res,200,{rows});
  }
  if(req.method==='POST'&&url.pathname==='/api/custom-fields'){
    if(!user.manage_config||user.role_code==='department_admin')return fail(res,403,'只有平台管理员可创建全局字段');const body=await bodyJson(req);if(!body.code?.match(/^[a-z][a-z0-9_]{1,30}$/)||!body.name||!body.field_type)return fail(res,400,'字段编码需为小写字母开头，且名称和类型必填');
    try{const result=db.prepare(`INSERT INTO custom_fields(code,name,field_type,category,required,sensitive,filterable,exportable,options_json,validation_rule,sort_order,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(body.code,body.name,body.field_type,body.category||'通用',body.required?1:0,body.sensitive?1:0,body.filterable?1:0,body.exportable?1:0,JSON.stringify(body.options||[]),body.validation_rule||null,Number(body.sort_order||0),body.status||'draft');audit(req,user,'create','custom_field',result.lastInsertRowid,`新增自定义字段：${body.name}`,null,body);return json(res,201,{id:Number(result.lastInsertRowid)});}catch{return fail(res,400,'字段编码已存在');}
  }
  const fieldMatch=url.pathname.match(/^\/api\/custom-fields\/(\d+)$/);
  if(fieldMatch&&req.method==='PUT'){
    if(!user.manage_config||user.role_code==='department_admin')return fail(res,403,'只有平台管理员可修改全局字段');const id=Number(fieldMatch[1]);const old=db.prepare('SELECT * FROM custom_fields WHERE id=?').get(id);if(!old)return fail(res,404,'字段不存在');const body=await bodyJson(req);
    db.prepare(`UPDATE custom_fields SET name=?,field_type=?,category=?,required=?,sensitive=?,filterable=?,exportable=?,options_json=?,validation_rule=?,sort_order=?,status=? WHERE id=?`).run(body.name||old.name,body.field_type||old.field_type,body.category||old.category,body.required?1:0,body.sensitive?1:0,body.filterable?1:0,body.exportable?1:0,JSON.stringify(body.options||safeJson(old.options_json,[])),body.validation_rule??old.validation_rule,Number(body.sort_order??old.sort_order),body.status||old.status,id);audit(req,user,'update','custom_field',id,`修改自定义字段：${old.name}`,old,body);return json(res,200,{ok:true});
  }

  if(req.method==='POST'&&url.pathname==='/api/config/publish'){
    if(!user.manage_config||user.role_code==='department_admin')return fail(res,403,'无配置发布权限');db.prepare("UPDATE custom_fields SET status='published' WHERE status='draft'").run();const content=JSON.stringify(db.prepare('SELECT * FROM custom_fields ORDER BY sort_order,id').all());const next=db.prepare("SELECT COALESCE(MAX(version_no),0)+1 value FROM config_versions WHERE config_type='custom_fields'").get().value;const result=db.prepare("INSERT INTO config_versions(config_type,version_no,content,published_by) VALUES('custom_fields',?,?,?)").run(next,content,user.id);audit(req,user,'publish_config','config_version',result.lastInsertRowid,`发布字段配置 V${next}`);return json(res,200,{version:next});
  }
  if(req.method==='GET'&&url.pathname==='/api/config/versions'){
    const rows=db.prepare("SELECT v.id,v.version_no,v.status,v.published_at,u.name published_by_name FROM config_versions v LEFT JOIN users u ON u.id=v.published_by WHERE config_type='custom_fields' ORDER BY version_no DESC LIMIT 20").all();return json(res,200,{rows});
  }
  const rollback=url.pathname.match(/^\/api\/config\/versions\/(\d+)\/rollback$/);
  if(rollback&&req.method==='POST'){
    if(!user.manage_config||user.role_code==='department_admin')return fail(res,403,'无配置回滚权限');const version=db.prepare("SELECT * FROM config_versions WHERE id=? AND config_type='custom_fields'").get(Number(rollback[1]));if(!version)return fail(res,404,'配置版本不存在');const fields=safeJson(version.content,[]);
    db.exec('BEGIN');try{db.prepare('DELETE FROM custom_fields').run();const insert=db.prepare(`INSERT INTO custom_fields(id,code,name,field_type,category,required,sensitive,filterable,exportable,options_json,validation_rule,sort_order,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);for(const field of fields)insert.run(field.id,field.code,field.name,field.field_type,field.category,field.required,field.sensitive,field.filterable,field.exportable,field.options_json,field.validation_rule,field.sort_order,field.status,field.created_at);db.exec('COMMIT');}catch(cause){db.exec('ROLLBACK');throw cause;}
    audit(req,user,'rollback_config','config_version',version.id,`回滚字段配置至 V${version.version_no}`);return json(res,200,{ok:true});
  }

  if(req.method==='GET'&&url.pathname==='/api/roles')return json(res,200,{rows:db.prepare('SELECT * FROM roles ORDER BY id').all()});
  const roleMatch=url.pathname.match(/^\/api\/roles\/(\d+)$/);
  if(roleMatch&&req.method==='PUT'){
    if(!user.manage_users||user.role_code!=='super_admin')return fail(res,403,'只有超级管理员可修改角色权限');const id=Number(roleMatch[1]);const old=db.prepare('SELECT * FROM roles WHERE id=?').get(id);if(!old)return fail(res,404,'角色不存在');const body=await bodyJson(req);const keys=['data_scope','view_price','edit_price','export_price','view_sensitive','sensitive_files','manage_config','manage_users','manage_data','import_data','export_data','delete_data','view_audit'];const values=keys.map((key)=>key==='data_scope'?(body[key]||old[key]):(body[key]?1:0));db.prepare(`UPDATE roles SET ${keys.map((key)=>`${key}=?`).join(',')} WHERE id=?`).run(...values,id);audit(req,user,'update_permission','role',id,`修改角色权限：${old.name}`,old,body);return json(res,200,{ok:true});
  }
  if(req.method==='GET'&&url.pathname==='/api/users'){
    if(!user.manage_users)return fail(res,403,'无用户管理权限');const rows=db.prepare(`SELECT u.id,u.username,u.name,u.status,u.mfa_enabled,u.created_at,r.name role_name,d.name department_name FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN departments d ON d.id=u.department_id ORDER BY u.id`).all();return json(res,200,{rows});
  }
  if(req.method==='GET'&&url.pathname==='/api/audit'){
    if(!user.view_audit)return fail(res,403,'无审计日志权限');const page=Math.max(1,Number(url.searchParams.get('page')||1));const pageSize=Math.min(100,Number(url.searchParams.get('pageSize')||30));const action=url.searchParams.get('action');const where=action?'WHERE action=?':'';const params=action?[action]:[];const total=db.prepare(`SELECT COUNT(*) count FROM audit_logs ${where}`).get(...params).count;const rows=db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params,pageSize,(page-1)*pageSize);return json(res,200,{rows,total,page,pageSize});
  }
  if(req.method==='GET'&&url.pathname==='/api/reminders'){
    const scope=scopeClause(user,'d');const rows=db.prepare(`SELECT d.id,d.code,d.name,d.owner,dep.name department_name,d.warranty_end,d.next_maintenance,d.next_calibration,CASE WHEN date(d.next_maintenance)<=date('now','+30 day') THEN '维保到期' WHEN date(d.next_calibration)<=date('now','+30 day') THEN '校准到期' ELSE '保修到期' END reminder_type FROM devices d LEFT JOIN departments dep ON dep.id=d.department_id WHERE d.deleted=0 AND ${scope.sql} AND (date(d.next_maintenance)<=date('now','+30 day') OR date(d.next_calibration)<=date('now','+30 day') OR date(d.warranty_end)<=date('now','+30 day')) ORDER BY COALESCE(d.next_maintenance,d.next_calibration,d.warranty_end) LIMIT 200`).all(...scope.params);return json(res,200,{rows});
  }

  if(req.method==='GET'&&url.pathname==='/api/views'){
    const rows=db.prepare(`SELECT v.id,v.name,v.scope,v.config,v.created_at,u.name created_by_name FROM saved_views v JOIN users u ON u.id=v.user_id WHERE v.user_id=? OR (v.scope='department' AND u.department_id=?) ORDER BY v.id DESC`).all(user.id,user.department_id).map((row)=>({...row,config:safeJson(row.config,{})}));return json(res,200,{rows});
  }
  if(req.method==='POST'&&url.pathname==='/api/views'){
    const body=await bodyJson(req);if(!body.name?.trim())return fail(res,400,'视图名称必填');const scope=body.scope==='department'?'department':'personal';if(scope==='department'&&!user.manage_config)return fail(res,403,'无部门共享视图权限');const config={};for(const [key,value] of Object.entries(body.config||{})){if(['page','pageSize','sort','direction','columns','q','category','status','location','owner','department_id','critical','missing_owner','warranty_soon','maintenance_due','calibration_due'].includes(key))config[key]=value;else if(key.startsWith('custom_')){const field=db.prepare("SELECT sensitive,filterable FROM custom_fields WHERE code=? AND status='published'").get(key.slice(7));if(field?.filterable&&(!field.sensitive||user.view_sensitive))config[key]=String(value).slice(0,256);}}if(Array.isArray(config.columns))config.columns=config.columns.filter((key)=>(!PRICE_FIELDS.includes(key)||user.view_price)&&(!key.startsWith('custom_')||user.view_sensitive||!db.prepare('SELECT sensitive FROM custom_fields WHERE code=?').get(key.slice(7))?.sensitive));const result=db.prepare('INSERT INTO saved_views(name,user_id,scope,config) VALUES(?,?,?,?)').run(body.name.trim(),user.id,scope,JSON.stringify(config));audit(req,user,'create','saved_view',result.lastInsertRowid,`保存${scope==='department'?'部门':'个人'}视图：${body.name}`);return json(res,201,{id:Number(result.lastInsertRowid)});
  }
  const viewMatch=url.pathname.match(/^\/api\/views\/(\d+)$/);
  if(viewMatch&&req.method==='DELETE'){
    const view=db.prepare('SELECT * FROM saved_views WHERE id=?').get(Number(viewMatch[1]));if(!view||(view.user_id!==user.id&&user.role_code!=='super_admin'))return fail(res,404,'视图不存在或无权删除');db.prepare('DELETE FROM saved_views WHERE id=?').run(view.id);audit(req,user,'delete','saved_view',view.id,`删除保存视图：${view.name}`);return json(res,200,{ok:true});
  }

  if(req.method==='POST'&&url.pathname==='/api/import/preview'){
    if(!user.import_data)return fail(res,403,'无导入权限');const body=await bodyJson(req,4*1024*1024);if(!Array.isArray(body.rows)||body.rows.length>2000)return fail(res,400,'导入数据必须为不超过2000行的数组');const seen=new Set();const rows=body.rows.map((row,index)=>{const input=importDevice(row);const old=db.prepare('SELECT * FROM devices WHERE code=? AND deleted=0').get(input.code||'');const device=normalizeDevice(input,user,old||{});const errors=validateDevice(device,user,old?.id||0);if(old&&!deviceForUser(old.id,user))errors.push('重复设备不在当前账号数据范围内');if(seen.has(device.code))errors.push('文件内设备编号重复');seen.add(device.code);return{rowNumber:index+2,device:maskDevice(device,user),duplicate:!!old,errors};});return json(res,200,{rows,validCount:rows.filter((row)=>!row.errors.length).length,errorCount:rows.filter((row)=>row.errors.length).length});
  }
  if(req.method==='POST'&&url.pathname==='/api/import/commit'){
    if(!user.import_data)return fail(res,403,'无导入权限');const body=await bodyJson(req,4*1024*1024);const strategy=['skip','update','error'].includes(body.strategy)?body.strategy:'error';const rows=Array.isArray(body.rows)?body.rows.slice(0,2000):[];let inserted=0,updated=0,skipped=0;const failures=[];
    db.exec('BEGIN');try{const seen=new Set();for(let index=0;index<rows.length;index++){const device=importDevice(rows[index]);const old=db.prepare('SELECT * FROM devices WHERE code=? AND deleted=0').get(device.code||'');if(old&&!deviceForUser(old.id,user)){failures.push({rowNumber:index+2,errors:['重复设备不在当前账号数据范围内']});continue;}if(seen.has(device.code)){failures.push({rowNumber:index+2,errors:['文件内设备编号重复']});continue;}seen.add(device.code);const input=normalizeDevice({...old,...device},user,old||{});const errors=validateDevice(input,user,old?.id||0);if(old&&((input.status&&input.status!==old.status)||Number(input.department_id)!==old.department_id))errors.push('导入不能改变已有设备状态或部门，请使用生命周期流程');if(errors.length){failures.push({rowNumber:index+2,errors});continue;}if(old){if(strategy==='skip'){skipped++;continue;}if(strategy==='error'){failures.push({rowNumber:index+2,errors:['设备编号已存在']});continue;}const fields=Object.keys(input).filter((field)=>DEVICE_FIELDS.includes(field));db.prepare(`UPDATE devices SET ${fields.map((field)=>`${field}=?`).join(',')},version=version+1,updated_by=?,updated_at=? WHERE id=?`).run(...fields.map((field)=>input[field]),user.id,now(),old.id);updated++;}else{const fields=Object.keys(input).filter((field)=>DEVICE_FIELDS.includes(field));db.prepare(`INSERT INTO devices(${fields.join(',')},created_by,updated_by,created_at,updated_at) VALUES(${fields.map(()=>'?').join(',')},?,?,?,?)`).run(...fields.map((field)=>input[field]),user.id,user.id,now(),now());inserted++;}}db.exec('COMMIT');}catch(cause){db.exec('ROLLBACK');throw cause;}
    audit(req,user,'import','device','batch',`导入设备：新增${inserted}，更新${updated}，跳过${skipped}，失败${failures.length}`);return json(res,200,{inserted,updated,skipped,failures});
  }

  if(req.method==='GET'&&url.pathname==='/api/export'){
    if(!user.export_data)return fail(res,403,'无导出权限');const query=filters(url,user);const rows=db.prepare(`SELECT d.*,dep.name department_name FROM devices d LEFT JOIN departments dep ON dep.id=d.department_id WHERE ${query.where} ORDER BY d.code LIMIT 10000`).all(...query.params);
    const labels={code:'设备编号',asset_code:'固定资产编号',sn:'序列号SN',name:'设备名称',category:'设备分类',model:'型号规格',brand:'品牌',manufacturer:'生产厂商',vendor:'供应商',purchase_date:'采购日期',start_date:'启用日期',department_name:'使用部门',location:'存放位置',owner:'责任人',status:'设备状态',warranty_end:'保修截止日期',maintenance_cycle:'维保周期(天)',next_maintenance:'下次维保日期',calibration_cycle:'检定周期(天)',next_calibration:'下次检定日期',scrap_date:'报废日期',critical:'关键设备',notes:'备注',purchase_price:'采购原值',unit_price:'采购单价',contract_amount:'合同金额',invoice_amount:'发票金额',residual_value:'残值',repair_cost:'维修费用'};
    const customFields=db.prepare("SELECT * FROM custom_fields WHERE status='published' AND exportable=1").all().filter((field)=>fieldPermission(user,field,'export'));for(const field of customFields)labels[`custom_${field.code}`]=field.name;
    const columns=(configuration('export').columns||[]).filter((key)=>Object.hasOwn(labels,key)&&(!PRICE_FIELDS.includes(key)||user.export_price));const headers=columns.map((key)=>({key,label:labels[key],number:PRICE_FIELDS.includes(key)}));
    const exportRows=rows.map((row)=>{const custom=maskDevice(row,user).custom_data;return Object.fromEntries(columns.map((key)=>[key,key==='critical'?(row.critical?'是':'否'):key.startsWith('custom_')?custom[key.slice(7)]:row[key]]));});
    const xml=spreadsheet(headers,exportRows);audit(req,user,'export','device','batch',`导出设备${rows.length}条${columns.some((key)=>PRICE_FIELDS.includes(key))?'（含价格）':''}`);res.writeHead(200,{'Content-Type':'application/vnd.ms-excel; charset=utf-8','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(`设备台账-${now().slice(0,10)}.xls`)}`,'Content-Length':Buffer.byteLength(xml),'Cache-Control':'no-store'});return res.end(xml);
  }
  return fail(res,404,'接口不存在');
}
