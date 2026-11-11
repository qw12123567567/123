import { randomBytes } from 'node:crypto';
import { db,passwordHash,PRICE_FIELDS } from './db.mjs';
import { scopeClause,audit,safeJson,randomToken,fieldPermission } from './security.mjs';
import { json,fail,bodyJson } from './http.mjs';
import { calculateFormula,formulaDependencies } from './formula.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS lifecycle_records(
 id INTEGER PRIMARY KEY,device_id INTEGER NOT NULL REFERENCES devices(id),record_type TEXT NOT NULL,
 record_date TEXT NOT NULL,description TEXT,person TEXT,to_department_id INTEGER REFERENCES departments(id),
 due_date TEXT,cost REAL,next_date TEXT,previous_status TEXT,status TEXT DEFAULT 'completed',
 created_by INTEGER REFERENCES users(id),approved_by INTEGER REFERENCES users(id),created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_lifecycle_device ON lifecycle_records(device_id,created_at);
CREATE TABLE IF NOT EXISTS application_config(
 config_key TEXT PRIMARY KEY,published TEXT NOT NULL,draft TEXT,version INTEGER DEFAULT 1,updated_by INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS department_config(department_id INTEGER REFERENCES departments(id),config_key TEXT,published TEXT,draft TEXT,version INTEGER DEFAULT 1,updated_by INTEGER REFERENCES users(id),PRIMARY KEY(department_id,config_key));
CREATE TABLE IF NOT EXISTS reminder_reads(user_id INTEGER REFERENCES users(id),message_key TEXT,read_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(user_id,message_key));
CREATE TABLE IF NOT EXISTS field_drafts(field_id INTEGER PRIMARY KEY,content TEXT NOT NULL,updated_by INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS field_permissions(role_id INTEGER REFERENCES roles(id),field_code TEXT,can_view INTEGER,can_edit INTEGER,can_export INTEGER,PRIMARY KEY(role_id,field_code));
CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires_at TEXT NOT NULL,used INTEGER DEFAULT 0);
`);
const userColumns=db.prepare('PRAGMA table_info(users)').all().map((column)=>column.name);
if(!userColumns.includes('email'))db.exec("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''");
if(!db.prepare('PRAGMA table_info(custom_fields)').all().some((column)=>column.name==='settings_json'))db.exec("ALTER TABLE custom_fields ADD COLUMN settings_json TEXT DEFAULT '{}'");

export const configDefaults={
 numbering:{pattern:'{department}-{category}-{year}-{sequence}',digits:4},
 reminders:{days:30,mailEnabled:false,recipients:''},
 workflow:{approvalRequired:false,transitions:{'在用':['闲置','维修','借出','报废'],'闲置':['在用','维修','借出','报废'],'维修':['在用','闲置','报废'],'借出':['在用','维修'],'报废':[]}},
 label:{showName:true,showDepartment:true,showOwner:true},
 export:{columns:['code','name','category','model','department_name','location','owner','status','purchase_price','warranty_end','next_maintenance','next_calibration']},
 form:{groups:['basic','management','lifecycle','prices','technical','attachments']},
};
for(const [key,value] of Object.entries(configDefaults))db.prepare('INSERT OR IGNORE INTO application_config(config_key,published) VALUES(?,?)').run(key,JSON.stringify(value));
export function configuration(key,departmentId=null){
  if(departmentId&&['form','label','reminders'].includes(key)){
    const ancestry=db.prepare('WITH RECURSIVE chain(id,parent_id,depth) AS(SELECT id,parent_id,0 FROM departments WHERE id=? UNION ALL SELECT d.id,d.parent_id,chain.depth+1 FROM departments d JOIN chain ON d.id=chain.parent_id) SELECT id FROM chain ORDER BY depth').all(Number(departmentId));
    for(const department of ancestry){const row=db.prepare('SELECT published FROM department_config WHERE department_id=? AND config_key=?').get(department.id,key);if(row?.published)return safeJson(row.published,configDefaults[key]);}
  }
  return safeJson(db.prepare('SELECT published FROM application_config WHERE config_key=?').get(key)?.published,configDefaults[key]);
}

export function nextDeviceCode(departmentId,category){
  const department=db.prepare('SELECT code FROM departments WHERE id=?').get(Number(departmentId));
  const shortCodes={'计算机设备':'PC','网络设备':'NET','生产设备':'MCH','检测仪器':'INS','办公设备':'OFF'};
  const dictionary=db.prepare("SELECT code FROM dictionary_items WHERE dict_type='category' AND name=?").get(category);
  const rule=configuration('numbering');
  const template=rule.pattern.replaceAll('{department}',department?.code||'HQ').replaceAll('{category}',shortCodes[category]||dictionary?.code||'DEV').replaceAll('{year}',String(new Date().getFullYear()));
  const [prefix,suffix='']=template.split('{sequence}');
  let sequence=1;
  for(const row of db.prepare('SELECT code FROM devices WHERE code LIKE ?').all(`${prefix}%${suffix}`)){
    const part=row.code.slice(prefix.length,suffix?-suffix.length:undefined);
    if(/^\d+$/.test(part))sequence=Math.max(sequence,Number(part)+1);
  }
  return `${prefix}${String(sequence).padStart(rule.digits,'0')}${suffix}`;
}

function scopedDevice(id,user){const scope=scopeClause(user);return db.prepare(`SELECT d.* FROM devices d WHERE id=? AND deleted=0 AND ${scope.sql}`).get(id,...scope.params);}
function isPlatform(user){return user.role_code==='super_admin'&&user.manage_users;}
function newMfaSecret(){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';const source=randomBytes(20);let bits='';for(const value of source)bits+=value.toString(2).padStart(8,'0');let result='';for(let index=0;index<bits.length;index+=5)result+=alphabet[parseInt(bits.slice(index,index+5),2)];return result;}
function safeUser(id){return db.prepare('SELECT id,username,name,email,role_id,department_id,status,mfa_enabled FROM users WHERE id=?').get(id);}
const recordTypes=new Set(['维保','校准','报修','维修','领用','借出','归还','调拨','报废']);
const roleKeys=['view_price','edit_price','export_price','view_sensitive','sensitive_files','manage_config','manage_users','manage_data','import_data','export_data','delete_data','view_audit'];

function validateConfiguration(key,value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('配置格式无效');
  if(key==='numbering'){
    if(typeof value.pattern!=='string'||value.pattern.length>120||!value.pattern.includes('{sequence}')||/[^a-zA-Z0-9_{}\-]/.test(value.pattern))throw new Error('编号模板只能包含英文、数字、横线和编号占位符');
    if(!Number.isInteger(Number(value.digits))||value.digits<3||value.digits>8)throw new Error('流水位数必须为3至8');
  }
  if(key==='reminders'&&(!Number.isInteger(Number(value.days))||value.days<1||value.days>365))throw new Error('提醒提前天数必须为1至365');
  if(key==='workflow'){
    const states=Object.keys(configDefaults.workflow.transitions);
    if(!value.transitions||Object.entries(value.transitions).some(([state,targets])=>!states.includes(state)||!Array.isArray(targets)||targets.some((target)=>!states.includes(target))))throw new Error('状态转换只能使用系统固定状态');
  }
  if(key==='export'&&(!Array.isArray(value.columns)||value.columns.length>60||value.columns.some((column)=>!/^\w{1,64}$/.test(column))))throw new Error('导出列配置无效');
  if(key==='form'&&(!Array.isArray(value.groups)||value.groups.length!==6||new Set(value.groups).size!==6||value.groups.some((group)=>!configDefaults.form.groups.includes(group))))throw new Error('表单分组必须包含全部六个分组');
  return {...configDefaults[key],...value};
}

function applyRecord(record,device,user){
  const changes={};
  if(['维保','维修'].includes(record.record_type)){changes.next_maintenance=record.next_date||device.next_maintenance;if(record.record_type==='维修')changes.status='在用';if(user.edit_price&&record.cost!=null)changes.repair_cost=Number(device.repair_cost||0)+Number(record.cost);}
  if(record.record_type==='校准')changes.next_calibration=record.next_date||device.next_calibration;
  if(record.record_type==='报修')changes.status='维修';
  if(record.record_type==='借出'){changes.status='借出';changes.owner=record.person;}
  if(record.record_type==='领用'){changes.status='在用';changes.owner=record.person;}
  if(record.record_type==='归还')changes.status='在用';
  if(record.record_type==='调拨')changes.department_id=record.to_department_id;
  if(record.record_type==='报废'){changes.status='报废';changes.scrap_date=record.record_date;}
  if(changes.status&&changes.status!==device.status&&!configuration('workflow').transitions[device.status]?.includes(changes.status))throw Object.assign(new Error(`不允许从${device.status}转为${changes.status}`),{status:400});
  const keys=Object.keys(changes);if(keys.length)db.prepare(`UPDATE devices SET ${keys.map((key)=>`${key}=?`).join(',')},version=version+1,updated_by=?,updated_at=? WHERE id=?`).run(...keys.map((key)=>changes[key]),user.id,new Date().toISOString(),device.id);
}

export async function business(req,res,url,user){
  if(req.method==='GET'&&url.pathname==='/api/trash'){
    if(!user.delete_data)return fail(res,403,'无回收站权限');const scope=scopeClause(user);return json(res,200,{rows:db.prepare(`SELECT d.id,d.code,d.name,d.updated_at,p.name department_name FROM devices d LEFT JOIN departments p ON p.id=d.department_id WHERE d.deleted=1 AND ${scope.sql} ORDER BY d.updated_at DESC`).all(...scope.params)});
  }
  const restoreMatch=url.pathname.match(/^\/api\/devices\/(\d+)\/restore$/);
  if(restoreMatch&&req.method==='POST'){
    if(!user.delete_data)return fail(res,403,'无设备恢复权限');const scope=scopeClause(user);const device=db.prepare(`SELECT d.* FROM devices d WHERE d.id=? AND d.deleted=1 AND ${scope.sql}`).get(Number(restoreMatch[1]),...scope.params);if(!device)return fail(res,404,'设备不存在或无恢复权限');db.prepare('UPDATE devices SET deleted=0,version=version+1,updated_by=?,updated_at=? WHERE id=?').run(user.id,new Date().toISOString(),device.id);audit(req,user,'restore','device',device.id,`恢复设备：${device.code}`);return json(res,200,{ok:true});
  }
  if(req.method==='GET'&&url.pathname==='/api/next-device-code'){
    if(!user.manage_data)return fail(res,403,'无新增权限');return json(res,200,{code:nextDeviceCode(url.searchParams.get('department_id')||user.department_id,url.searchParams.get('category')||'计算机设备')});
  }
  if(req.method==='GET'&&url.pathname==='/api/published-config')return json(res,200,{numbering:configuration('numbering'),reminders:configuration('reminders',user.department_id),label:configuration('label',user.department_id),workflow:configuration('workflow'),form:configuration('form',user.department_id)});
  if(req.method==='POST'&&url.pathname==='/api/reminders/read'){
    const body=await bodyJson(req);if(typeof body.key!=='string'||body.key.length>200)return fail(res,400,'消息标识无效');db.prepare('INSERT OR REPLACE INTO reminder_reads(user_id,message_key) VALUES(?,?)').run(user.id,body.key);return json(res,200,{ok:true});
  }
  if(req.method==='GET'&&url.pathname==='/api/custom-fields'){
    const drafts=url.searchParams.get('drafts')==='1'&&user.role_code==='super_admin';
    const rows=db.prepare(`SELECT * FROM custom_fields ${drafts?'':"WHERE status='published'"} ORDER BY sort_order,id`).all().map((row)=>{
      const saved=drafts?db.prepare('SELECT content FROM field_drafts WHERE field_id=?').get(row.id):null;
      const draft=saved?safeJson(saved.content,{}):{};
      const effective={...row,...draft};const dictionaryType=(effective.validation_rule||'').startsWith('dictionary:')?effective.validation_rule.slice(11):null;
      const options=dictionaryType?db.prepare("SELECT name FROM dictionary_items WHERE dict_type=? AND status='active' ORDER BY sort_order,id").all(dictionaryType).map((item)=>item.name):safeJson(effective.options_json,[]);
      return{...effective,status:saved?'draft':row.status,options,dictionary_type:dictionaryType,settings:safeJson(effective.settings_json,{})};
    });return json(res,200,{rows});
  }
  if(req.method==='POST'&&url.pathname==='/api/custom-fields'){
    if(user.role_code!=='super_admin'||!user.manage_config)return fail(res,403,'只有平台管理员可创建全局字段');const body=await bodyJson(req);
    const types=['text','textarea','number','date','datetime','select','multiselect','boolean','person','department','location','device','formula','attachment'];
    if(!/^[a-z][a-z0-9_]{1,30}$/.test(body.code||'')||!body.name?.trim()||!types.includes(body.field_type))return fail(res,400,'字段名称、编码或类型无效');
    if(['select','multiselect'].includes(body.field_type)&&!body.dictionary_type)return fail(res,400,'下拉字段必须绑定字典');
    if(body.dictionary_type&&!db.prepare("SELECT 1 FROM dictionary_items WHERE dict_type=? AND status='active' LIMIT 1").get(body.dictionary_type))return fail(res,400,'该字典类型不存在或没有可用选项');
    if(body.field_type==='formula'){
      const references=formulaDependencies(body.formula);const values={};for(const key of references){const source=db.prepare("SELECT * FROM custom_fields WHERE code=? AND status='published'").get(key);if(!PRICE_FIELDS.includes(key)&&source?.field_type!=='number')return fail(res,400,'公式只能引用价格字段或已发布的数字字段');values[key]=2+Object.keys(values).length;if(PRICE_FIELDS.includes(key)||source?.sensitive)body.sensitive=true;}
      try{calculateFormula(body.formula,values);}catch(cause){return fail(res,400,cause.message);}
      body.validation_rule=`formula:${body.formula}`;body.filterable=false;body.required=false;
    }
    if(body.settings){if(typeof body.settings!=='object'||Array.isArray(body.settings))return fail(res,400,'字段规则无效');if(body.settings.visibleWhen?.field&&!db.prepare("SELECT code FROM custom_fields WHERE code=? AND status='published'").get(body.settings.visibleWhen.field))return fail(res,400,'显隐控制字段必须是已发布字段');}
    try{const result=db.prepare('INSERT INTO custom_fields(code,name,field_type,category,required,sensitive,filterable,exportable,options_json,validation_rule,sort_order,status,settings_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(body.code,body.name.trim(),body.field_type,body.category||'通用',body.required?1:0,body.sensitive?1:0,body.filterable?1:0,body.exportable?1:0,JSON.stringify(body.options||[]),body.dictionary_type?`dictionary:${body.dictionary_type}`:body.validation_rule||null,Number(body.sort_order||0),'draft',JSON.stringify(body.settings||{}));audit(req,user,'draft_config','custom_field',result.lastInsertRowid,`新增字段草稿：${body.name}`);return json(res,201,{id:Number(result.lastInsertRowid)});}catch{return fail(res,400,'字段编码已存在');}
  }
  const fieldUpdate=url.pathname.match(/^\/api\/custom-fields\/(\d+)$/);
  if(fieldUpdate&&req.method==='PUT'){
    if(user.role_code!=='super_admin'||!user.manage_config)return fail(res,403,'只有平台管理员可修改全局字段');const old=db.prepare('SELECT * FROM custom_fields WHERE id=?').get(Number(fieldUpdate[1]));if(!old)return fail(res,404,'字段不存在');const body=await bodyJson(req);const draft={...old,name:body.name?.trim()||old.name,category:body.category||old.category,required:body.required?1:0,sensitive:body.sensitive?1:0,filterable:body.filterable?1:0,exportable:body.exportable?1:0,sort_order:Number(body.sort_order||0),status:body.status==='disabled'?'disabled':'published',options_json:JSON.stringify(body.options||safeJson(old.options_json,[])),validation_rule:body.dictionary_type?`dictionary:${body.dictionary_type}`:old.validation_rule};
    if(body.dictionary_type&&!db.prepare("SELECT 1 FROM dictionary_items WHERE dict_type=? AND status='active' LIMIT 1").get(body.dictionary_type))return fail(res,400,'该字典类型不存在或没有可用选项');
    if(old.field_type==='formula'){
      const references=formulaDependencies(old.validation_rule?.slice(8));draft.sensitive=references.some((key)=>PRICE_FIELDS.includes(key)||db.prepare('SELECT sensitive FROM custom_fields WHERE code=?').get(key)?.sensitive)?1:draft.sensitive;draft.required=0;draft.filterable=0;
    }
    if(body.settings)draft.settings_json=JSON.stringify(body.settings);
    db.prepare('INSERT INTO field_drafts(field_id,content,updated_by) VALUES(?,?,?) ON CONFLICT(field_id) DO UPDATE SET content=excluded.content,updated_by=excluded.updated_by').run(old.id,JSON.stringify(draft),user.id);audit(req,user,'draft_config','custom_field',old.id,`修改字段草稿：${old.name}`);return json(res,200,{ok:true});
  }
  if(req.method==='POST'&&url.pathname==='/api/config/publish'){
    if(user.role_code!=='super_admin'||!user.manage_config)return fail(res,403,'无发布权限');db.exec('BEGIN');try{
      const current=db.prepare("SELECT * FROM custom_fields WHERE status<>'draft'").all();const next=db.prepare("SELECT COALESCE(MAX(version_no),0)+1 value FROM config_versions WHERE config_type='custom_fields'").get().value;
      db.prepare("INSERT INTO config_versions(config_type,version_no,content,published_by) VALUES('custom_fields',?,?,?)").run(next,JSON.stringify(current),user.id);
      for(const saved of db.prepare('SELECT * FROM field_drafts').all()){const field=safeJson(saved.content,{});db.prepare('UPDATE custom_fields SET name=?,category=?,required=?,sensitive=?,filterable=?,exportable=?,sort_order=?,status=?,options_json=?,validation_rule=?,settings_json=? WHERE id=?').run(field.name,field.category,field.required,field.sensitive,field.filterable,field.exportable,field.sort_order,field.status,field.options_json,field.validation_rule,field.settings_json||'{}',field.id);}
      db.prepare("UPDATE custom_fields SET status='published' WHERE status='draft'").run();db.prepare('DELETE FROM field_drafts').run();const version=next+1;db.prepare("INSERT INTO config_versions(config_type,version_no,content,published_by) VALUES('custom_fields',?,?,?)").run(version,JSON.stringify(db.prepare('SELECT * FROM custom_fields').all()),user.id);audit(req,user,'publish_config','configuration','custom_fields',`发布字段配置 V${version}`);db.exec('COMMIT');return json(res,200,{version});
    }catch(cause){db.exec('ROLLBACK');throw cause;}
  }
  const fieldRollback=url.pathname.match(/^\/api\/config\/versions\/(\d+)\/rollback$/);
  if(fieldRollback&&req.method==='POST'){
    if(user.role_code!=='super_admin'||!user.manage_config)return fail(res,403,'无回滚权限');
    const version=db.prepare("SELECT * FROM config_versions WHERE id=? AND config_type='custom_fields'").get(Number(fieldRollback[1]));
    if(!version)return fail(res,404,'版本不存在');
    const fields=safeJson(version.content,[]);db.exec('BEGIN');
    try{
      const next=db.prepare("SELECT COALESCE(MAX(version_no),0)+1 value FROM config_versions WHERE config_type='custom_fields'").get().value;
      db.prepare("INSERT INTO config_versions(config_type,version_no,content,published_by) VALUES('custom_fields',?,?,?)").run(next,JSON.stringify(db.prepare('SELECT * FROM custom_fields').all()),user.id);
      db.prepare("UPDATE custom_fields SET status='disabled'").run();
      for(const field of fields){
        const keys=['code','name','field_type','category','required','sensitive','filterable','exportable','options_json','validation_rule','sort_order','status','settings_json'];
        db.prepare(`INSERT INTO custom_fields(id,${keys.join(',')}) VALUES(?,${keys.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${keys.map((key)=>`${key}=excluded.${key}`).join(',')}`).run(field.id,...keys.map((key)=>field[key]??(key==='settings_json'?'{}':null)));
      }
      db.prepare('DELETE FROM field_drafts').run();
      audit(req,user,'rollback_config','configuration','custom_fields',`回滚字段配置至V${version.version_no}`);
      db.exec('COMMIT');return json(res,200,{ok:true});
    }catch(cause){db.exec('ROLLBACK');throw cause;}
  }
  if(req.method==='GET'&&url.pathname==='/api/users'){
    if(!isPlatform(user))return fail(res,403,'无用户管理权限');return json(res,200,{rows:db.prepare('SELECT u.id,u.username,u.name,u.email,u.role_id,u.department_id,u.status,u.mfa_enabled,u.created_at,r.name role_name,d.name department_name FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN departments d ON d.id=u.department_id ORDER BY u.id').all()});
  }
  if(url.pathname==='/api/field-permissions'){
    if(!isPlatform(user))return fail(res,403,'无字段权限管理权限');
    if(req.method==='GET')return json(res,200,{rows:db.prepare('SELECT * FROM field_permissions').all(),fields:db.prepare("SELECT code,name,sensitive FROM custom_fields WHERE status='published'").all()});
    if(req.method==='PUT'){
      const body=await bodyJson(req);const role=db.prepare('SELECT * FROM roles WHERE id=?').get(Number(body.role_id));const field=db.prepare("SELECT * FROM custom_fields WHERE code=? AND status='published'").get(body.field_code);if(!role||!field)return fail(res,400,'角色或字段无效');
      if((body.can_edit||body.can_export)&&!body.can_view)return fail(res,400,'修改和导出必须同时有查看权限');
      db.prepare('INSERT INTO field_permissions(role_id,field_code,can_view,can_edit,can_export) VALUES(?,?,?,?,?) ON CONFLICT(role_id,field_code) DO UPDATE SET can_view=excluded.can_view,can_edit=excluded.can_edit,can_export=excluded.can_export').run(role.id,field.code,body.can_view?1:0,body.can_edit?1:0,body.can_export?1:0);audit(req,user,'update_permission','custom_field',field.code,`修改${role.name}字段授权：${field.name}`);return json(res,200,{ok:true});
    }
  }
  const roleUpdate=url.pathname.match(/^\/api\/roles\/(\d+)$/);
  if(roleUpdate&&req.method==='PUT'){
    if(!isPlatform(user))return fail(res,403,'无角色管理权限');const old=db.prepare('SELECT * FROM roles WHERE id=?').get(Number(roleUpdate[1]));if(!old)return fail(res,404,'角色不存在');const body=await bodyJson(req);const scope=body.data_scope||old.data_scope;if(!['all','department_descendants','self'].includes(scope))return fail(res,400,'数据范围无效');if(old.code==='super_admin'&&(scope!=='all'||body.manage_users===false||body.manage_config===false))return fail(res,400,'平台管理员必须保留配置和账号管理权限');if(old.code==='department_admin'&&(scope!=='department_descendants'||body.manage_users))return fail(res,400,'部门管理员的数据范围和授权边界不可放宽');
    db.prepare(`UPDATE roles SET data_scope=?,${roleKeys.map((key)=>`${key}=?`).join(',')} WHERE id=?`).run(scope,...roleKeys.map((key)=>key in body?(body[key]?1:0):old[key]),old.id);audit(req,user,'update_permission','role',old.id,`修改角色权限：${old.name}`,old,{...old,...body});return json(res,200,{ok:true});
  }
  if(req.method==='GET'&&url.pathname==='/api/audit'){
    if(!user.view_audit)return fail(res,403,'无审计日志权限');const page=Math.max(1,parseInt(url.searchParams.get('page')||'1',10)||1);const pageSize=Math.min(100,Math.max(10,parseInt(url.searchParams.get('pageSize')||'30',10)||30));const conditions=[];const parameters=[];
    if(user.data_scope!=='all'){const scope=scopeClause(user);conditions.push(`(user_id=? OR (object_type='device' AND object_id IN(SELECT CAST(d.id AS TEXT) FROM devices d WHERE ${scope.sql})))`);parameters.push(user.id,...scope.params);}
    if(url.searchParams.get('action')){conditions.push('action=?');parameters.push(url.searchParams.get('action'));}
    if(url.searchParams.get('device_id')){conditions.push("object_type='device' AND object_id=?");parameters.push(url.searchParams.get('device_id'));}
    const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';const total=db.prepare(`SELECT COUNT(*) count FROM audit_logs ${where}`).get(...parameters).count;
    const sensitive=db.prepare('SELECT * FROM custom_fields').all().filter((field)=>!fieldPermission(user,field,'view')).map((field)=>field.code);
    function redact(value){if(Array.isArray(value))return value.map(redact);if(!value||typeof value!=='object')return value;const result={};for(const [key,item] of Object.entries(value)){if((!user.view_price&&PRICE_FIELDS.includes(key))||sensitive.includes(key))continue;if(['password_hash','password_salt','mfa_secret','csrf_token'].includes(key))continue;result[key]=key==='custom_data'&&typeof item==='string'?JSON.stringify(redact(safeJson(item,{}))):redact(item);}return result;}
    const rows=db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...parameters,pageSize,(page-1)*pageSize).map((row)=>({...row,old_value:row.old_value?JSON.stringify(redact(safeJson(row.old_value,{}))):null,new_value:row.new_value?JSON.stringify(redact(safeJson(row.new_value,{}))):null}));return json(res,200,{rows,total,page,pageSize});
  }
  if(req.method==='GET'&&url.pathname==='/api/quality'){
    const scope=scopeClause(user);const rows=db.prepare(`SELECT d.*,(SELECT COUNT(*) FROM attachments a WHERE a.device_id=d.id) attachment_count FROM devices d WHERE deleted=0 AND ${scope.sql}`).all(...scope.params);
    const required=['code','name','category','department_id','location','owner','status'];let complete=0;const issues=[];
    for(const row of rows){const missing=required.filter((field)=>row[field]==null||row[field]==='');complete+=required.length-missing.length;if(missing.length||!row.attachment_count)issues.push({id:row.id,code:row.code,name:row.name,missing,attachmentMissing:!row.attachment_count});}
    return json(res,200,{total:rows.length,completeness:rows.length?Math.round(complete/(rows.length*required.length)*1000)/10:100,issues});
  }

  if(req.method==='GET'&&url.pathname==='/api/views'){
    const rows=db.prepare(`SELECT v.id,v.name,v.scope,v.config,v.created_at,u.name created_by_name FROM saved_views v JOIN users u ON u.id=v.user_id WHERE v.user_id=? OR (v.scope='department' AND u.department_id=?) ORDER BY v.id DESC`).all(user.id,user.department_id).map((row)=>{
      const config=safeJson(row.config,{});if(!user.view_price)delete config.purchase_price;
      for(const field of db.prepare('SELECT * FROM custom_fields').all())if(!fieldPermission(user,field,'view'))delete config[`custom_${field.code}`];
      if(Array.isArray(config.columns))config.columns=config.columns.filter((key)=>(!PRICE_FIELDS.includes(key)||user.view_price)&&(!key.startsWith('custom_')||user.view_sensitive||!db.prepare('SELECT sensitive FROM custom_fields WHERE code=?').get(key.slice(7))?.sensitive));
      return{...row,config};
    });return json(res,200,{rows});
  }
  if(req.method==='POST'&&url.pathname==='/api/views'){
    const body=await bodyJson(req);if(!body.name?.trim())return fail(res,400,'视图名称必填');const scope=body.scope==='department'?'department':'personal';if(scope==='department'&&!user.manage_config)return fail(res,403,'无部门共享视图权限');
    const config={};for(const [key,value] of Object.entries(body.config||{})){if(['page','pageSize','sort','direction','columns','q','category','status','location','owner','department_id','critical','missing_owner','warranty_soon','maintenance_due','calibration_due'].includes(key))config[key]=value;else if(key.startsWith('custom_')){const field=db.prepare("SELECT sensitive,filterable FROM custom_fields WHERE code=? AND status='published'").get(key.slice(7));if(field?.filterable&&(!field.sensitive||user.view_sensitive))config[key]=String(value).slice(0,256);}}
    if(Array.isArray(config.columns))config.columns=config.columns.filter((key)=>(!PRICE_FIELDS.includes(key)||user.view_price)&&(!key.startsWith('custom_')||user.view_sensitive||!db.prepare('SELECT sensitive FROM custom_fields WHERE code=?').get(key.slice(7))?.sensitive));
    const result=db.prepare('INSERT INTO saved_views(name,user_id,scope,config) VALUES(?,?,?,?)').run(body.name.trim(),user.id,scope,JSON.stringify(config));audit(req,user,'create','saved_view',result.lastInsertRowid,`保存${scope==='department'?'部门':'个人'}视图：${body.name}`);return json(res,201,{id:Number(result.lastInsertRowid)});
  }

  if(req.method==='POST'&&url.pathname==='/api/roles'){
    if(!isPlatform(user))return fail(res,403,'无角色管理权限');const body=await bodyJson(req);if(!/^[a-z][a-z0-9_]{2,30}$/.test(body.code||'')||!body.name?.trim())return fail(res,400,'角色名称及合法编码必填');
    const scope=['all','department_descendants','self'].includes(body.data_scope)?body.data_scope:'self';
    try{const result=db.prepare(`INSERT INTO roles(code,name,data_scope,${roleKeys.join(',')}) VALUES(?,?,?,${roleKeys.map(()=>'?').join(',')})`).run(body.code,body.name.trim(),scope,...roleKeys.map((key)=>body[key]?1:0));audit(req,user,'create','role',result.lastInsertRowid,`创建角色：${body.name}`);return json(res,201,{id:Number(result.lastInsertRowid)});}catch{return fail(res,400,'角色编码已存在');}
  }

  if(req.method==='POST'&&url.pathname==='/api/users'){
    if(!isPlatform(user))return fail(res,403,'无账号管理权限');const body=await bodyJson(req);if(!/^[A-Za-z0-9._-]{3,64}$/.test(body.username||'')||!body.name?.trim()||String(body.password||'').length<12)return fail(res,400,'账号至少3位，姓名必填，密码至少12位');
    const role=db.prepare('SELECT * FROM roles WHERE id=?').get(Number(body.role_id));const department=db.prepare("SELECT id FROM departments WHERE id=? AND status='active'").get(Number(body.department_id));if(!role||!department)return fail(res,400,'角色或部门无效');
    const credentials=passwordHash(body.password);const mfa=role.code.includes('admin')||role.manage_users||role.manage_config||body.mfa_enabled?1:0;const secret=mfa?newMfaSecret():null;
    try{const result=db.prepare('INSERT INTO users(username,password_hash,password_salt,name,email,role_id,department_id,mfa_enabled,mfa_secret) VALUES(?,?,?,?,?,?,?,?,?)').run(body.username,credentials.hash,credentials.salt,body.name.trim(),body.email||'',role.id,department.id,mfa,secret);audit(req,user,'create','user',result.lastInsertRowid,`创建账号：${body.username}`);return json(res,201,{id:Number(result.lastInsertRowid),mfaSecret:secret,otpUrl:secret?`otpauth://totp/AssetLedger:${encodeURIComponent(body.username)}?secret=${secret}&issuer=AssetLedger`:null});}catch{return fail(res,400,'账号已存在');}
  }
  const userMatch=url.pathname.match(/^\/api\/users\/(\d+)$/);
  if(userMatch&&req.method==='PUT'){
    if(!isPlatform(user))return fail(res,403,'无账号管理权限');const id=Number(userMatch[1]);const old=safeUser(id);if(!old)return fail(res,404,'账号不存在');const body=await bodyJson(req);const roleId=Number(body.role_id||old.role_id);const departmentId=Number(body.department_id||old.department_id);const status=body.status||old.status;
    const role=db.prepare('SELECT * FROM roles WHERE id=?').get(roleId);if(!role||!db.prepare('SELECT id FROM departments WHERE id=?').get(departmentId)||!['active','disabled'].includes(status))return fail(res,400,'账号配置无效');
    if(id===user.id&&(status!=='active'||role.code!=='super_admin'))return fail(res,400,'不能停用自己或移除自己的平台管理权限');
    if((role.code.includes('admin')||role.manage_users||role.manage_config)&&!old.mfa_enabled)return fail(res,400,'请先通过动态验证设置启用该账号MFA');
    db.prepare('UPDATE users SET name=?,email=?,role_id=?,department_id=?,status=? WHERE id=?').run(body.name?.trim()||old.name,body.email??old.email,roleId,departmentId,status,id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    audit(req,user,'update','user',id,`修改账号：${old.username}`,old,safeUser(id));return json(res,200,{ok:true});
  }
  const resetMatch=url.pathname.match(/^\/api\/users\/(\d+)\/reset-password$/);
  const mfaMatch=url.pathname.match(/^\/api\/users\/(\d+)\/mfa$/);
  if(mfaMatch&&req.method==='POST'){
    if(!isPlatform(user))return fail(res,403,'无账号管理权限');const target=safeUser(Number(mfaMatch[1]));if(!target)return fail(res,404,'账号不存在');if(target.id===user.id)return fail(res,400,'自己的动态验证请联系另一名平台管理员变更');const secret=newMfaSecret();db.prepare('UPDATE users SET mfa_enabled=1,mfa_secret=? WHERE id=?').run(secret,target.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);audit(req,user,'reset_mfa','user',target.id,'重置账号动态验证绑定');return json(res,200,{mfaSecret:secret,otpUrl:`otpauth://totp/AssetLedger:${encodeURIComponent(target.username)}?secret=${secret}&issuer=AssetLedger`});
  }
  if(resetMatch&&req.method==='POST'){
    if(!isPlatform(user))return fail(res,403,'无密码重置权限');const id=Number(resetMatch[1]);if(!safeUser(id))return fail(res,404,'账号不存在');const password=`Reset-${randomToken(12)}9a`;const hashed=passwordHash(password);db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').run(hashed.hash,hashed.salt,id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);audit(req,user,'reset_password','user',id,'管理员重置账号密码');return json(res,200,{password});
  }
  if(req.method==='POST'&&url.pathname==='/api/account/password'){
    const body=await bodyJson(req);const {verifyPassword}=await import('./security.mjs');if(!verifyPassword(body.currentPassword||'',user.password_salt,user.password_hash))return fail(res,400,'当前密码不正确');if(String(body.newPassword||'').length<12)return fail(res,400,'新密码至少12位');const hashed=passwordHash(body.newPassword);db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').run(hashed.hash,hashed.salt,user.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);audit(req,user,'change_password','user',user.id,'修改自己的登录密码');return json(res,200,{ok:true});
  }

  const recordsMatch=url.pathname.match(/^\/api\/devices\/(\d+)\/records$/);
  if(recordsMatch){
    const device=scopedDevice(Number(recordsMatch[1]),user);if(!device)return fail(res,404,'设备不存在或无权访问');
    if(req.method==='GET'){
      const rows=db.prepare('SELECT l.*,u.name created_by_name,p.name target_department_name FROM lifecycle_records l LEFT JOIN users u ON u.id=l.created_by LEFT JOIN departments p ON p.id=l.to_department_id WHERE l.device_id=? ORDER BY l.id DESC').all(device.id);if(!user.view_price)rows.forEach((row)=>delete row.cost);return json(res,200,{rows});
    }
    if(req.method==='POST'){
      const body=await bodyJson(req);if(!recordTypes.has(body.record_type))return fail(res,400,'记录类型无效');if(!user.manage_data&&body.record_type!=='报修')return fail(res,403,'无生命周期维护权限');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(body.record_date||'')||!body.description?.trim())return fail(res,400,'发生日期和记录内容必填');
      for(const key of ['record_date','due_date','next_date'])if(body[key]&&(!/^\d{4}-\d{2}-\d{2}$/.test(body[key])||Number.isNaN(Date.parse(body[key]))||new Date(body[key]).toISOString().slice(0,10)!==body[key]))return fail(res,400,'日期格式或日期值无效');
      if(body.cost!=null&&body.cost!==''&&(!Number.isFinite(Number(body.cost))||Number(body.cost)<0))return fail(res,400,'费用必须为非负数');
      if(['领用','借出'].includes(body.record_type)&&!body.person?.trim())return fail(res,400,'领用人或借用人必填');if(body.record_type==='借出'&&!body.due_date)return fail(res,400,'预计归还日期必填');
      if(body.record_type==='调拨'){
        if(!body.to_department_id)return fail(res,400,'目标部门必填');const scope=scopeClause(user);const {canAccessDepartment}=await import('./security.mjs');if(!canAccessDepartment(user,body.to_department_id)||!db.prepare("SELECT id FROM departments WHERE id=? AND status='active'").get(Number(body.to_department_id)))return fail(res,403,'无权调拨到目标部门');
      }
      const approval=configuration('workflow').approvalRequired&&['调拨','报废'].includes(body.record_type);const record={...body,device_id:device.id,cost:user.edit_price&&body.cost!==''?Number(body.cost||0):null,status:approval?'pending':'completed'};
      db.exec('BEGIN');try{const result=db.prepare('INSERT INTO lifecycle_records(device_id,record_type,record_date,description,person,to_department_id,due_date,cost,next_date,previous_status,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(device.id,record.record_type,record.record_date,record.description,record.person||null,record.to_department_id?Number(record.to_department_id):null,record.due_date||null,record.cost,record.next_date||null,device.status,record.status,user.id);if(!approval)applyRecord(record,device,user);audit(req,user,'lifecycle','device',device.id,`${record.record_type}：${device.code}${approval?'（待审批）':''}`);db.exec('COMMIT');return json(res,201,{id:Number(result.lastInsertRowid),status:record.status});}catch(cause){db.exec('ROLLBACK');throw cause;}
    }
  }
  const approvalMatch=url.pathname.match(/^\/api\/records\/(\d+)\/approve$/);
  if(approvalMatch&&req.method==='POST'){
    if(!user.manage_data||user.role_code==='staff')return fail(res,403,'无审批权限');const record=db.prepare('SELECT * FROM lifecycle_records WHERE id=?').get(Number(approvalMatch[1]));const device=record&&scopedDevice(record.device_id,user);if(!device||record.status!=='pending')return fail(res,404,'待审批记录不存在');if(record.created_by===user.id)return fail(res,403,'申请人不能审批自己的申请');const body=await bodyJson(req);const status=body.approved?'completed':'rejected';db.exec('BEGIN');try{if(body.approved)applyRecord(record,device,user);db.prepare('UPDATE lifecycle_records SET status=?,approved_by=? WHERE id=?').run(status,user.id,record.id);audit(req,user,'approve','device',device.id,`${body.approved?'批准':'拒绝'}${record.record_type}申请`);db.exec('COMMIT');return json(res,200,{ok:true});}catch(cause){db.exec('ROLLBACK');throw cause;}
  }

  if(req.method==='GET'&&url.pathname==='/api/configuration'){
    if(!user.manage_config)return fail(res,403,'无配置权限');
    if(user.role_code==='department_admin')return json(res,200,{rows:['form','label','reminders'].map((key)=>{const row=db.prepare('SELECT * FROM department_config WHERE department_id=? AND config_key=?').get(user.department_id,key);return{config_key:key,version:row?.version||1,published:configuration(key,user.department_id),draft:row?.draft?safeJson(row.draft,{}):null,scope:'department'};})});
    return json(res,200,{rows:db.prepare('SELECT * FROM application_config').all().map((row)=>({...row,published:safeJson(row.published,{}),draft:row.draft?safeJson(row.draft,{}):null}))});
  }
  const configMatch=url.pathname.match(/^\/api\/configuration\/(\w+)(?:\/(publish|versions|rollback))?$/);
  if(configMatch&&user.role_code==='department_admin'){
    if(!user.manage_config||!['form','label','reminders'].includes(configMatch[1]))return fail(res,403,'部门管理员仅可配置本部门表单、标签和提醒');
    const key=configMatch[1];const configType=`department:${user.department_id}:${key}`;let old=db.prepare('SELECT * FROM department_config WHERE department_id=? AND config_key=?').get(user.department_id,key);
    if(!old){db.prepare('INSERT INTO department_config(department_id,config_key,published) VALUES(?,?,?)').run(user.department_id,key,JSON.stringify(configuration(key,user.department_id)));old=db.prepare('SELECT * FROM department_config WHERE department_id=? AND config_key=?').get(user.department_id,key);}
    if(req.method==='PUT'&&!configMatch[2]){const body=await bodyJson(req);try{const value=validateConfiguration(key,body);db.prepare('UPDATE department_config SET draft=?,updated_by=? WHERE department_id=? AND config_key=?').run(JSON.stringify(value),user.id,user.department_id,key);audit(req,user,'draft_config','department',user.department_id,`保存部门${key}草稿`);const scope=scopeClause(user);return json(res,200,{ok:true,affectedDevices:db.prepare(`SELECT COUNT(*) count FROM devices d WHERE d.deleted=0 AND ${scope.sql}`).get(...scope.params).count});}catch(cause){return fail(res,400,cause.message);}}
    if(req.method==='GET'&&configMatch[2]==='versions')return json(res,200,{rows:db.prepare('SELECT id,version_no,published_at FROM config_versions WHERE config_type=? ORDER BY id DESC').all(configType)});
    if(req.method==='POST'&&configMatch[2]==='publish'){
      if(!old.draft)return fail(res,400,'没有可发布的草稿');db.exec('BEGIN');try{db.prepare('INSERT INTO config_versions(config_type,version_no,content,published_by) VALUES(?,?,?,?)').run(configType,old.version,old.published,user.id);db.prepare('UPDATE department_config SET published=draft,draft=NULL,version=version+1 WHERE department_id=? AND config_key=?').run(user.department_id,key);audit(req,user,'publish_config','department',user.department_id,`发布部门${key}配置`);db.exec('COMMIT');return json(res,200,{version:old.version+1});}catch(cause){db.exec('ROLLBACK');throw cause;}
    }
    if(req.method==='POST'&&configMatch[2]==='rollback'){
      const body=await bodyJson(req);const version=db.prepare('SELECT * FROM config_versions WHERE id=? AND config_type=?').get(Number(body.id),configType);if(!version)return fail(res,404,'版本不存在');db.prepare('UPDATE department_config SET published=?,draft=NULL,version=version+1 WHERE department_id=? AND config_key=?').run(version.content,user.department_id,key);audit(req,user,'rollback_config','department',user.department_id,`回滚部门${key}配置`);return json(res,200,{ok:true});
    }
  }
  if(configMatch){
    if(user.role_code!=='super_admin'||!user.manage_config)return fail(res,403,'只有平台管理员可发布系统规则');const key=configMatch[1];if(!configDefaults[key])return fail(res,404,'配置项不存在');const old=db.prepare('SELECT * FROM application_config WHERE config_key=?').get(key);
    if(req.method==='PUT'&&!configMatch[2]){const body=await bodyJson(req);try{const config=validateConfiguration(key,body);db.prepare('UPDATE application_config SET draft=?,updated_by=? WHERE config_key=?').run(JSON.stringify(config),user.id,key);audit(req,user,'draft_config','configuration',key,`保存配置草稿：${key}`);return json(res,200,{ok:true,affectedDevices:db.prepare('SELECT COUNT(*) count FROM devices WHERE deleted=0').get().count});}catch(cause){return fail(res,400,cause.message);}}
    if(req.method==='POST'&&configMatch[2]==='publish'){
      if(!old.draft)return fail(res,400,'当前没有可发布的草稿');db.exec('BEGIN');try{db.prepare('INSERT INTO config_versions(config_type,version_no,content,published_by) VALUES(?,?,?,?)').run(key,old.version,old.published,user.id);db.prepare('UPDATE application_config SET published=draft,draft=NULL,version=version+1 WHERE config_key=?').run(key);audit(req,user,'publish_config','configuration',key,`发布${key}配置 V${old.version+1}`);db.exec('COMMIT');return json(res,200,{version:old.version+1});}catch(cause){db.exec('ROLLBACK');throw cause;}
    }
    if(req.method==='GET'&&configMatch[2]==='versions')return json(res,200,{rows:db.prepare('SELECT id,version_no,published_at,content FROM config_versions WHERE config_type=? ORDER BY id DESC').all(key).map((row)=>({...row,content:safeJson(row.content,{})}))});
    if(req.method==='POST'&&configMatch[2]==='rollback'){
      const body=await bodyJson(req);const version=db.prepare('SELECT * FROM config_versions WHERE id=? AND config_type=?').get(Number(body.id),key);if(!version)return fail(res,404,'版本不存在');db.exec('BEGIN');try{db.prepare('INSERT INTO config_versions(config_type,version_no,content,published_by) VALUES(?,?,?,?)').run(key,old.version,old.published,user.id);db.prepare('UPDATE application_config SET published=?,draft=NULL,version=version+1,updated_by=? WHERE config_key=?').run(version.content,user.id,key);audit(req,user,'rollback_config','configuration',key,`回滚${key}配置至V${version.version_no}`);db.exec('COMMIT');return json(res,200,{ok:true});}catch(cause){db.exec('ROLLBACK');throw cause;}
    }
  }
  return false;
}
