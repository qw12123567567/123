import { db } from './db.mjs';
import { scopeClause,canAccessDepartment,audit,safeJson } from './security.mjs';
import { json,fail,bodyJson,spreadsheet } from './http.mjs';

// Keep the independent ledger additive so existing equipment and cloud data survive upgrades.
db.exec(`
CREATE TABLE IF NOT EXISTS spare_parts(
 id INTEGER PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,category TEXT NOT NULL DEFAULT '其他',
 model TEXT NOT NULL DEFAULT '',specification TEXT NOT NULL DEFAULT '',drawing_no TEXT NOT NULL DEFAULT '',
 material TEXT NOT NULL DEFAULT '',manufacturer TEXT NOT NULL DEFAULT '',supplier TEXT NOT NULL DEFAULT '',
 unit TEXT NOT NULL DEFAULT '件',quantity REAL NOT NULL DEFAULT 0 CHECK(quantity>=0),
 min_stock REAL NOT NULL DEFAULT 0 CHECK(min_stock>=0),max_stock REAL NOT NULL DEFAULT 0 CHECK(max_stock>=0),
 warehouse TEXT NOT NULL DEFAULT '',bin_location TEXT NOT NULL DEFAULT '',compatible_device TEXT NOT NULL DEFAULT '',
 department_id INTEGER NOT NULL REFERENCES departments(id),owner TEXT NOT NULL DEFAULT '',unit_price REAL,
 notes TEXT NOT NULL DEFAULT '',parameters_json TEXT NOT NULL DEFAULT '[]',
 version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,
 created_by INTEGER REFERENCES users(id),updated_by INTEGER REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_spare_scope ON spare_parts(deleted,department_id,owner,updated_at);
CREATE INDEX IF NOT EXISTS idx_spare_search ON spare_parts(code,name,drawing_no,model);
CREATE TABLE IF NOT EXISTS spare_movements(
 id INTEGER PRIMARY KEY,spare_id INTEGER NOT NULL REFERENCES spare_parts(id),kind TEXT NOT NULL,
 quantity REAL NOT NULL,before_quantity REAL NOT NULL,after_quantity REAL NOT NULL,reason TEXT NOT NULL,
 created_by INTEGER REFERENCES users(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_spare_movements ON spare_movements(spare_id,id DESC);
`);

const textLimits={code:100,name:200,category:100,model:300,specification:2000,drawing_no:200,material:200,manufacturer:200,supplier:200,unit:20,warehouse:200,bin_location:200,compatible_device:500,owner:100,notes:4000};
const labels={code:'备件编号',name:'备件名称',category:'备件分类',model:'型号',specification:'规格参数',drawing_no:'图号/物料号',material:'材质',manufacturer:'生产厂商',supplier:'供应商',unit:'计量单位',quantity:'库存数量',min_stock:'最低库存',max_stock:'最高库存',warehouse:'仓库',bin_location:'库位',compatible_device:'适用设备/型号',department_name:'归属部门',owner:'保管人',unit_price:'单价',notes:'备注',parameters:'技术参数'};
const storedFields=[...Object.keys(textLimits),'quantity','min_stock','max_stock','department_id','unit_price','parameters_json'];
const quantityScale=1e6;
const maxQuantity=1e9;
const now=()=>new Date().toISOString();
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const roundQuantity=(value)=>Math.round(value*quantityScale)/quantityScale;

function quantity(value,label,{positive=false}={}){
  if(typeof value!=='string'&&typeof value!=='number')throw error(`${label}必须为${positive?'大于零的':'非负'}数字`);
  const text=String(value).trim(),numeric=Number(value);
  const decimal=text.match(/^\+?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if(!decimal||!`${decimal[1]}${decimal[2]||''}`||!Number.isFinite(numeric)||numeric<0||numeric>maxQuantity||positive&&numeric<=0)throw error(`${label}必须为${positive?'大于零的':'非负'}数字，且不能超过10亿`);
  const fraction=decimal[2]||'',exponent=Number(decimal[3]||0),digits=(decimal[1]+fraction).replace(/0+$/,'');
  const trailingZeros=decimal[1].length+fraction.length-digits.length;
  if(digits&&fraction.length-exponent-trailingZeros>6)throw error(`${label}最多保留6位小数`);
  return roundQuantity(numeric);
}

function normalize(input,user,old=null){
  if(!input||typeof input!=='object'||Array.isArray(input))throw error('备件资料格式无效');
  const output=old?Object.fromEntries(storedFields.map((field)=>[field,old[field]])):{...Object.fromEntries(Object.keys(textLimits).map((field)=>[field,''])),category:'其他',unit:'件',quantity:0,min_stock:0,max_stock:0,department_id:null,owner:user.name||'',unit_price:null,parameters_json:'[]'};
  for(const [field,limit] of Object.entries(textLimits)){
    if(!Object.hasOwn(input,field))continue;
    if(input[field]!==null&&typeof input[field]!=='string')throw error(`${labels[field]||field}必须为文本`);
    const value=String(input[field]??'').trim();
    if(value.length>limit)throw error(`${labels[field]||field}不能超过${limit}字`);
    output[field]=value;
  }
  for(const field of ['quantity','min_stock','max_stock'])if(Object.hasOwn(input,field))output[field]=quantity(input[field],labels[field]);
  if(Object.hasOwn(input,'department_id')){
    if(!['string','number'].includes(typeof input.department_id))throw error('请选择有效归属部门');
    output.department_id=Number(input.department_id);
  }
  if(!Number.isSafeInteger(output.department_id)||output.department_id<=0)throw error('归属部门必填，请选择有效部门');
  if(Object.hasOwn(input,'unit_price')){
    if(!user.edit_price)throw error('无编辑价格权限',403);
    output.unit_price=input.unit_price===null||input.unit_price===''?null:quantity(input.unit_price,'单价');
  }
  if(Object.hasOwn(input,'parameters')){
    if(!Array.isArray(input.parameters)||input.parameters.length>30)throw error('技术参数最多30项');
    const names=new Set();
    const parameters=input.parameters.map((parameter)=>{
      if(!parameter||typeof parameter!=='object'||Array.isArray(parameter))throw error('技术参数格式无效');
      const item={};
      for(const [key,limit] of [['name',100],['value',1000],['unit',30]]){
        if(parameter[key]!=null&&!['string','number'].includes(typeof parameter[key]))throw error('技术参数名称、值和单位必须为文本或数字');
        if(typeof parameter[key]==='number'&&!Number.isFinite(parameter[key]))throw error('技术参数数字必须为有限值');
        item[key]=String(parameter[key]??'').trim();if(item[key].length>limit)throw error(`技术参数${key==='name'?'名称':key==='value'?'值':'单位'}过长`);
      }
      if(!item.name)throw error('技术参数名称不能为空');
      if(names.has(item.name))throw error(`技术参数名称重复：${item.name}`);names.add(item.name);return item;
    });
    output.parameters_json=JSON.stringify(parameters);
  }
  if(!output.code)throw error('备件编号必填');if(!output.name)throw error('备件名称必填');if(!output.unit)throw error('计量单位必填');if(!output.category)output.category='其他';
  if(!canAccessDepartment(user,output.department_id))throw error('无权选择该归属部门',403);
  if(!db.prepare("SELECT id FROM departments WHERE id=? AND status='active'").get(output.department_id))throw error('归属部门不存在或已停用');
  if(user.data_scope!=='all'&&user.data_scope!=='department_descendants'&&output.owner!==user.name)throw error('当前数据范围只能将自己设为保管人',403);
  if(output.max_stock>0&&output.max_stock<output.min_stock)throw error('最高库存不能小于最低库存');
  if(old&&output.quantity!==old.quantity)throw error('请通过入库、出库或盘点调整库存数量');
  return output;
}

function filter(url,user){
  const scope=scopeClause(user,'p');const where=['p.deleted=0',scope.sql],params=[...scope.params];
  const q=(url.searchParams.get('q')||'').trim();
  if(q){
    if(q.length>200)throw error('搜索内容不能超过200字');
    const searchable=['code','name','category','model','specification','drawing_no','material','manufacturer','supplier','compatible_device','warehouse','bin_location','owner','notes','parameters_json'];
    where.push(`(${searchable.map((field)=>`p.${field} LIKE ?`).join(' OR ')})`);params.push(...searchable.map(()=>`%${q}%`));
  }
  const category=url.searchParams.get('category');if(category){where.push('p.category=?');params.push(category);}
  if(url.searchParams.get('lowStock')==='1')where.push('p.quantity<=p.min_stock');
  return {sql:where.join(' AND '),params};
}

function scoped(id,user){const scope=scopeClause(user,'p');return db.prepare(`SELECT p.*,d.name department_name FROM spare_parts p LEFT JOIN departments d ON d.id=p.department_id WHERE p.id=? AND p.deleted=0 AND ${scope.sql}`).get(id,...scope.params);}
function mask(row,user,{exporting=false}={}){
  const output={...row,parameters:safeJson(row.parameters_json,[]),lowStock:row.quantity<=row.min_stock};delete output.parameters_json;
  if(!(exporting?user.export_price:user.view_price)){delete output.unit_price;output.price_masked=true;}
  return output;
}
function objectBody(body){if(!body||typeof body!=='object'||Array.isArray(body))throw error('请求资料格式无效');return body;}
function versionOf(body){if(!['number','string'].includes(typeof body.version))throw error('请携带当前资料版本后重试');const version=Number(body.version);if(!Number.isSafeInteger(version)||version<1)throw error('请携带当前资料版本后重试');return version;}
function checkVersion(body,row){if(versionOf(body)!==row.version)throw error('备件已被其他人修改，请刷新后重试',409);}
function transaction(action){
  let started=false;
  try{db.exec('BEGIN IMMEDIATE');started=true;const result=action();db.exec('COMMIT');return result;}
  catch(cause){
    if(started)try{db.exec('ROLLBACK');}catch{}
    if(cause.code==='SQLITE_BUSY'||cause.code==='SQLITE_BUSY_SNAPSHOT'||[5,517].includes(cause.errcode))throw error('其他操作正在更新备件，请刷新后重试',409);
    throw cause;
  }
}
function movement(row,kind,amount,after,reason,user){db.prepare('INSERT INTO spare_movements(spare_id,kind,quantity,before_quantity,after_quantity,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(row.id,kind,amount,row.quantity,after,reason,user.id,now());}
function duplicate(code,id=0){if(db.prepare('SELECT id FROM spare_parts WHERE code=? AND id<>?').get(code,id))throw error('备件编号已存在（含已删除资料），请使用其他编号',409);}
function positivePage(value,fallback,max){if(value===null)return fallback;const number=Number(value);if(!Number.isInteger(number)||number<1||number>max)throw error('分页参数无效');return number;}
function idOf(value){const id=Number(value);if(!Number.isSafeInteger(id)||id<1)throw error('备件编号标识无效');return id;}

export async function spareParts(req,res,url,user){
  if(!/^\/api\/spares(?:\/|$)/.test(url.pathname))return false;
  if(req.method==='GET'&&url.pathname==='/api/spares/export'){
    if(!user.export_data)return fail(res,403,'无导出权限');
    const query=filter(url,user);const count=db.prepare(`SELECT COUNT(*) count FROM spare_parts p WHERE ${query.sql}`).get(...query.params).count;
    if(count>10000)return fail(res,400,'单次最多导出10000条，请先缩小筛选范围');
    const columns=Object.keys(labels).filter((key)=>key!=='unit_price'||user.export_price);
    const rows=db.prepare(`SELECT p.*,d.name department_name FROM spare_parts p LEFT JOIN departments d ON d.id=p.department_id WHERE ${query.sql} ORDER BY p.code`).all(...query.params).map((row)=>{const item=mask(row,user,{exporting:true});if(item.unit_price==null)item.unit_price='';item.parameters=item.parameters.map((parameter)=>`${parameter.name}：${parameter.value}${parameter.unit?' '+parameter.unit:''}`).join('；');return item;});
    const xml=spreadsheet(columns.map((key)=>({key,label:labels[key],number:['quantity','min_stock','max_stock','unit_price'].includes(key)})),rows).replace('ss:Name="设备台账"','ss:Name="备品备件台账"');
    audit(req,user,'export','spare','batch',`导出备品备件${rows.length}条`);
    res.writeHead(200,{'Content-Type':'application/vnd.ms-excel; charset=utf-8','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(`备品备件台账-${now().slice(0,10)}.xls`)}`,'Content-Length':Buffer.byteLength(xml),'Cache-Control':'no-store'});return res.end(xml);
  }
  if(req.method==='GET'&&url.pathname==='/api/spares'){
    const query=filter(url,user);const page=positivePage(url.searchParams.get('page'),1,1000000),pageSize=positivePage(url.searchParams.get('pageSize'),20,100);
    const counts=db.prepare(`SELECT COUNT(*) items,COALESCE(SUM(p.quantity),0) quantity,COALESCE(SUM(CASE WHEN p.quantity<=p.min_stock THEN 1 ELSE 0 END),0) lowStock FROM spare_parts p WHERE ${query.sql}`).get(...query.params);
    const rows=db.prepare(`SELECT p.*,d.name department_name FROM spare_parts p LEFT JOIN departments d ON d.id=p.department_id WHERE ${query.sql} ORDER BY p.updated_at DESC,p.id DESC LIMIT ? OFFSET ?`).all(...query.params,pageSize,(page-1)*pageSize).map((row)=>mask(row,user));
    const scope=scopeClause(user,'p');const categories=db.prepare(`SELECT DISTINCT p.category FROM spare_parts p WHERE p.deleted=0 AND ${scope.sql} ORDER BY p.category`).all(...scope.params).map((row)=>row.category);
    return json(res,200,{rows,total:counts.items,page,pageSize,summary:{items:counts.items,lowStock:counts.lowStock,quantity:roundQuantity(counts.quantity)},categories});
  }
  if(req.method==='POST'&&url.pathname==='/api/spares'){
    if(!user.manage_data)return fail(res,403,'无新增备件权限');const body=await bodyJson(req,256*1024);
    const input=normalize(body,user);const id=transaction(()=>{
      duplicate(input.code);const stamp=now();
      const id=Number(db.prepare(`INSERT INTO spare_parts(${storedFields.join(',')},created_by,updated_by,created_at,updated_at) VALUES(${storedFields.map(()=>'?').join(',')},?,?,?,?)`).run(...storedFields.map((field)=>input[field]),user.id,user.id,stamp,stamp).lastInsertRowid);
      movement({id,quantity:0},'opening',input.quantity,input.quantity,'期初建账',user);audit(req,user,'create','spare',id,`新增备件：${input.code}`);return id;
    });return json(res,201,{id});
  }
  const movementMatch=url.pathname.match(/^\/api\/spares\/(\d+)\/movements$/);
  if(movementMatch&&req.method==='POST'){
    if(!user.manage_data)return fail(res,403,'无库存操作权限');const body=objectBody(await bodyJson(req,65536));const id=idOf(movementMatch[1]);
    if(!['in','out','adjust'].includes(body.kind))return fail(res,400,'库存操作类型必须为in、out或adjust');
    const amount=quantity(body.quantity,body.kind==='adjust'?'盘点实存数量':'变动数量',{positive:body.kind!=='adjust'});
    if(typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>1000)return fail(res,400,'请填写1000字以内的库存操作原因');
    const result=transaction(()=>{
      const row=scoped(id,user);if(!row)throw error('备件不存在或无权访问',404);if(!canAccessDepartment(user,row.department_id))throw error('无该部门库存操作权限',403);checkVersion(body,row);
      // Integer millionths avoid cumulative drift during repeated fractional movements.
      const afterUnits=body.kind==='adjust'?Math.round(amount*quantityScale):Math.round(row.quantity*quantityScale)+(body.kind==='in'?1:-1)*Math.round(amount*quantityScale),after=afterUnits/quantityScale;
      if(afterUnits<0)throw error('库存不足，不能出库');if(after>maxQuantity)throw error('操作后库存不能超过10亿');
      const changed=db.prepare('UPDATE spare_parts SET quantity=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND version=? AND deleted=0').run(after,user.id,now(),id,row.version);if(!changed.changes)throw error('备件已被其他人修改，请刷新后重试',409);
      movement(row,body.kind,body.kind==='adjust'?roundQuantity(after-row.quantity):amount,after,body.reason.trim(),user);
      audit(req,user,'stock','spare',id,`${body.kind==='in'?'入库':body.kind==='out'?'出库':'盘点'}：${row.code}`);return {ok:true,quantity:after,version:row.version+1};
    });return json(res,200,result);
  }
  const match=url.pathname.match(/^\/api\/spares\/(\d+)$/);
  if(match){
    const id=idOf(match[1]);
    if(req.method==='GET'){
      const row=scoped(id,user);if(!row)return fail(res,404,'备件不存在或无权访问');
      const movements=db.prepare('SELECT m.*,u.name user_name FROM spare_movements m LEFT JOIN users u ON u.id=m.created_by WHERE m.spare_id=? ORDER BY m.id DESC').all(id);
      return json(res,200,{part:mask(row,user),movements});
    }
    if(req.method==='PUT'){
      if(!user.manage_data)return fail(res,403,'无编辑备件权限');const body=objectBody(await bodyJson(req,256*1024));
      transaction(()=>{
        const row=scoped(id,user);if(!row)throw error('备件不存在或无权访问',404);checkVersion(body,row);const input=normalize(body,user,row);duplicate(input.code,id);
        const updated=storedFields.filter((field)=>field!=='quantity');const changed=db.prepare(`UPDATE spare_parts SET ${updated.map((field)=>`${field}=?`).join(',')},version=version+1,updated_by=?,updated_at=? WHERE id=? AND version=? AND deleted=0`).run(...updated.map((field)=>input[field]),user.id,now(),id,row.version);if(!changed.changes)throw error('备件已被其他人修改，请刷新后重试',409);
        audit(req,user,'update','spare',id,`修改备件：${input.code}`);
      });return json(res,200,{ok:true});
    }
    if(req.method==='DELETE'){
      if(!user.delete_data)return fail(res,403,'无删除备件权限');const body=objectBody(await bodyJson(req,65536));
      transaction(()=>{
        const row=scoped(id,user);if(!row)throw error('备件不存在或无权访问',404);if(!canAccessDepartment(user,row.department_id))throw error('无该部门删除权限',403);if(Object.hasOwn(body,'version'))checkVersion(body,row);
        const changed=db.prepare('UPDATE spare_parts SET deleted=1,version=version+1,updated_by=?,updated_at=? WHERE id=? AND version=? AND deleted=0').run(user.id,now(),id,row.version);if(!changed.changes)throw error('备件已被其他人修改，请刷新后重试',409);
        audit(req,user,'delete','spare',id,`删除备件：${row.code}`);
      });return json(res,200,{ok:true});
    }
  }
  return fail(res,404,'备品备件接口不存在');
}
