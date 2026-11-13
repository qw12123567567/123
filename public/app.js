import { createOperations } from './operations.js';

const queryRoot=(scope)=>typeof scope==='string'?document.querySelector(scope):scope;
const $=(selector,scope=document)=>queryRoot(scope)?.querySelector(selector)||null;
const $$=(selector,scope=document)=>[...(queryRoot(scope)?.querySelectorAll(selector)||[])];
const root=$('#page-root');
const state={user:null,page:'dashboard',departments:[],dictionaries:[],customFields:[],deviceQuery:{page:1,pageSize:20},lastImport:null};
let attachmentLimitMB=8;
const accounts={asset:['asset','Asset@123'],dept:['dept','Dept@123'],finance:['finance','Finance@123'],staff:['staff','Staff@123']};

const icon=(name)=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHtml=(value)=>String(value??'').replace(/[&<>'"]/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const canField=(field,operation='view')=>state.user.fieldPermissions?.[field.code]?.[operation]??(!field.sensitive||state.user.permissions.viewSensitive);
const date=(value)=>{if(!value)return '-';const text=String(value);const normalized=text.length===10?`${text}T00:00:00`:text.includes('T')?text:text.replace(' ','T')+'Z';return new Date(normalized).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:text.length>10?'2-digit':undefined,minute:text.length>10?'2-digit':undefined});};
const fullDate=(value)=>value?String(value).slice(0,10):'-';
const money=(value)=>value==null?'***':new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY',maximumFractionDigits:0}).format(value);
const initials=(name)=>String(name||'U').slice(-2);
const formData=(form)=>{
  const values=Object.fromEntries(new FormData(form));
  if(form.id==='field-form'){
    values.settings={};
    const read=(name)=>$(`[name="${name}"]`,form)?.value??'';
    if(read('field_default')!=='')values.settings.defaultValue=read('field_default');
    for(const [input,key] of [['field_max_length','maxLength'],['field_min','min'],['field_max','max']])if(read(input)!=='')values.settings[key]=Number(read(input));
    if(read('visibility_field'))values.settings.visibleWhen={field:read('visibility_field'),equals:read('visibility_equals')};
    delete values.settings_payload;
  }
  return values;
};
const pageHead=(title,description,actions='')=>`<header class="page-head"><div><h1>${title}</h1><p>${description}</p></div><div class="head-actions">${actions}</div></header>`;
const loading=()=>`<div class="loading"><div><div class="spinner"></div>正在加载数据…</div></div>`;
const empty=(text='暂无数据')=>`<div class="empty-state">${icon('box')}<span>${text}</span></div>`;

function toast(message,type='ok'){
  const item=document.createElement('div');item.className=`toast ${type==='error'?'error':''}`;item.textContent=message;$('#toast-root').append(item);setTimeout(()=>item.remove(),3200);
}

async function request(url,options={}){
  const headers={...(options.headers||{})};
  if(options.body&&typeof options.body!=='string') { headers['Content-Type']='application/json';options.body=JSON.stringify(options.body); }
  if(state.user&&!['GET','HEAD'].includes(options.method||'GET'))headers['X-CSRF-Token']=state.user.csrfToken;
  const response=await fetch(url,{...options,headers});
  if(response.status===401&&url!=='/api/login'){showLogin();throw new Error('登录已失效');}
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const detail=Array.isArray(data.details)?`：${data.details.join('；')}`:'';throw new Error((data.error||'操作失败')+detail);}
  return data;
}

async function loadMeta(){
  const [departments,dictionaries,fields,configuration]=await Promise.all([request('/api/departments'),request('/api/dictionaries'),request('/api/custom-fields'),request('/api/published-config')]);
  state.departments=departments.rows;state.manageableDepartmentIds=departments.manageableIds;state.dictionaries=dictionaries.rows;state.customFields=fields.rows;state.configuration=configuration;
}

function dictionaryOptions(type,selected=''){
  return state.dictionaries.filter((item)=>item.dict_type===type&&item.status==='active').map((item)=>`<option value="${escapeHtml(item.name)}" ${item.name===selected?'selected':''}>${escapeHtml(item.name)}</option>`).join('');
}
function departmentOptions(selected='',includeAll=false){
  const allowed=state.user.role.dataScope==='all'?state.departments:state.departments.filter((item)=>state.manageableDepartmentIds?.includes(item.id));
  return `${includeAll?'<option value="">全部部门</option>':''}${allowed.filter((item)=>item.status==='active').map((item)=>`<option value="${item.id}" ${Number(selected)===item.id?'selected':''}>${escapeHtml(item.name)}</option>`).join('')}`;
}

function showLogin(){state.user=null;$('#app-shell').hidden=true;$('#login-view').hidden=false;$('#modal-root').innerHTML='';}
function showApp(){
  $('#login-view').hidden=true;$('#app-shell').hidden=false;
  $('#avatar').textContent=initials(state.user.name);
  $('#sidebar-user').innerHTML=`<div class="user-block"><span class="user-avatar">${initials(state.user.name)}</span><span><strong>${escapeHtml(state.user.name)}</strong><small>${escapeHtml(state.user.role.name)}</small></span></div>`;
  $('#scope-badge').textContent=state.user.role.dataScope==='all'?'全部数据':state.user.role.dataScope==='department_descendants'?`${state.user.department.name}及下级`:'仅本人相关';
  $$('.admin-nav').forEach((item)=>item.hidden=!(state.user.permissions.manageConfig||state.user.permissions.manageUsers));
  $$('.users-nav').forEach((item)=>item.hidden=!state.user.permissions.manageUsers);
  $$('.settings-nav').forEach((item)=>item.hidden=state.user.role.code!=='super_admin');
  $$('.audit-nav').forEach((item)=>item.hidden=!state.user.permissions.viewAudit);
}

async function bootstrap(){
  try{const data=await request('/api/bootstrap');state.user=data.user;showApp();await loadMeta();navigate(location.hash.slice(1).split('?')[0]||'dashboard',false);}
  catch{showLogin();}
}

function navigate(page,push=true){
  state.page=page;if(push)location.hash=page;$$('#main-nav button').forEach((button)=>button.classList.toggle('active',button.dataset.page===page));$('.sidebar').classList.remove('open');renderPage().catch((error)=>{root.innerHTML=empty(error.message);toast(error.message,'error');});
}

async function renderPage(){
  root.innerHTML=loading();
  const pages={dashboard:renderDashboard,devices:renderDevices,quick:renderQuick,reminders:renderReminders,departments:renderDepartments,dictionaries:renderDictionaries,config:renderConfig,permissions:renderPermissions,audit:renderAudit,settings:renderSettings};
  const renderer=pages[state.page]||renderDashboard;await renderer();
}

function bindCommon(){
  $('#login-form').addEventListener('submit',async(event)=>{event.preventDefault();const button=$('button[type="submit"]',event.currentTarget);button.disabled=true;$('#login-error').textContent='';try{await request('/api/login',{method:'POST',body:formData(event.currentTarget)});await bootstrap();}catch(error){$('#login-error').textContent=error.message;}finally{button.disabled=false;}});
  $('#toggle-password').addEventListener('click',()=>{const input=$('[name="password"]');input.type=input.type==='password'?'text':'password';$('#toggle-password').textContent=input.type==='password'?'显示':'隐藏';});
  $('#demo-mfa').addEventListener('click',async()=>{try{const data=await request('/api/demo-mfa');$('[name="mfaCode"]').value=data.code;toast(`演示动态码已填入，${data.expiresIn}秒内有效`);}catch(error){toast(error.message,'error');}});
  $$('.demo-accounts button').forEach((button)=>button.addEventListener('click',()=>{const [username,password]=accounts[button.dataset.account];$('[name="username"]').value=username;$('[name="password"]').value=password;$('[name="mfaCode"]').value='';}));
  $('#main-nav').addEventListener('click',(event)=>{const button=event.target.closest('button[data-page]');if(button)navigate(button.dataset.page);});
  $('#mobile-menu').addEventListener('click',()=>$('.sidebar').classList.toggle('open'));
  $('#refresh-page').addEventListener('click',()=>renderPage());
  $('#logout-button').addEventListener('click',()=>operations.account());
  $('#forgot-password').addEventListener('click',()=>operations.forgotPassword());
  $('#global-search').addEventListener('keydown',(event)=>{if(event.key==='Enter'){state.deviceQuery={page:1,pageSize:20,q:event.target.value.trim()};navigate('devices');}});
  window.addEventListener('hashchange',()=>{const page=location.hash.slice(1).split('?')[0];if(page&&page!==state.page)navigate(page,false);});
}

async function initialize(){
  try{
    const runtime=await request('/api/runtime');
    attachmentLimitMB=Math.floor((runtime.maxAttachmentBytes||8*1024*1024)/1024/1024);state.cloud=runtime.cloud;
    if(runtime.demo){
      $('#demo-mfa').hidden=false;
      $('.demo-accounts').hidden=false;
      $('[name="username"]').value='admin';
      $('[name="password"]').value='Admin@123';
    }
  }catch{}
  bindCommon();await bootstrap();if(location.hash.startsWith('#reset?'))operations.resetPassword(new URLSearchParams(location.hash.split('?')[1]).get('token'));
}
const operations=createOperations({$,$$,state,request,toast,openDialog,closeModal,inputField,escapeHtml,icon,fullDate,date,departmentOptions,openDevice,loadMeta,renderPermissions,renderConfig,renderDevices,deviceColumns,showLogin,canField});
initialize();

async function renderDashboard(){
  const data=await request('/api/dashboard');const metric=data.metrics;const max=Math.max(...data.status.map((item)=>item.value),1);
  root.innerHTML=`${pageHead('首页仪表盘','基于当前账号数据范围的设备运行概览',`${state.user.permissions.exportData?`<button class="button" id="dashboard-export">${icon('download')}<span>导出当前台账</span></button>`:''}${state.user.permissions.manageData?`<button class="button primary" id="dashboard-add">${icon('plus')}<span>新增设备</span></button>`:''}`)}
  <section class="metrics-grid">
    ${metricCard('设备总数',metric.total,'台账内有效设备','box')}
    ${metricCard('在用设备',metric.active,`${metric.total?Math.round(metric.active/metric.total*100):0}% 正常投入使用`,'grid','blue')}
    ${metricCard('待处理提醒',metric.maintenanceDue+metric.calibrationDue,'维保与校准计划','bell','alert')}
    ${metricCard('维修中',metric.repairing,'需要跟踪维修进度','settings','danger')}
    ${state.user.permissions.viewPrice?metricCard('采购原值',money(metric.purchaseTotal),'已授权价格口径','shield'):metricCard('敏感数据','已保护','价格字段未向当前角色返回','shield')}
    ${metricCard('保修30天到期',metric.warrantySoon,'建议提前确认续保','bell','alert')}
    ${metricCard('无责任人',metric.missingOwner,'需要补齐数据责任','users',metric.missingOwner?'danger':'')}
    ${metricCard('缺少附件',metric.missingAttachment,'建议补充说明书或验收资料','box',metric.missingAttachment?'alert':'')}
    ${metricCard('数据范围',state.user.role.dataScope==='all'?'全部':'受限',state.user.department.name,'building','blue')}
  </section>
  <section class="dashboard-grid">
    <article class="panel"><div class="panel-head"><h2>设备状态分布</h2><span class="type-tag">实时</span></div><div class="panel-body status-bars">${data.status.map((item)=>`<div class="status-row"><span>${escapeHtml(item.label)}</span><div class="status-track"><i style="width:${item.value/max*100}%"></i></div><strong>${item.value}</strong></div>`).join('')||empty()}</div></article>
    <article class="panel"><div class="panel-head"><h2>最近系统活动</h2>${state.user.permissions.viewAudit?'<button class="button ghost small" data-go="audit">查看全部</button>':''}</div><div class="panel-body activity-list">${data.recent.map((item)=>`<div class="activity-item"><i class="activity-dot"></i><div><strong>${escapeHtml(item.summary)}</strong><small>${escapeHtml(item.user_name||'系统')} · ${escapeHtml(item.action)}</small></div><time class="activity-time">${date(item.created_at)}</time></div>`).join('')||empty(state.user.permissions.viewAudit?'暂无系统活动':'当前角色无审计日志权限')}</div></article>
  </section>
  <article class="panel"><div class="panel-head"><h2>临近到期与逾期事项</h2><button class="button ghost small" data-go="reminders">进入提醒中心</button></div>${urgentTable(data.urgent)}</article>`;
  $('#dashboard-add')?.addEventListener('click',()=>openDeviceForm());
  $('#dashboard-export')?.addEventListener('click',downloadExport);
  $$('[data-go]').forEach((button)=>button.addEventListener('click',()=>navigate(button.dataset.go)));
  $$('.code-link').forEach((button)=>button.addEventListener('click',()=>openDevice(Number(button.dataset.id))));
  await operations.quality();
}

function metricCard(label,value,note,iconName,tone=''){
  return `<article class="metric ${tone}"><div class="metric-top"><span>${label}</span><i class="metric-icon">${icon(iconName)}</i></div><div class="metric-value">${escapeHtml(value)}</div><div class="metric-note">${escapeHtml(note)}</div></article>`;
}

function urgentTable(rows){
  if(!rows.length)return empty('当前没有临近到期事项');
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>设备</th><th>部门 / 责任人</th><th>状态</th><th>保修截止</th><th>下次维保</th><th>下次校准</th></tr></thead><tbody>${rows.map((item)=>`<tr><td><button class="code-link" data-id="${item.id}">${escapeHtml(item.code)}</button><span class="cell-sub">${escapeHtml(item.name)}</span></td><td>${escapeHtml(item.department_name||'-')}<span class="cell-sub">${escapeHtml(item.owner||'未指定')}</span></td><td><span class="status-tag ${item.status}">${escapeHtml(item.status)}</span></td><td>${fullDate(item.warranty_end)}</td><td>${fullDate(item.next_maintenance)}</td><td>${fullDate(item.next_calibration)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function downloadExport(){
  if(!state.user.permissions.exportData)return toast('当前角色没有导出权限','error');
  try{
    const job=await request('/api/export-jobs',{method:'POST',body:{filters:state.deviceQuery}});toast('正在后台生成导出文件…');
    for(let attempt=0;attempt<120;attempt++){
      const status=await request(`/api/export-jobs/${job.id}`);
      if(status.status==='failed')throw new Error(status.error||'导出失败');
      if(status.status==='ready'){
        const response=await fetch(`/api/export-jobs/${job.id}/download`);if(!response.ok){const result=await response.json();throw new Error(result.error||'下载失败');}
        const blob=await response.blob();const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`设备台账-${new Date().toLocaleDateString('sv-SE')}.xls`;link.click();URL.revokeObjectURL(link.href);toast('导出文件已生成');return;
      }
      await new Promise((resolve)=>setTimeout(resolve,500));
    }
    throw new Error('生成文件超过一分钟，请稍后重试');
  }catch(error){toast(error.message,'error');}
}

async function renderDevices(){
  const params=new URLSearchParams(Object.entries(state.deviceQuery).filter(([,value])=>value!==''&&value!=null));const [data,views]=await Promise.all([request(`/api/devices?${params}`),request('/api/views')]);const q=state.deviceQuery;
  root.innerHTML=`${pageHead('设备台账',`共 ${data.total} 台设备，列表字段按当前角色实时过滤`,`${state.user.permissions.importData?`<button class="button" id="import-button">${icon('upload')}<span>导入</span></button>`:''}${state.user.permissions.exportData?`<button class="button" id="export-button">${icon('download')}<span>导出</span></button>`:''}${state.user.permissions.manageData?`<button class="button primary" id="add-device">${icon('plus')}<span>新增设备</span></button>`:''}`)}
  <div class="toolbar"><div class="quick-filters"><button class="filter-chip ${q.warranty_soon?'active':''}" data-quick="warranty_soon">保修30天到期</button><button class="filter-chip ${q.maintenance_due?'active':''}" data-quick="maintenance_due">近期维保</button><button class="filter-chip ${q.calibration_due?'active':''}" data-quick="calibration_due">近期校准</button><button class="filter-chip ${q.missing_owner?'active':''}" data-quick="missing_owner">无责任人</button><button class="filter-chip ${q.critical?'active':''}" data-quick="critical">关键设备</button></div><div class="toolbar-actions"><select id="saved-view"><option value="">保存的视图</option>${views.rows.map((item)=>`<option value="${item.id}">${escapeHtml(item.name)}${item.scope==='department'?' · 部门':''}</option>`).join('')}</select><button class="button small" id="save-view">保存当前视图</button><button class="button ghost small" id="clear-filters">清除筛选</button></div></div>
  <form id="device-filters" class="filter-grid"><input name="q" value="${escapeHtml(q.q||'')}" placeholder="搜索编号、名称、型号、SN、责任人、位置"><select name="category"><option value="">全部分类</option>${dictionaryOptions('category',q.category)}</select><select name="department_id">${departmentOptions(q.department_id,true)}</select><select name="status"><option value="">全部状态</option>${dictionaryOptions('status',q.status)}</select><select name="location"><option value="">全部位置</option>${dictionaryOptions('location',q.location)}</select></form>
  <article class="panel">${deviceTable(data.rows)}${pagination(data)}</article>`;
  $('#add-device')?.addEventListener('click',()=>openDeviceForm());
  $('#import-button')?.addEventListener('click',openImport);
  $('#export-button')?.addEventListener('click',downloadExport);
  $('#clear-filters').addEventListener('click',()=>{state.deviceQuery={page:1,pageSize:20};renderDevices();});
  $('#saved-view').addEventListener('change',(event)=>{const view=views.rows.find((item)=>item.id===Number(event.target.value));if(view){state.deviceQuery={page:1,pageSize:20,...view.config};renderDevices();}});$('#save-view').addEventListener('click',()=>saveCurrentView());
  $('#device-filters').addEventListener('change',(event)=>{const values=formData(event.currentTarget);state.deviceQuery={...state.deviceQuery,...values,page:1};renderDevices();});
  $('#device-filters').addEventListener('submit',(event)=>event.preventDefault());
  $('[name="q"]','#device-filters').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();state.deviceQuery={...state.deviceQuery,q:event.target.value,page:1};renderDevices();}});
  $$('.filter-chip').forEach((button)=>button.addEventListener('click',()=>{const key=button.dataset.quick;state.deviceQuery={...state.deviceQuery,[key]:state.deviceQuery[key]?'':'1',page:1};renderDevices();}));
  $$('.code-link').forEach((button)=>button.addEventListener('click',()=>openDevice(Number(button.dataset.id))));
  $('#page-prev')?.addEventListener('click',()=>{state.deviceQuery.page=Math.max(1,data.page-1);renderDevices();});$('#page-next')?.addEventListener('click',()=>{state.deviceQuery.page=data.page+1;renderDevices();});
  operations.columns();
}

function saveCurrentView(){openDialog('保存当前视图','保存筛选条件，价格字段权限不会随视图共享',`<form id="view-form" class="form-grid">${inputField('视图名称 *','name','','text','required')}<label>可见范围<select name="scope"><option value="personal">仅自己</option>${state.user.permissions.manageConfig?'<option value="department">本部门共享</option>':''}</select></label></form>`,`<button class="button" data-close>取消</button><button class="button primary" id="save-current-view">保存</button>`);$('#save-current-view').addEventListener('click',async()=>{const form=$('#view-form');if(!form.reportValidity())return;try{await request('/api/views',{method:'POST',body:{...formData(form),config:state.deviceQuery}});closeModal();toast('视图已保存');renderDevices();}catch(error){toast(error.message,'error');}});}

function deviceTable(rows){
  if(!rows.length)return empty('没有符合条件的设备');const available=deviceColumns();const defaults=['code','category','department_name','owner','status',...(state.user.permissions.viewPrice?['purchase_price']:[]),'next_maintenance','updated_at'];let selected=state.deviceQuery.columns;try{selected=selected||JSON.parse(localStorage.getItem(`ledger-columns-${state.user.id}`)||'null');}catch{}const columns=(Array.isArray(selected)?selected:defaults).map((key)=>available.find((column)=>column.key===key)).filter(Boolean);if(!columns.some((column)=>column.key==='code'))columns.unshift(available[0]);
  const render=(column,item)=>{if(column.key==='code')return `<button class="code-link" data-id="${item.id}">${escapeHtml(item.code)}</button><span class="cell-sub">${item.critical?'<b class="critical-mark">关键</b> · ':''}${escapeHtml(item.name)}</span>`;if(column.key==='status')return `<span class="status-tag ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>`;if(column.key==='purchase_price')return money(item.purchase_price);if(column.key==='category')return `${escapeHtml(item.category)}<span class="cell-sub">${escapeHtml(item.model||'-')}</span>`;if(column.key==='department_name')return `${escapeHtml(item.department_name||'-')}<span class="cell-sub">${escapeHtml(item.location||'-')}</span>`;if(column.key==='updated_at')return date(item.updated_at);const value=column.key.startsWith('custom_')?item.custom_data?.[column.key.slice(7)]:item[column.key];return escapeHtml(Array.isArray(value)?value.join('、'):value??'-');};
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th><input type="checkbox" id="select-all-devices" aria-label="选择全部本页设备"></th>${columns.map((column)=>`<th>${column.label}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map((item)=>`<tr><td><input type="checkbox" class="device-checkbox" value="${item.id}" aria-label="选择${escapeHtml(item.code)}"></td>${columns.map((column)=>`<td>${render(column,item)}</td>`).join('')}<td><button class="icon-button code-link" data-id="${item.id}" title="查看详情">${icon('more')}</button></td></tr>`).join('')}</tbody></table></div>`;
}

function deviceColumns(){return[{key:'code',label:'设备编号 / 名称'},{key:'category',label:'分类 / 型号'},{key:'department_name',label:'部门 / 位置'},{key:'owner',label:'责任人'},{key:'status',label:'状态'},...(state.user.permissions.viewPrice?[{key:'purchase_price',label:'采购原值'}]:[]),{key:'sn',label:'序列号SN'},{key:'warranty_end',label:'保修截止'},{key:'next_maintenance',label:'下次维保'},{key:'next_calibration',label:'下次校准'},{key:'updated_at',label:'更新时间'},...state.customFields.filter((field)=>field.status==='published'&&canField(field)).map((field)=>({key:`custom_${field.code}`,label:escapeHtml(field.name)}))];}

function pagination(data){const pages=Math.max(1,Math.ceil(data.total/data.pageSize));return `<div class="pagination"><span>第 ${data.page} / ${pages} 页 · 每页 ${data.pageSize} 条</span><div class="page-buttons"><button id="page-prev" ${data.page<=1?'disabled':''}>‹</button><button id="page-next" ${data.page>=pages?'disabled':''}>›</button></div></div>`;}

function openImport(){
  openDialog('导入设备台账','支持 Excel xlsx/xls 与 UTF-8 CSV，导入前完成完整校验',`<div class="notice">先下载标准模板。首行包含设备编号、设备名称、设备分类、部门编码和设备状态等字段。</div><div class="toolbar import-toolbar"><button class="button small" id="download-template">${icon('download')}下载Excel模板</button></div><label>选择Excel或CSV文件<input id="csv-file" type="file" accept=".xlsx,.xls,.csv,text/csv"></label><div id="import-preview"></div>`,`<button class="button" data-close>取消</button><button class="button primary" id="preview-import">校验并预览</button>`);
  $('#download-template').addEventListener('click',downloadImportTemplate);
  $('#preview-import').addEventListener('click',async(event)=>{
    const file=$('#csv-file').files[0];if(!file)return toast('请先选择导入文件','error');if(file.size>8*1024*1024)return toast('导入文件不能超过8MB','error');
    event.currentTarget.disabled=true;
    try{
      const rows=await readImportFile(file);state.lastImport={rows};
      const data=await request('/api/import/preview',{method:'POST',body:{rows}});
      const errors=data.rows.filter((row)=>row.errors.length);
      $('#import-preview').innerHTML=`<div class="stat-strip import-stats"><div><strong>${rows.length}</strong><small>数据行</small></div><div><strong>${data.validCount}</strong><small>校验通过</small></div><div><strong>${data.errorCount}</strong><small>错误行</small></div></div>${errors.length?`<div class="notice warning">${errors.slice(0,8).map((row)=>`第${row.rowNumber}行：${escapeHtml(row.errors.join('；'))}`).join('<br>')}</div><button class="button small label-print" id="download-import-errors">下载错误报告</button>`:''}<div class="table-wrap"><table class="data-table"><thead><tr><th>行号</th><th>设备编号</th><th>设备名称</th><th>检查结果</th></tr></thead><tbody>${data.rows.slice(0,20).map((row)=>`<tr><td>${row.rowNumber}</td><td>${escapeHtml(row.device.code||'')}</td><td>${escapeHtml(row.device.name||'')}</td><td>${row.errors.length?escapeHtml(row.errors.join('；')):row.duplicate?'重复编号，按所选策略处理':'通过'}</td></tr>`).join('')}</tbody></table></div>`;
      $('#download-import-errors')?.addEventListener('click',()=>downloadErrorReport(errors));
      $('.modal-foot').innerHTML=`<select id="duplicate-strategy"><option value="error">重复时报错</option><option value="skip">跳过重复</option><option value="update">更新重复</option></select><button class="button" data-close>取消</button><button class="button primary" id="commit-import" ${data.validCount?'':'disabled'}>确认导入</button>`;
      bindClose();$('#commit-import').addEventListener('click',commitImport);
    }catch(error){toast(error.message,'error');if($('#preview-import'))$('#preview-import').disabled=false;}
  });
}

function downloadErrorReport(errors){const rows=errors.map((row)=>({'行号':row.rowNumber,'错误原因':row.errors.join('；')}));const workbook=window.XLSX.utils.book_new();window.XLSX.utils.book_append_sheet(workbook,window.XLSX.utils.json_to_sheet(rows),'导入错误报告');window.XLSX.writeFile(workbook,'设备导入错误报告.xlsx');}

async function readImportFile(file){if(file.name.toLowerCase().endsWith('.csv'))return parseCsv(await file.text());if(!window.XLSX)throw new Error('Excel解析组件未加载');const workbook=window.XLSX.read(await file.arrayBuffer(),{type:'array'});return window.XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{defval:'',raw:false});}
function downloadImportTemplate(){const headers=['设备编号','固定资产编号','序列号SN','设备名称','设备分类','型号规格','品牌','生产厂商','供应商','采购日期','启用日期','采购原值','采购单价','合同金额','发票金额','残值','维修费用','部门编码','存放位置','责任人','设备状态','关键设备','保修截止日期','维保周期(天)','下次维保日期','检定周期(天)','下次检定日期','报废日期','备注'];const sheet=window.XLSX.utils.aoa_to_sheet([headers]);sheet['!cols']=headers.map((name)=>({wch:Math.max(12,name.length*2)}));const workbook=window.XLSX.utils.book_new();window.XLSX.utils.book_append_sheet(workbook,sheet,'设备导入模板');window.XLSX.writeFile(workbook,'设备台账导入模板.xlsx');}

async function commitImport(){try{const data=await request('/api/import/commit',{method:'POST',body:{rows:state.lastImport.rows,strategy:$('#duplicate-strategy').value}});closeModal();toast(`导入完成：新增${data.inserted}，更新${data.updated}，跳过${data.skipped}，失败${data.failures.length}`);if(data.failures.length){openDialog('导入结果','失败行可下载错误报告',`<p>新增${data.inserted}，更新${data.updated}，跳过${data.skipped}，失败${data.failures.length}。</p>`,'<button class="button" data-close>关闭</button><button class="button primary" id="download-commit-errors">下载错误报告</button>');$('#download-commit-errors').addEventListener('click',()=>downloadErrorReport(data.failures));}await loadMeta();renderDevices();}catch(error){toast(error.message,'error');}}

function openDialog(title,subtitle,body,footer='',drawer=false){
  $('#modal-root').innerHTML=`<div class="modal-backdrop"><section class="${drawer?'drawer':'dialog'}" role="dialog" aria-modal="true"><header class="modal-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle||'')}</p></div><button class="close-button" data-close title="关闭">${icon('x')}</button></header><div class="modal-body">${body}</div>${footer?`<footer class="modal-foot">${footer}</footer>`:''}</section></div>`;bindClose();
}
function bindClose(){$$('[data-close]','#modal-root').forEach((item)=>item.addEventListener('click',closeModal));$('.modal-backdrop')?.addEventListener('click',(event)=>{if(event.target===event.currentTarget)closeModal();});}
function closeModal(){if(state.scannerStream){state.scannerStream.getTracks().forEach((track)=>track.stop());state.scannerStream=null;}if(state.scannerFrame)cancelAnimationFrame(state.scannerFrame);$('#modal-root').innerHTML='';}

async function openDevice(id,selectedTab='basic'){
  try{const data=await request(`/api/devices/${id}`);const item=data.device;const edit=state.user.permissions.manageData?`<button class="button" id="edit-device">${icon('edit')}编辑</button>`:'';const remove=state.user.permissions.deleteData?`<button class="button danger" id="delete-device">删除</button>`:'';
    openDialog(`${item.code} · ${item.name}`,`${item.department_name||'未分配部门'} · 数据版本 ${item.version}`,`<div class="detail-hero"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.category)} · ${escapeHtml(item.model||'未填写型号')}</p></div><span class="status-tag ${item.status}">${escapeHtml(item.status)}</span></div><nav class="detail-tabs"><button class="active" data-tab="basic">基本信息</button><button data-tab="technical">技术参数</button><button data-tab="attachments">附件资料</button><button data-tab="label">二维码标签</button></nav><div id="detail-content">${detailBasic(item)}</div>`,`<span class="foot-spacer"></span>${remove}${edit}<button class="button" data-close>关闭</button>`,true);
    $('.detail-tabs').insertAdjacentHTML('beforeend','<button data-tab="records">生命周期记录</button><button data-tab="history">变更历史</button>');
    const panels={basic:()=>detailBasic(item),technical:()=>detailTechnical(item),attachments:()=>detailAttachments(item,data.attachments),label:()=>detailLabel(item)};
    $$('.detail-tabs button').forEach((button)=>button.addEventListener('click',async()=>{try{$$('.detail-tabs button').forEach((tab)=>tab.classList.toggle('active',tab===button));if(button.dataset.tab==='records')return await operations.records(item);if(button.dataset.tab==='history'){if(!state.user.permissions.viewAudit){$('#detail-content').innerHTML=empty('当前角色无日志权限');return;}const history=await request(`/api/audit?device_id=${item.id}`);$('#detail-content').innerHTML=history.rows.map((record)=>`<div class="record-row"><span><strong>${escapeHtml(record.summary)}</strong><small>${escapeHtml(record.user_name)} · ${date(record.created_at)}</small></span></div>`).join('')||empty();return;}$('#detail-content').innerHTML=panels[button.dataset.tab]();bindDetailActions(item);}catch(error){toast(error.message,'error');}}));
    $('#edit-device')?.addEventListener('click',()=>openDeviceForm(item));
    $('#delete-device')?.addEventListener('click',async()=>{if(!confirm(`确认软删除设备 ${item.code}？历史日志仍会保留。`))return;try{await request(`/api/devices/${item.id}`,{method:'DELETE'});closeModal();toast('设备已软删除');renderPage();}catch(error){toast(error.message,'error');}});
    bindDetailActions(item);
    if(selectedTab!=='basic')$(`.detail-tabs [data-tab="${selectedTab}"]`)?.click();
  }catch(error){toast(error.message,'error');}
}

function detailBasic(item){
  const entries=[['固定资产编号',item.asset_code],['序列号SN',item.sn],['分类',item.category],['型号规格',item.model],['品牌',item.brand],['生产厂商',item.manufacturer],['供应商',item.vendor],['使用部门',item.department_name],['存放位置',item.location],['责任人',item.owner],['采购日期',item.purchase_date],['启用日期',item.start_date],['保修截止',item.warranty_end],['下次维保',item.next_maintenance],['下次校准',item.next_calibration],['关键设备',item.critical?'是':'否']];
  if(state.user.permissions.viewPrice)entries.splice(10,0,['采购原值',money(item.purchase_price)],['合同金额',money(item.contract_amount)],['发票金额',money(item.invoice_amount)],['维修费用',money(item.repair_cost)]);else entries.splice(10,0,['价格信息','***（无字段权限）']);
  return `<dl class="definition-grid">${entries.map(([label,value])=>`<div class="definition-item"><dt>${label}</dt><dd class="${String(value).includes('***')?'masked':''}">${escapeHtml(value||'-')}</dd></div>`).join('')}<div class="definition-item detail-wide"><dt>备注</dt><dd>${escapeHtml(item.notes||'-')}</dd></div></dl>`;
}
function detailTechnical(item){const fields=state.customFields.filter((field)=>field.status==='published'&&(field.category==='通用'||field.category===item.category));return fields.length?`<dl class="definition-grid">${fields.map((field)=>`<div class="definition-item"><dt>${escapeHtml(field.name)}${field.sensitive?' · 敏感':''}</dt><dd>${escapeHtml(item.custom_data[field.code]??'-')}</dd></div>`).join('')}</dl>`:empty('该分类尚未配置技术参数');}
function detailAttachments(item,files){return `${state.user.permissions.manageData?`<div class="toolbar"><span class="field-help">PDF、Word、图片、Excel、TXT · 单文件不超过${attachmentLimitMB}MB</span><button class="button small" id="upload-file">${icon('upload')}上传说明书 / 附件</button></div>`:''}<div class="attachment-list">${files.map((file)=>`<div class="attachment-item"><div><strong>${escapeHtml(file.file_name)}</strong><small>${escapeHtml(file.type)} · ${(file.size/1024).toFixed(1)} KB · ${date(file.uploaded_at)}</small></div><div class="toolbar-actions">${['application/pdf','image/png','image/jpeg','text/plain'].includes(file.mime_type)?`<button class="button small" data-preview="${file.id}">预览</button>`:''}<button class="button small" data-download="${file.id}">下载</button>${state.user.permissions.manageData?`<button class="button danger small" data-remove-file="${file.id}">删除</button>`:''}</div></div>`).join('')||empty('暂无资料，可上传设备说明书、合格证或照片')}</div>`;}
function detailLabel(item){const link=`${location.origin}/#quick?code=${encodeURIComponent(item.code)}`;return `<div class="detail-hero"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.code)} · ${escapeHtml(item.department_name||'-')} · ${escapeHtml(item.owner||'未指定')}</p></div><div id="qr-code" data-text="${escapeHtml(link)}"></div></div><div class="notice">二维码仅包含详情链接，扫码后仍按登录用户权限过滤价格和附件。</div><button class="button label-print" id="print-label">打印标签</button>`;}

function bindDetailActions(item){
  $$('[data-preview]').forEach((button)=>button.addEventListener('click',()=>window.open(`/api/attachments/${button.dataset.preview}/preview`,'_blank','noopener')));
  $$('[data-download]').forEach((button)=>button.addEventListener('click',()=>window.open(`/api/attachments/${button.dataset.download}/download`,'_blank')));
  $$('[data-remove-file]').forEach((button)=>button.addEventListener('click',async()=>{if(!confirm('确认删除该附件？'))return;try{await request(`/api/attachments/${button.dataset.removeFile}`,{method:'DELETE'});toast('附件已删除');openDevice(item.id);}catch(error){toast(error.message,'error');}}));
  $('#upload-file')?.addEventListener('click',()=>openUpload(item));$('#print-label')?.addEventListener('click',()=>window.print());
  const target=$('#qr-code');if(target&&window.QRCode){target.innerHTML='';new window.QRCode(target,{text:target.dataset.text,width:132,height:132,colorDark:'#14252d',colorLight:'#ffffff',correctLevel:window.QRCode.CorrectLevel.M});}
}
function openUpload(item){
  openDialog('上传说明书 / 附件',`${item.code} · 支持多选，单文件不超过${attachmentLimitMB}MB`,`<form id="upload-form" class="form-grid"><label>附件类型<select name="type"><option>说明书</option><option>合格证</option><option>验收单</option><option>照片</option><option>维修记录</option><option>合同</option><option>发票</option><option>供应商报价</option><option>其他</option></select></label><label>选择文件<input name="file" type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt,.xlsx" multiple required></label><p class="wide field-help">PDF、Word、PNG/JPG、Excel或TXT。上传成功后可在设备附件资料中查找。</p><p id="upload-progress" class="wide field-help" role="status"></p></form>`,`<button class="button" id="cancel-upload">返回设备资料</button><button class="button primary" id="save-upload">上传</button>`);
  $('#cancel-upload').addEventListener('click',()=>openDevice(item.id,'attachments'));
  $('#save-upload').addEventListener('click',async(event)=>{const files=[...$('[name="file"]','#upload-form').files];if(!files.length)return toast('请选择附件','error');const type=$('[name="type"]','#upload-form').value;event.currentTarget.disabled=true;$('#cancel-upload').disabled=true;try{files.forEach(validateUploadFile);for(let index=0;index<files.length;index++){const file=files[index];$('#upload-progress').textContent=`正在上传 ${index+1}/${files.length}：${file.name}`;await uploadDeviceFile(item.id,file,type,(part,total)=>{$('#upload-progress').textContent=`正在上传 ${index+1}/${files.length}：${file.name}（${part}/${total}）`;});}toast(`${files.length}个附件上传成功`);await openDevice(item.id,'attachments');}catch(error){toast(error.message,'error');$('#save-upload').disabled=false;$('#cancel-upload').disabled=false;}});
}
const UPLOAD_MIMES={pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',txt:'text/plain',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
function validateUploadFile(file){const extension=file.name.split('.').at(-1).toLowerCase();if(!UPLOAD_MIMES[extension])throw new Error(`不支持的文件类型：${file.name}`);if(!file.size||file.size>attachmentLimitMB*1024*1024)throw new Error(`文件必须非空且不超过${attachmentLimitMB}MB：${file.name}`);}
async function uploadDeviceFile(deviceId,file,type='说明书',fieldCode=null,onProgress=()=>{}){
  validateUploadFile(file);
  const route=`/api/devices/${deviceId}/attachments`;
  const upload=await request(route,{method:'POST',body:{uploadAction:'start',type,fieldCode,fileName:file.name,size:file.size}});
  for(let chunkIndex=0,offset=0;offset<file.size;chunkIndex++,offset+=upload.chunkSize){
    const chunk=file.slice(offset,Math.min(offset+upload.chunkSize,file.size));
    await request(route,{method:'POST',body:{uploadAction:'chunk',uploadId:upload.uploadId,chunkIndex,dataBase64:await fileToBase64(chunk)}});
    onProgress(chunkIndex+1,upload.chunkCount);
  }
  return request(route,{method:'POST',body:{uploadAction:'complete',uploadId:upload.uploadId}});
}
function fileToBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});}

function inputField(label,name,value='',type='text',extra=''){return `<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(value??'')}" ${extra}></label>`;}
function customInput(field,item){const value=item?.custom_data?.[field.code]??'';if(field.field_type==='boolean')return `<label class="checkbox-row custom-field" data-category="${escapeHtml(field.category)}"><input name="custom_${field.code}" type="checkbox" ${value?'checked':''}>${escapeHtml(field.name)}${field.required?' *':''}</label>`;if(field.field_type==='select')return `<label class="custom-field" data-category="${escapeHtml(field.category)}">${escapeHtml(field.name)}<select name="custom_${field.code}">${field.options.map((option)=>`<option ${option===value?'selected':''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;return `<label class="custom-field" data-category="${escapeHtml(field.category)}">${escapeHtml(field.name)}${field.sensitive?' · 敏感':''}<input name="custom_${field.code}" type="${field.field_type==='number'?'number':field.field_type==='date'?'date':'text'}" value="${escapeHtml(value)}" ${field.required?'required':''}></label>`;}
function customFieldControl(field,item){
  const value=item?.custom_data?.[field.code]??field.settings?.defaultValue??'';const label=`${escapeHtml(field.name)}${field.required?' *':''}${field.sensitive?' · 敏感':''}`;const name=`custom_${field.code}`;const required=field.required?'required':'';let control;
  if(field.field_type==='attachment')control=`<input name="${name}" type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt,.xlsx" multiple ${field.required&&!(Array.isArray(value)&&value.length)?'required':''}><span class="field-help">保存设备后关联至${escapeHtml(field.name)}；已有资料保留。</span>`;
  else if(field.field_type==='boolean')control=`<input name="${name}" type="checkbox" ${[true,'true','是','1',1].includes(value)?'checked':''}>`;
  else if(['select','multiselect'].includes(field.field_type))control=`<select name="${name}" ${field.field_type==='multiselect'?'multiple':''} ${required}><option value="">请选择</option>${field.options.map((option)=>`<option ${Array.isArray(value)?value.includes(option)?'selected':'':option===value?'selected':''}>${escapeHtml(option)}</option>`).join('')}</select>`;
  else if(field.field_type==='department')control=`<select name="${name}" ${required}><option value="">请选择</option>${departmentOptions(value)}</select>`;
  else if(field.field_type==='location')control=`<select name="${name}" ${required}><option value="">请选择</option>${dictionaryOptions('location',value)}</select>`;
  else if(field.field_type==='textarea')control=`<textarea name="${name}" ${required}>${escapeHtml(value)}</textarea>`;
  else control=`<input name="${name}" type="${field.field_type==='number'?'number':field.field_type==='date'?'date':field.field_type==='datetime'?'datetime-local':'text'}" value="${escapeHtml(value)}" ${required}>`;
  return `<label class="custom-field ${field.field_type==='boolean'?'checkbox-row':''}" data-category="${escapeHtml(field.category)}">${field.field_type==='boolean'?control+label:label+control}</label>`;
}

function openDeviceForm(item=null){
  if(!state.user.permissions.manageData)return toast('当前角色没有设备维护权限','error');const current=item||{status:'在用',category:'计算机设备',department_id:state.user.department.id,custom_data:{}};const canPrice=state.user.permissions.viewPrice;const editPrice=state.user.permissions.editPrice;
  const body=`<form id="device-form" class="form-grid"><h3 class="section-title">基本信息</h3>${inputField('设备编号（留空自动编号）','code',current.code)}${inputField('设备名称 *','name',current.name,'text','required')}<label>设备分类 *<select name="category" required>${dictionaryOptions('category',current.category)}</select></label>${inputField('型号规格','model',current.model)}${inputField('固定资产编号','asset_code',current.asset_code)}${inputField('序列号SN','sn',current.sn)}<label>品牌<select name="brand"><option value="">请选择</option>${dictionaryOptions('brand',current.brand)}</select></label>${inputField('生产厂商','manufacturer',current.manufacturer)}<label>供应商<select name="vendor"><option value="">请选择</option>${dictionaryOptions('vendor',current.vendor)}</select></label>
  <h3 class="section-title">管理信息</h3><label>使用部门 *<select name="department_id" required>${departmentOptions(current.department_id)}</select></label><label>存放位置<select name="location"><option value="">请选择</option>${dictionaryOptions('location',current.location)}</select></label>${inputField('责任人','owner',current.owner)}<label>设备状态<select name="status">${dictionaryOptions('status',current.status)}</select></label><label class="checkbox-row"><input name="critical" type="checkbox" ${current.critical?'checked':''}>关键设备</label><label class="wide">备注<textarea name="notes">${escapeHtml(current.notes||'')}</textarea></label>
  <h3 class="section-title">生命周期</h3>${inputField('采购日期','purchase_date',current.purchase_date,'date')}${inputField('启用日期','start_date',current.start_date,'date')}${inputField('保修截止日期','warranty_end',current.warranty_end,'date')}${inputField('维保周期（天）','maintenance_cycle',current.maintenance_cycle,'number')}${inputField('下次维保日期','next_maintenance',current.next_maintenance,'date')}${inputField('检定周期（天）','calibration_cycle',current.calibration_cycle,'number')}${inputField('下次检定日期','next_calibration',current.next_calibration,'date')}${inputField('报废日期','scrap_date',current.scrap_date,'date')}
  ${canPrice?`<h3 class="section-title">价格敏感信息 ${editPrice?'':'· 只读'}</h3>${inputField('采购原值','purchase_price',current.purchase_price,'number',editPrice?'step="0.01"':'disabled')}${inputField('采购单价','unit_price',current.unit_price,'number',editPrice?'step="0.01"':'disabled')}${inputField('合同金额','contract_amount',current.contract_amount,'number',editPrice?'step="0.01"':'disabled')}${inputField('发票金额','invoice_amount',current.invoice_amount,'number',editPrice?'step="0.01"':'disabled')}${inputField('残值','residual_value',current.residual_value,'number',editPrice?'step="0.01"':'disabled')}${inputField('维修费用','repair_cost',current.repair_cost,'number',editPrice?'step="0.01"':'disabled')}`:''}
  <h3 class="section-title">分类技术参数</h3>${state.customFields.filter((field)=>field.status==='published').map((field)=>customFieldControl(field,current)).join('')}<h3 class="section-title">说明书与资料</h3><label class="wide">设备说明书（可选，多选）<input name="manual_files" type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt,.xlsx" multiple><span class="field-help">保存设备后自动上传；也可在设备详情的附件资料中补充。</span></label></form>`;
  openDialog(item?'编辑设备':'新增设备',item?`${item.code} · 当前版本 ${item.version}`:'按分类模板填写设备资料',body,`<button class="button" data-close>取消</button><button class="button primary" id="save-device">保存设备</button>`,true);toggleCustomFields(current.category);
  const sections=[...$('#device-form').children];let group=-1;const grouped=[];for(const element of sections){if(element.matches('h3.section-title')){group++;grouped[group]=[];}grouped[group]?.push(element);}for(const key of state.configuration?.form?.groups||['basic','management','lifecycle','prices','technical','attachments']){const title={basic:'基本信息',management:'管理信息',lifecycle:'生命周期',prices:'价格敏感信息',technical:'分类技术参数',attachments:'说明书与资料'}[key];const section=grouped.find((elements)=>elements[0]?.textContent.startsWith(title));section?.forEach((element)=>$('#device-form').append(element));}
  $('[name="category"]').addEventListener('change',(event)=>toggleCustomFields(event.target.value));
  $('#device-form').addEventListener('change',(event)=>{if(event.target.name?.startsWith('custom_'))toggleCustomFields($('[name="category"]','#device-form').value);});
  $('#save-device').addEventListener('click',async(event)=>{
    const form=$('#device-form');if(!form.reportValidity())return;
    const button=event.currentTarget;
    const files=[...$('[name="manual_files"]',form).files].map((file)=>({file,fieldCode:null}));
    for(const field of state.customFields.filter((field)=>field.field_type==='attachment')){const input=$(`[name="custom_${field.code}"]`,form);if(input&&!input.disabled)files.push(...[...input.files].map((file)=>({file,fieldCode:field.code})));}
    try{files.forEach(({file})=>validateUploadFile(file));}catch(error){return toast(error.message,'error');}
    const values=formData(form);delete values.manual_files;
    values.department_id=Number(values.department_id);
    values.critical=$('[name="critical"]',form).checked;
    for(const field of [...PRICE_FIELD_NAMES,'maintenance_cycle','calibration_cycle'])if(field in values&&values[field]!=='')values[field]=Number(values[field]);
    const custom={...current.custom_data};
    for(const field of state.customFields){
      const input=$(`[name="custom_${field.code}"]`,form);
      if(input&&!input.disabled&&field.field_type!=='attachment')custom[field.code]=field.field_type==='boolean'?input.checked:field.field_type==='multiselect'?[...input.selectedOptions].map((option)=>option.value).filter(Boolean):input.value;
    }
    values.custom_data=custom;if(item)values.version=item.version;
    button.disabled=true;button.textContent='正在保存…';
    try{
      const result=await request(item?`/api/devices/${item.id}`:'/api/devices',{method:item?'PUT':'POST',body:values});
      const deviceId=item?.id||result.id;const failures=[];
      for(const entry of files){try{await uploadDeviceFile(deviceId,entry.file,entry.fieldCode?'其他':'说明书',entry.fieldCode);}catch(error){failures.push(`${entry.file.name}：${error.message}`);}}
      closeModal();toast(item?'设备已更新':'设备已新增');
      await openDevice(deviceId,files.length?'attachments':'basic');
      if(failures.length)toast(`设备已保存，部分文件需重新上传：${failures.join('；')}`,'error');
      if(state.page==='devices')await renderDevices();
    }catch(error){toast(error.message,'error');button.disabled=false;button.textContent='保存设备';}
  });
}
const PRICE_FIELD_NAMES=['purchase_price','unit_price','contract_amount','invoice_amount','residual_value','repair_cost'];
function toggleCustomFields(category){$$('.custom-field').forEach((field)=>{const input=$('input,select,textarea',field);const definition=state.customFields.find((item)=>`custom_${item.code}`===input?.name);const rule=definition?.settings?.visibleWhen;const controller=rule?.field?$(`[name="custom_${rule.field}"]`):null;const source=rule?.field?state.customFields.find((item)=>item.code===rule.field):null;const actual=controller?.type==='checkbox'?controller.checked:controller?.value;const condition=!rule?.field||source&&canField(source)&&String(actual??'')===String(rule.equals??'');field.hidden=!(field.dataset.category==='通用'||field.dataset.category===category)||!condition;$$('input,select,textarea',field).forEach((control)=>{control.disabled=field.hidden||!!(definition&&!canField(definition,'edit'));});});}

async function renderQuick(){
  const code=new URLSearchParams(location.hash.split('?')[1]||'').get('code')||'';
  root.innerHTML=`${pageHead('扫码 / 快速查找','输入设备编号、资产编号或序列号，精确结果优先展示')}<article class="panel"><div class="panel-body"><form id="quick-form" class="quick-search-form"><div class="global-search quick-search">${icon('search')}<input name="q" value="${escapeHtml(code)}" autofocus placeholder="例如 IT-PC-2026-0001"><kbd>Enter</kbd></div><button class="button primary">立即查找</button><button class="button" type="button" id="scan-qr">${icon('camera')}<span>扫描二维码</span></button></form><div id="quick-result">${empty('等待输入设备标识')}</div></div></article>`;
  const search=async()=>{const q=$('[name="q"]','#quick-form').value.trim();if(!q)return;$('#quick-result').innerHTML=loading();try{const data=await request(`/api/devices?q=${encodeURIComponent(q)}&pageSize=20`);$('#quick-result').innerHTML=data.rows.length?deviceTable(data.rows):empty('没有找到匹配设备');$$('.code-link','#quick-result').forEach((button)=>button.addEventListener('click',()=>openDevice(Number(button.dataset.id))));if(data.rows.length===1&&data.rows[0].code.toLowerCase()===q.toLowerCase())openDevice(data.rows[0].id);}catch(error){toast(error.message,'error');}};
  $('#quick-form').addEventListener('submit',(event)=>{event.preventDefault();search();});$('#scan-qr').addEventListener('click',scanQrCode);if(code)search();
}

async function scanQrCode(){
  if(!navigator.mediaDevices?.getUserMedia||!window.BarcodeDetector){toast('当前浏览器不支持二维码扫描，请使用上方输入框','error');return;}
  try{
    const detector=new BarcodeDetector({formats:['qr_code']});
    openDialog('扫描设备二维码','请将二维码放入取景范围','<video id="qr-camera" class="qr-camera" autoplay muted playsinline></video><p id="scan-state" class="field-help">正在请求摄像头权限…</p>','<button class="button" data-close>取消扫描</button>');
    const video=$('#qr-camera');
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    if(!$('#qr-camera')){stream.getTracks().forEach((track)=>track.stop());return;}
    state.scannerStream=stream;video.srcObject=stream;await video.play();
    if($('#scan-state'))$('#scan-state').textContent='正在识别二维码';
    const scan=async()=>{
      if(!$('#qr-camera')||!state.scannerStream)return;
      try{
        const codes=await detector.detect(video);
        if(codes.length){
          const parsed=new URL(codes[0].rawValue,location.origin);
          const code=parsed.searchParams.get('code')||new URLSearchParams(parsed.hash.split('?')[1]||'').get('code');
          closeModal();state.deviceQuery={page:1,pageSize:20,q:code||codes[0].rawValue};navigate('devices');return;
        }
      }catch{}
      if(state.scannerStream)state.scannerFrame=requestAnimationFrame(scan);
    };scan();
  }catch(error){closeModal();toast(error.name==='NotAllowedError'?'没有摄像头访问权限':'无法启动摄像头，请使用输入框查找','error');}
}

async function renderReminders(){
  const data=await request('/api/reminders');const overdue=data.rows.filter((item)=>[item.next_maintenance,item.next_calibration,item.warranty_end].some((value)=>value&&value<new Date().toISOString().slice(0,10))).length;
  root.innerHTML=`${pageHead('维保与提醒','统一跟踪保修、维保、检定校准和借用风险')}<div class="stat-strip"><div><strong>${data.rows.length}</strong><small>30天内需处理</small></div><div><strong>${overdue}</strong><small>已逾期事项</small></div><div><strong>${data.rows.filter((item)=>item.reminder_type==='校准到期').length}</strong><small>校准相关</small></div></div><article class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>提醒类型</th><th>设备</th><th>部门 / 责任人</th><th>保修截止</th><th>下次维保</th><th>下次校准</th></tr></thead><tbody>${data.rows.map((item)=>`<tr><td><span class="type-tag">${escapeHtml(item.reminder_type)}</span></td><td><button class="code-link" data-id="${item.id}">${escapeHtml(item.code)}</button><span class="cell-sub">${escapeHtml(item.name)}</span></td><td>${escapeHtml(item.department_name||'-')}<span class="cell-sub">${escapeHtml(item.owner||'未指定')}</span></td><td>${fullDate(item.warranty_end)}</td><td>${fullDate(item.next_maintenance)}</td><td>${fullDate(item.next_calibration)}</td></tr>`).join('')}</tbody></table></div>${data.rows.length?'':empty('当前没有到期事项')}</article>`;
  $$('.code-link').forEach((button)=>button.addEventListener('click',()=>openDevice(Number(button.dataset.id))));
  operations.reminderInbox(data.rows);
}

function departmentDepth(item,map){let depth=0,current=item;while(current.parent_id&&depth<4){depth++;current=map.get(current.parent_id)||{};}return depth;}
async function renderDepartments(){
  const data=await request('/api/departments');state.departments=data.rows;const map=new Map(data.rows.map((item)=>[item.id,item]));const selected=Number(sessionStorage.getItem('selectedDepartment'))||data.rows[0]?.id;const current=map.get(selected)||data.rows[0];
  root.innerHTML=`${pageHead('部门管理','部门树决定数据范围边界；有设备的部门只能停用',state.user.permissions.manageConfig?`<button class="button primary" id="add-department">${icon('plus')}新增部门</button>`:'')}<section class="split-layout"><article class="panel"><div class="panel-head"><h2>组织结构</h2><span class="type-tag">${data.rows.length} 个部门</span></div><div class="tree-list">${data.rows.map((item)=>`<button class="tree-row indent-${departmentDepth(item,map)}" data-dept="${item.id}" style="border:0;width:100%;background:${item.id===current?.id?'#f2f8f6':'#fff'};text-align:left"><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.code)} · ${item.device_count} 台设备</small></span><span class="status-tag">${item.status==='active'?'启用':'停用'}</span></button>`).join('')}</div></article><article class="panel"><div class="panel-head"><h2>部门详情</h2>${state.user.permissions.manageConfig&&data.manageableIds.includes(current?.id)?'<button class="button small" id="edit-department">编辑</button>':''}</div><div class="panel-body">${current?`<dl class="definition-grid"><div class="definition-item"><dt>部门名称</dt><dd>${escapeHtml(current.name)}</dd></div><div class="definition-item"><dt>部门编码</dt><dd>${escapeHtml(current.code)}</dd></div><div class="definition-item"><dt>上级部门</dt><dd>${escapeHtml(current.parent_name||'无')}</dd></div><div class="definition-item"><dt>负责人</dt><dd>${escapeHtml(current.manager||'-')}</dd></div><div class="definition-item"><dt>设备数量</dt><dd>${current.device_count} 台</dd></div><div class="definition-item"><dt>状态</dt><dd>${current.status==='active'?'启用':'停用'}</dd></div></dl>`:empty()}</div></article></section>`;
  $$('[data-dept]').forEach((button)=>button.addEventListener('click',()=>{sessionStorage.setItem('selectedDepartment',button.dataset.dept);renderDepartments();}));
  $('#add-department')?.addEventListener('click',()=>departmentForm());$('#edit-department')?.addEventListener('click',()=>departmentForm(current));
}

function departmentForm(item=null){openDialog(item?'编辑部门':'新增部门','部门编码创建后不可修改',`<form id="department-form" class="form-grid">${item?'':inputField('部门编码 *','code','','text','required')}${inputField('部门名称 *','name',item?.name,'text','required')}<label>上级部门<select name="parent_id"><option value="">无</option>${departmentOptions(item?.parent_id)}</select></label>${inputField('负责人','manager',item?.manager)}${inputField('排序','sort_order',item?.sort_order||0,'number')}<label>状态<select name="status"><option value="active" ${item?.status!=='disabled'?'selected':''}>启用</option><option value="disabled" ${item?.status==='disabled'?'selected':''}>停用</option></select></label></form>`,`<button class="button" data-close>取消</button><button class="button primary" id="save-department">保存</button>`);$('#save-department').addEventListener('click',async()=>{const form=$('#department-form');if(!form.reportValidity())return;const values=formData(form);values.parent_id=values.parent_id?Number(values.parent_id):null;try{await request(item?`/api/departments/${item.id}`:'/api/departments',{method:item?'PUT':'POST',body:values});closeModal();toast('部门已保存');await loadMeta();renderDepartments();}catch(error){toast(error.message,'error');}});}

const dictNames={category:'设备分类',status:'设备状态',location:'位置',vendor:'供应商',brand:'品牌'};
async function renderDictionaries(){
  const type=sessionStorage.getItem('dictType')||'category';const data=await request(`/api/dictionaries?type=${type}`);state.dictionaries=await request('/api/dictionaries').then((result)=>result.rows);
  root.innerHTML=`${pageHead('字典管理','统一选项来源，已引用字典项仅允许停用',state.user.permissions.manageConfig?`<button class="button primary" id="add-dict">${icon('plus')}新增字典项</button>`:'')}<div class="toolbar"><div class="quick-filters">${Object.entries(dictNames).map(([key,label])=>`<button class="filter-chip ${key===type?'active':''}" data-type="${key}">${label}</button>`).join('')}</div></div><article class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>名称</th><th>编码</th><th>归属范围</th><th>排序</th><th>状态</th><th></th></tr></thead><tbody>${data.rows.map((item)=>`<tr><td class="cell-title">${escapeHtml(item.name)}</td><td>${escapeHtml(item.code)}</td><td>${escapeHtml(state.departments.find((dept)=>dept.id===item.department_id)?.name||'平台全局')}</td><td>${item.sort_order}</td><td><span class="status-tag">${item.status==='active'?'启用':'停用'}</span></td><td>${state.user.permissions.manageConfig?`<button class="button small" data-edit-dict="${item.id}">编辑</button>`:''}</td></tr>`).join('')}</tbody></table></div></article>`;
  $$('[data-type]').forEach((button)=>button.addEventListener('click',()=>{sessionStorage.setItem('dictType',button.dataset.type);renderDictionaries();}));$('#add-dict')?.addEventListener('click',()=>dictionaryForm(type));$$('[data-edit-dict]').forEach((button)=>button.addEventListener('click',()=>dictionaryForm(type,data.rows.find((item)=>item.id===Number(button.dataset.editDict)))));
}

function dictionaryForm(type,item=null){openDialog(item?'编辑字典项':'新增字典项',dictNames[type],`<form id="dict-form" class="form-grid">${item?'':inputField('编码 *','code','','text','required')}${inputField('名称 *','name',item?.name,'text','required')}${inputField('排序','sort_order',item?.sort_order||0,'number')}<label>状态<select name="status"><option value="active" ${item?.status!=='disabled'?'selected':''}>启用</option><option value="disabled" ${item?.status==='disabled'?'selected':''}>停用</option></select></label></form>`,`<button class="button" data-close>取消</button><button class="button primary" id="save-dict">保存</button>`);$('#save-dict').addEventListener('click',async()=>{const form=$('#dict-form');if(!form.reportValidity())return;const values={...formData(form),dict_type:type};try{await request(item?`/api/dictionaries/${item.id}`:'/api/dictionaries',{method:item?'PUT':'POST',body:values});closeModal();toast('字典项已保存');await loadMeta();renderDictionaries();}catch(error){toast(error.message,'error');}});}

async function renderConfig(){
  const [fields,versions]=await Promise.all([request('/api/custom-fields?drafts=1'),request('/api/config/versions')]);const drafts=fields.rows.filter((item)=>item.status==='draft').length;
  root.innerHTML=`${pageHead('自定义配置中心','字段配置按草稿、预览、发布和版本回滚管理',state.user.role.code==='super_admin'?`<button class="button" id="preview-config">预览角色效果</button><button class="button" id="add-field">${icon('plus')}新增字段</button><button class="button primary" id="publish-config" ${drafts?'':'disabled'}>发布 ${drafts?`(${drafts})`:''}</button>`:'')}<section class="dashboard-grid"><article class="panel"><div class="panel-head"><h2>自定义字段</h2><span class="type-tag">${fields.rows.length} 个字段</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>字段</th><th>编码</th><th>分类模板</th><th>类型</th><th>规则</th><th>状态</th><th></th></tr></thead><tbody>${fields.rows.map((item)=>`<tr><td><span class="cell-title">${escapeHtml(item.name)}</span><span class="cell-sub">${item.sensitive?'敏感字段 · 自动进入权限矩阵':'普通字段'}</span></td><td>${escapeHtml(item.code)}</td><td>${escapeHtml(item.category)}</td><td>${escapeHtml(item.field_type)}</td><td>${item.required?'必填 · ':''}${item.filterable?'可筛选 · ':''}${item.exportable?'可导出':''}</td><td><span class="status-tag">${item.status==='published'?'已发布':item.status==='draft'?'草稿':'停用'}</span></td><td>${state.user.role.code==='super_admin'?`<button class="button small" data-edit-field="${item.id}">编辑</button>`:''}</td></tr>`).join('')}</tbody></table></div></article><article class="panel"><div class="panel-head"><h2>发布版本</h2></div><div class="record-list">${versions.rows.map((item)=>`<div class="record-row"><span><strong>字段配置 V${item.version_no}</strong><small>${escapeHtml(item.published_by_name||'系统')} · ${date(item.published_at)}</small></span>${state.user.role.code==='super_admin'?`<button class="button small" data-rollback="${item.id}">回滚</button>`:''}</div>`).join('')||empty('尚未发布配置版本')}</div></article></section>`;
  $('#add-field')?.addEventListener('click',()=>fieldForm());$$('[data-edit-field]').forEach((button)=>button.addEventListener('click',()=>fieldForm(fields.rows.find((item)=>item.id===Number(button.dataset.editField)))));
  if(state.user.permissions.manageConfig)await operations.configurationPanel();
  $('#publish-config')?.addEventListener('click',async()=>{if(!confirm(`确认发布 ${drafts} 个草稿字段？`))return;try{const data=await request('/api/config/publish',{method:'POST'});toast(`字段配置 V${data.version} 已发布`);await loadMeta();renderConfig();}catch(error){toast(error.message,'error');}});
  $$('[data-rollback]').forEach((button)=>button.addEventListener('click',async()=>{if(!confirm('回滚将覆盖当前字段配置，确认继续？'))return;try{await request(`/api/config/versions/${button.dataset.rollback}/rollback`,{method:'POST'});toast('配置已回滚');await loadMeta();renderConfig();}catch(error){toast(error.message,'error');}}));$('#preview-config')?.addEventListener('click',previewConfig);
}

function fieldForm(item=null){
  openDialog(item?'编辑自定义字段':'新增自定义字段','新字段先进入草稿，发布后用于表单、详情和权限矩阵',`<form id="field-form" class="form-grid">${item?`<label>字段编码<input value="${escapeHtml(item.code)}" disabled></label>`:inputField('字段编码 *','code','','text','required pattern="[a-z][a-z0-9_]{1,30}"')}${inputField('字段名称 *','name',item?.name,'text','required')}<label>字段类型<select name="field_type"><option value="text">单行文本</option><option value="number">数字</option><option value="date">日期</option><option value="select">下拉单选</option><option value="boolean">布尔</option></select></label><label>分类模板<select name="category"><option>通用</option>${dictionaryOptions('category',item?.category)}</select></label><label class="checkbox-row"><input name="required" type="checkbox" ${item?.required?'checked':''}>必填字段</label><label class="checkbox-row"><input name="sensitive" type="checkbox" ${item?.sensitive?'checked':''}>敏感字段</label><label class="checkbox-row"><input name="filterable" type="checkbox" ${item?.filterable!==0?'checked':''}>允许筛选</label><label class="checkbox-row"><input name="exportable" type="checkbox" ${item?.exportable!==0?'checked':''}>允许导出</label>${inputField('选项（逗号分隔）','options',(item?.options||[]).join(','))}${inputField('排序','sort_order',item?.sort_order||0,'number')}<label>状态<select name="status"><option value="draft">草稿</option><option value="published">已发布</option><option value="disabled">停用</option></select></label></form>`,`<button class="button" data-close>取消</button><button class="button primary" id="save-field">保存草稿</button>`);if(item){$('[name="field_type"]').value=item.field_type;$('[name="category"]').value=item.category;$('[name="status"]').value=item.status;}
  const fieldType=$('[name="field_type"]');const typeOptions={textarea:'多行文本',datetime:'日期时间',multiselect:'下拉多选',person:'人员',department:'部门',location:'位置',device:'关联设备编号'};for(const [value,label] of Object.entries(typeOptions))fieldType.insertAdjacentHTML('beforeend',`<option value="${value}">${label}</option>`);if(item){fieldType.value=item.field_type;fieldType.disabled=true;}
  const dictionary=document.createElement('label');dictionary.innerHTML=`选项来源字典<select name="dictionary_type"><option value="">请选择</option>${Object.entries(dictNames).map(([value,label])=>`<option value="${value}" ${item?.dictionary_type===value?'selected':''}>${label}</option>`).join('')}</select>`;$('#field-form').append(dictionary);const updateDictionary=()=>{dictionary.hidden=!['select','multiselect'].includes(fieldType.value);$('select',dictionary).disabled=dictionary.hidden;$('select',dictionary).required=!dictionary.hidden;};fieldType.addEventListener('change',updateDictionary);updateDictionary();
  fieldType.insertAdjacentHTML('beforeend','<option value="formula">公式（数字运算）</option><option value="attachment">附件字段</option>');if(item?.field_type==='formula'||item?.field_type==='attachment')fieldType.value=item.field_type;
  const formula=document.createElement('label');formula.className='wide';formula.innerHTML=`公式表达式<input name="formula" maxlength="240" value="${escapeHtml(item?.validation_rule?.startsWith('formula:')?item.validation_rule.slice(8):'')}"><span class="field-help">例如 {purchase_price} - {residual_value}，支持数字、括号和加减乘除，权限随引用字段收紧。</span>`;$('#field-form').append(formula);const updateFormula=()=>{formula.hidden=fieldType.value!=='formula';$('input',formula).disabled=formula.hidden||!!item;$('input',formula).required=!formula.hidden;};fieldType.addEventListener('change',updateFormula);updateFormula();
  const settings=document.createElement('div');settings.className='form-grid wide';settings.innerHTML=`${inputField('默认值','field_default',item?.settings?.defaultValue)}${inputField('文本最大长度','field_max_length',item?.settings?.maxLength,'number','min="1" max="10000"')}${inputField('数字最小值','field_min',item?.settings?.min,'number')}${inputField('数字最大值','field_max',item?.settings?.max,'number')}<label>显隐控制字段<select name="visibility_field"><option value="">始终显示</option>${state.customFields.filter((field)=>field.code!==item?.code).map((field)=>`<option value="${field.code}" ${item?.settings?.visibleWhen?.field===field.code?'selected':''}>${escapeHtml(field.name)}</option>`).join('')}</select></label>${inputField('控制字段等于此值时显示','visibility_equals',item?.settings?.visibleWhen?.equals)}`;$('#field-form').append(settings);
  $('#save-field').addEventListener('click',async()=>{const form=$('#field-form');if(!form.reportValidity())return;const values=formData(form);values.field_type=fieldType.value;values.required=$('[name="required"]',form).checked;values.sensitive=$('[name="sensitive"]',form).checked;values.filterable=$('[name="filterable"]',form).checked;values.exportable=$('[name="exportable"]',form).checked;values.options=values.options?values.options.split(',').map((value)=>value.trim()).filter(Boolean):[];try{await request(item?`/api/custom-fields/${item.id}`:'/api/custom-fields',{method:item?'PUT':'POST',body:values});closeModal();toast('字段配置已保存');await loadMeta();renderConfig();}catch(error){toast(error.message,'error');}});
}

function previewConfig(){
  openDialog('按角色预览配置','预览用于确认字段显示边界，不会修改正式数据',`<label>预览角色<select id="preview-role"><option value="staff">普通员工</option><option value="department_admin">部门管理员</option><option value="finance">财务角色</option></select></label><div id="preview-fields" class="definition-grid preview-fields"></div>`,`<button class="button" data-close>关闭</button>`);const draw=()=>{const role=$('#preview-role').value;$('#preview-fields').innerHTML=state.customFields.filter((field)=>field.status!=='disabled').map((field)=>`<div class="definition-item"><dt>${escapeHtml(field.name)}</dt><dd>${field.sensitive&&role!=='finance'?'<span class="masked">***</span>':`示例${field.field_type==='number'?' 100':'值'}`}</dd></div>`).join('');};$('#preview-role').addEventListener('change',draw);draw();
}

async function renderPermissions(){
  const [roles,users]=await Promise.all([request('/api/roles'),state.user.permissions.manageUsers?request('/api/users'):Promise.resolve({rows:[]})]);const permissions=[['view_price','查看价格'],['edit_price','修改价格'],['export_price','导出价格'],['sensitive_files','合同/发票'],['manage_data','维护设备'],['import_data','导入'],['export_data','导出'],['delete_data','删除'],['manage_config','配置中心'],['view_audit','审计日志']];
  root.innerHTML=`${pageHead('用户与权限','菜单、操作、数据范围、字段和附件权限统一配置')}<article class="panel"><div class="panel-head"><h2>角色权限矩阵</h2><span class="type-tag">超级管理员专属配置</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>角色</th><th>数据范围</th>${permissions.map(([,label])=>`<th>${label}</th>`).join('')}<th></th></tr></thead><tbody>${roles.rows.map((role)=>`<tr data-role-row="${role.id}"><td><span class="cell-title">${escapeHtml(role.name)}</span><span class="cell-sub">${escapeHtml(role.code)}</span></td><td><select name="data_scope" ${state.user.role.code!=='super_admin'?'disabled':''}><option value="all" ${role.data_scope==='all'?'selected':''}>全部</option><option value="department_descendants" ${role.data_scope==='department_descendants'?'selected':''}>本部门及下级</option><option value="self" ${role.data_scope==='self'?'selected':''}>仅本人</option></select></td>${permissions.map(([key])=>`<td><input type="checkbox" name="${key}" ${role[key]?'checked':''} ${state.user.role.code!=='super_admin'?'disabled':''}></td>`).join('')}<td>${state.user.role.code==='super_admin'?`<button class="button small" data-save-role="${role.id}">保存</button>`:''}</td></tr>`).join('')}</tbody></table></div></article><article class="panel users-panel"><div class="panel-head"><h2>用户账号</h2></div><div class="table-wrap"><table class="data-table"><thead><tr><th>用户</th><th>账号</th><th>角色</th><th>部门</th><th>MFA</th><th>状态</th></tr></thead><tbody>${users.rows.map((item)=>`<tr><td class="cell-title">${escapeHtml(item.name)}</td><td>${escapeHtml(item.username)}</td><td>${escapeHtml(item.role_name)}</td><td>${escapeHtml(item.department_name||'-')}</td><td>${item.mfa_enabled?'已启用':'未启用'}</td><td><span class="status-tag">${item.status==='active'?'启用':'停用'}</span></td></tr>`).join('')}</tbody></table></div></article>`;
  $$('[data-save-role]').forEach((button)=>button.addEventListener('click',async()=>{const row=button.closest('tr');const values={data_scope:$('[name="data_scope"]',row).value};permissions.forEach(([key])=>values[key]=$(`[name="${key}"]`,row).checked);try{await request(`/api/roles/${button.dataset.saveRole}`,{method:'PUT',body:values});toast('角色权限已更新');}catch(error){toast(error.message,'error');}}));
  if(state.user.permissions.manageUsers)await operations.users();
}

const actionNames={login:'登录',login_failed:'登录失败',logout:'退出',create:'新增',update:'修改',delete:'删除',view_price:'查看价格',export:'导出',import:'导入',upload_attachment:'上传附件',download_attachment:'下载附件',delete_attachment:'删除附件',publish_config:'发布配置',rollback_config:'回滚配置',update_permission:'修改权限',backup:'备份'};
async function renderAudit(){
  const action=sessionStorage.getItem('auditAction')||'';const data=await request(`/api/audit?action=${encodeURIComponent(action)}&pageSize=50`);
  root.innerHTML=`${pageHead('审计日志','敏感查看、变更、导入导出和配置操作均不可关闭')}<div class="toolbar"><select id="audit-action" style="width:180px"><option value="">全部操作</option>${Object.entries(actionNames).map(([key,label])=>`<option value="${key}" ${key===action?'selected':''}>${label}</option>`).join('')}</select><span class="type-tag">共 ${data.total} 条</span></div><article class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>操作</th><th>摘要</th><th>对象</th><th>操作人</th><th>IP</th></tr></thead><tbody>${data.rows.map((item)=>`<tr><td>${date(item.created_at)}</td><td><span class="type-tag">${escapeHtml(actionNames[item.action]||item.action)}</span></td><td>${escapeHtml(item.summary)}</td><td>${escapeHtml(item.object_type)} · ${escapeHtml(item.object_id||'-')}</td><td>${escapeHtml(item.user_name||'系统')}</td><td>${escapeHtml(item.ip||'-')}</td></tr>`).join('')}</tbody></table></div>${data.rows.length?'':empty('暂无审计日志')}</article>`;
  $('#audit-action').addEventListener('change',(event)=>{sessionStorage.setItem('auditAction',event.target.value);renderAudit();});
}

async function renderSettings(){
  root.innerHTML=`${pageHead('系统设置','查看安全基线、附件策略和备份状态')}<div class="settings-grid"><article class="setting-block"><h3>登录安全</h3><p>管理员强制使用TOTP动态验证码；连续5次失败锁定5分钟；会话有效期8小时。</p><span class="status-tag">已启用</span></article><article class="setting-block"><h3>接口与字段权限</h3><p>所有写接口校验CSRF令牌，设备数据范围和价格字段均在服务端执行。</p><span class="status-tag">硬约束</span></article><article class="setting-block"><h3>附件安全</h3><p>附件经过鉴权访问，类型白名单与${attachmentLimitMB}MB限制生效；合同和发票单独授权。</p><span class="status-tag">私有存储</span></article><article class="setting-block"><h3>审计保留</h3><p>登录、修改、删除、价格查看、导出和附件下载均记录操作人、时间和IP。</p><span class="status-tag">不可关闭</span></article><article class="setting-block"><h3>数据库备份</h3><p>立即创建SQLite一致性副本。生产部署建议由计划任务每日执行并异地保留30天。</p>${state.user.role.code==='super_admin'?'<button class="button primary" id="run-backup">立即备份</button>':'<span class="type-tag">仅超级管理员</span>'}</article><article class="setting-block"><h3>部署状态</h3><p>${state.cloud?'已连接持久化云数据库，台账、附件与导出均在云端保存。':'当前为本地运行版本，数据保存在本机目录。'}</p><span class="status-tag">新疆紫金黄金</span></article></div>`;
  $('#run-backup')?.addEventListener('click',async()=>{try{const data=await request('/api/backup',{method:'POST'});toast(`备份已生成：${data.fileName}`);}catch(error){toast(error.message,'error');}});
  if(state.user.role.code==='super_admin')await operations.backupStatus();
}

function parseCsv(text){
  const rows=[];let row=[];let value='';let quote=false;for(let i=0;i<text.length;i++){const char=text[i];if(char==='"'){if(quote&&text[i+1]==='"'){value+='"';i++;}else quote=!quote;}else if(char===','&&!quote){row.push(value.trim());value='';}else if((char==='\n'||char==='\r')&&!quote){if(char==='\r'&&text[i+1]==='\n')i++;row.push(value.trim());if(row.some(Boolean))rows.push(row);row=[];value='';}else value+=char;}if(value||row.length){row.push(value.trim());rows.push(row);}const headers=rows.shift()||[];return rows.map((items)=>Object.fromEntries(headers.map((header,index)=>[header.replace(/^\ufeff/,''),items[index]||''])));}
