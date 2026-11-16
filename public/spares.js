export function createSparePartsUI(context){
  const {$,$$,state,request,toast,openDialog,closeModal,inputField,escapeHtml,icon,date,departmentOptions}=context;
  const number=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:6});
  const currency=new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY',minimumFractionDigits:2,maximumFractionDigits:6});
  const stockAttributes='min="0" max="1000000000" step="0.000001" required';
  const movementNames={opening:'期初建账',in:'入库',out:'出库',adjust:'盘点调整'};
  let renderSequence=0,detailSequence=0,categories=[],activePage;

  const permissions=()=>state.user?.permissions||{};
  const formatNumber=(value)=>number.format(Number(value)||0);
  const price=(value)=>value==null?'未填写':currency.format(Number(value));
  const isLow=(part)=>Number(part.quantity)<=Number(part.min_stock||0);
  const stockText=(part)=>Number(part.quantity)===0?'缺货':isLow(part)?'库存偏低':Number(part.max_stock)>0&&Number(part.quantity)>Number(part.max_stock)?'超过上限':'库存正常';
  const empty=(message)=>`<div class="empty-state">${icon('box')}<span>${escapeHtml(message)}</span></div>`;
  const apiPath=(id)=>`/api/spares/${encodeURIComponent(id)}`;
  const currentQuery=()=>state.sparesQuery||(state.sparesQuery={q:'',category:'',lowStock:false,page:1,pageSize:20});

  function queryString(query,{paging=true}={}){
    const values=new URLSearchParams();
    if(query.q)values.set('q',query.q);
    if(query.category)values.set('category',query.category);
    if(query.lowStock)values.set('lowStock','1');
    if(paging){values.set('page',String(query.page||1));values.set('pageSize',String(query.pageSize||20));}
    return values.toString();
  }

  async function reload(){
    if(state.page!==activePage)return;
    try{await render();}catch(error){toast(error.message,'error');}
  }

  async function render(){
    const sequence=++renderSequence,page=state.page,root=$('#page-root');activePage=page;
    if(!root)return;
    const query={...currentQuery()};
    const data=await request(`/api/spares?${queryString(query)}`);
    if(sequence!==renderSequence||page!==state.page||!root.isConnected)return;
    const pages=Math.max(1,Math.ceil(data.total/data.pageSize));
    if(data.page>pages){state.sparesQuery={...query,page:pages};return render();}
    categories=Array.isArray(data.categories)?data.categories:[];
    const filterCategories=[...new Set([...categories,...(query.category?[query.category]:[])])];
    const summary=data.summary||{};
    const actions=`${permissions().exportData?`<button class="button" id="spares-export" aria-label="导出备件台账">${icon('download')}<span>导出备件台账</span></button>`:''}${permissions().manageData?`<button class="button primary" id="spares-add" aria-label="新增备品备件">${icon('plus')}<span>新增备品备件</span></button>`:''}`;
    root.innerHTML=`<header class="page-head"><div><h1>备品备件台账</h1><p>独立管理备件资料、技术参数、适配设备及库存出入记录</p></div><div class="head-actions">${actions}</div></header>
      <section class="metrics-grid spares-metrics">
        ${metric('备件种类',summary.items??data.total,'当前筛选范围内的备件品种','box')}
        ${metric('低库存提醒',summary.lowStock??0,'库存达到或低于最低库存','bell',(summary.lowStock??0)>0?'alert':'')}
        ${metric('库存数量汇总',summary.quantity??0,'不同计量单位合计仅作参考','grid')}
        ${metric('技术参数','自定义','支持尺寸、压力、功率、材质等参数','sliders')}
      </section>
      <form id="spares-filters" class="filter-grid"><input name="q" maxlength="200" value="${escapeHtml(query.q||'')}" placeholder="搜索编号、名称、型号、图号、适配设备或参数" aria-label="搜索备品备件"><select name="category" aria-label="备件分类"><option value="">全部分类</option>${filterCategories.map((category)=>`<option value="${escapeHtml(category)}" ${category===query.category?'selected':''}>${escapeHtml(category)}</option>`).join('')}</select><label class="checkbox-row"><input type="checkbox" name="lowStock" ${query.lowStock?'checked':''}>仅看低库存</label><button class="button primary" type="submit">${icon('search')}查询</button><button class="button" type="button" id="spares-clear">重置筛选</button></form>
      <article class="panel"><div class="panel-head"><h2>备件清单 <span class="type-tag">${formatNumber(data.total)} 种</span></h2><label class="toolbar-actions"><span class="field-help">每页</span><select id="spares-page-size" aria-label="每页备件数量">${[20,50,100].map((size)=>`<option value="${size}" ${Number(data.pageSize)===size?'selected':''}>${size} 条</option>`).join('')}</select></label></div>${table(data.rows||[])}<div class="pagination"><span>共 ${formatNumber(data.total)} 种 · 第 ${data.page} / ${pages} 页</span><div class="page-buttons"><button id="spares-prev" aria-label="上一页" ${data.page<=1?'disabled':''}>‹</button><button id="spares-next" aria-label="下一页" ${data.page>=pages?'disabled':''}>›</button></div></div></article>`;
    $('#spares-add',root)?.addEventListener('click',()=>partForm());
    $('#spares-export',root)?.addEventListener('click',downloadExport);
    const filters=$('#spares-filters',root);
    const applyFilters=()=>{state.sparesQuery={...currentQuery(),q:$('[name="q"]',filters).value.trim(),category:$('[name="category"]',filters).value,lowStock:$('[name="lowStock"]',filters).checked,page:1};reload();};
    filters.addEventListener('submit',(event)=>{event.preventDefault();applyFilters();});
    filters.addEventListener('change',(event)=>{if(event.target.matches('select,input[type="checkbox"]'))applyFilters();});
    $('#spares-clear',root).addEventListener('click',()=>{state.sparesQuery={q:'',category:'',lowStock:false,page:1,pageSize:currentQuery().pageSize};reload();});
    $('#spares-page-size',root).addEventListener('change',(event)=>{state.sparesQuery={...currentQuery(),page:1,pageSize:Number(event.target.value)};reload();});
    $('#spares-prev',root).addEventListener('click',()=>{state.sparesQuery={...currentQuery(),page:Math.max(1,data.page-1)};reload();});
    $('#spares-next',root).addEventListener('click',()=>{state.sparesQuery={...currentQuery(),page:data.page+1};reload();});
    $$('[data-spares-view]',root).forEach((button)=>button.addEventListener('click',()=>openPart(button.dataset.sparesView)));
    $$('[data-spares-move]',root).forEach((button)=>button.addEventListener('click',()=>openMovement(button.dataset.sparesMove,button.dataset.kind)));
  }

  function metric(label,value,note,symbol,type=''){
    const display=typeof value==='number'?formatNumber(value):escapeHtml(value);
    return `<article class="metric ${type}"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(symbol)}</span></div><div class="metric-value">${display}</div><div class="metric-note">${note}</div></article>`;
  }

  function table(rows){
    if(!rows.length)return empty('暂无符合条件的备品备件');
    return `<div class="table-wrap"><table class="data-table"><thead><tr><th>备件编号 / 名称</th><th>分类 / 型号</th><th>规格 / 材质</th><th>库存 / 最低库存</th><th>仓库 / 库位</th><th>适配设备 / 型号</th><th>部门 / 保管人</th>${permissions().viewPrice?'<th>单价（元）</th>':''}<th>操作</th></tr></thead><tbody>${rows.map((part)=>`<tr><td><button class="code-link" data-spares-view="${escapeHtml(part.id)}">${escapeHtml(part.code)}</button><span class="cell-sub">${escapeHtml(part.name)}</span></td><td>${escapeHtml(part.category||'其他')}<span class="cell-sub">${escapeHtml(part.model||'—')}</span></td><td>${escapeHtml(part.specification||'—')}<span class="cell-sub">${escapeHtml(part.material||'—')}</span></td><td><strong>${formatNumber(part.quantity)} ${escapeHtml(part.unit||'件')}</strong><span class="cell-sub">最低 ${formatNumber(part.min_stock)} · <span class="${isLow(part)?'critical-mark':''}">${stockText(part)}</span></span></td><td>${escapeHtml(part.warehouse||'—')}<span class="cell-sub">${escapeHtml(part.bin_location||'—')}</span></td><td>${escapeHtml(part.compatible_device||'—')}</td><td>${escapeHtml(part.department_name||'—')}<span class="cell-sub">${escapeHtml(part.owner||'—')}</span></td>${permissions().viewPrice?`<td>${escapeHtml(price(part.unit_price))}</td>`:''}<td><div class="toolbar-actions"><button class="button small" data-spares-view="${escapeHtml(part.id)}">详情</button>${permissions().manageData?`<button class="button small" data-spares-move="${escapeHtml(part.id)}" data-kind="in">入库</button><button class="button small" data-spares-move="${escapeHtml(part.id)}" data-kind="out">出库</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>`;
  }

  function definitions(entries){
    return `<dl class="definition-grid">${entries.map(([label,value])=>`<div class="definition-item"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value==null||value===''?'—':value)}</dd></div>`).join('')}</dl>`;
  }

  function parameterTable(parameters){
    if(!parameters?.length)return '<p class="field-help">尚未填写技术参数，可在编辑资料中添加。</p>';
    return `<div class="table-wrap"><table class="data-table"><thead><tr><th>参数名称</th><th>参数值</th><th>单位</th></tr></thead><tbody>${parameters.map((parameter)=>`<tr><td>${escapeHtml(parameter.name)}</td><td>${escapeHtml(parameter.value??'—')}</td><td>${escapeHtml(parameter.unit||'—')}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function movementTable(movements,part){
    if(!movements?.length)return '<p class="field-help">暂无库存变动记录。</p>';
    return `<div class="table-wrap"><table class="data-table"><thead><tr><th>操作时间</th><th>类型</th><th>数量（${escapeHtml(part.unit||'件')}）</th><th>变动前 → 变动后</th><th>原因 / 用途</th><th>经办人</th></tr></thead><tbody>${movements.map((movement)=>`<tr><td>${escapeHtml(date(movement.created_at))}</td><td>${escapeHtml(movementNames[movement.kind]||movement.kind)}</td><td>${movement.kind==='adjust'?`盘点至 ${formatNumber(movement.after_quantity)}`:`${movement.kind==='out'?'−':movement.kind==='in'?'+':''}${formatNumber(movement.quantity)}`}</td><td>${formatNumber(movement.before_quantity)} → ${formatNumber(movement.after_quantity)}</td><td>${escapeHtml(movement.reason||'—')}</td><td>${escapeHtml(movement.user_name||'—')}</td></tr>`).join('')}</tbody></table></div>`;
  }

  async function openPart(id){
    if(state.page!==activePage)return;
    const sequence=++detailSequence,page=state.page;
    try{
      const data=await request(apiPath(id));
      if(sequence!==detailSequence||page!==state.page)return;
      showPart(data.part,data.movements||[]);
    }catch(error){toast(error.message,'error');}
  }

  function showPart(part,movements){
    const entries=[['备件编号',part.code],['备件分类',part.category||'其他'],['型号',part.model],['规格',part.specification],['图号 / 物料号',part.drawing_no],['材质',part.material],['生产厂商',part.manufacturer],['供应商',part.supplier],['适配设备 / 型号',part.compatible_device],['归属部门',part.department_name],['保管人',part.owner],['计量单位',part.unit],['当前库存',formatNumber(part.quantity)],['最低库存',formatNumber(part.min_stock)],['最高库存',Number(part.max_stock)>0?formatNumber(part.max_stock):'未设置'],['仓库',part.warehouse],['库位',part.bin_location],['更新时间',date(part.updated_at)]];
    if(permissions().viewPrice)entries.push(['采购单价',price(part.unit_price)]);
    openDialog(`${part.code} · ${part.name}`,`${part.department_name||'未分配部门'} · 数据版本 ${part.version}`,`<div class="detail-hero"><div><h3>${escapeHtml(part.name)}</h3><p>${escapeHtml(part.category||'其他')} · ${escapeHtml(part.model||'未填写型号')}</p></div><div><strong>${formatNumber(part.quantity)} ${escapeHtml(part.unit||'件')}</strong><p>${stockText(part)}</p></div></div>${isLow(part)?'<div class="notice warning">当前库存已达到或低于最低库存，请及时安排补货。</div>':''}<h3 class="section-title">备件资料</h3>${definitions(entries)}<h3 class="section-title">技术参数</h3>${parameterTable(part.parameters)}<h3 class="section-title">备注</h3><p class="spares-notes">${escapeHtml(part.notes||'—').replace(/\r?\n/g,'<br>')}</p><div class="toolbar"><h3>库存变动记录</h3>${permissions().manageData?'<div class="toolbar-actions"><button class="button small" id="spares-detail-in">入库</button><button class="button small" id="spares-detail-out">出库</button><button class="button small" id="spares-detail-adjust">盘点调整</button></div>':''}</div>${movementTable(movements,part)}`,`<span class="foot-spacer"></span>${permissions().deleteData?'<button class="button danger" id="spares-delete">删除</button>':''}${permissions().manageData?`<button class="button" id="spares-edit">${icon('edit')}编辑资料 / 参数</button>`:''}<button class="button" data-close>关闭</button>`,true);
    $('#spares-edit')?.addEventListener('click',()=>partForm(part));
    $('#spares-delete')?.addEventListener('click',async(event)=>{
      if(!confirm(`确认删除备品备件 ${part.code}？库存变动记录和历史日志将保留。`))return;
      const button=event.currentTarget;button.disabled=true;
      try{await request(apiPath(part.id),{method:'DELETE',body:{version:part.version}});closeModal();toast('备品备件已删除');await reload();}catch(error){toast(error.message,'error');if(button.isConnected)button.disabled=false;}
    });
    for(const kind of ['in','out','adjust'])$(`#spares-detail-${kind}`)?.addEventListener('click',()=>movementForm(part,kind));
  }

  function partForm(part=null){
    if(!permissions().manageData)return toast('当前角色没有备品备件维护权限','error');
    ++detailSequence;
    const current=part||{category:'其他',unit:'件',quantity:0,min_stock:0,max_stock:0,department_id:state.user.department?.id,owner:state.user.name||'',parameters:[]};
    const ownerReadonly=state.user.role?.dataScope==='self';
    const body=`<form id="spares-form" class="form-grid"><h3 class="section-title">基本资料</h3>${inputField('备件编号 *','code',current.code,'text','required maxlength="100"')}${inputField('备件名称 *','name',current.name,'text','required maxlength="200"')}<label>备件分类 *<input name="category" required maxlength="100" list="spares-category-options" value="${escapeHtml(current.category||'其他')}"><datalist id="spares-category-options">${[...new Set(['其他',...categories])].map((category)=>`<option value="${escapeHtml(category)}"></option>`).join('')}</datalist><span class="field-help">可选择已有分类，也可直接输入新分类</span></label>${inputField('型号','model',current.model,'text','maxlength="300"')}${inputField('规格','specification',current.specification,'text','maxlength="2000"')}${inputField('图号 / 物料号','drawing_no',current.drawing_no,'text','maxlength="200"')}${inputField('材质','material',current.material,'text','maxlength="200"')}${inputField('生产厂商','manufacturer',current.manufacturer,'text','maxlength="200"')}${inputField('供应商','supplier',current.supplier,'text','maxlength="200"')}${inputField('适配设备 / 型号','compatible_device',current.compatible_device,'text','maxlength="500"')}<h3 class="section-title">库存与保管</h3>${inputField('计量单位 *','unit',current.unit||'件','text','required maxlength="20"')}${part?`<label>当前库存（${escapeHtml(current.unit||'件')}）<input type="text" value="${formatNumber(current.quantity)}" disabled><span class="field-help">库存数量通过入库、出库、盘点调整修改</span></label>`:inputField('期初库存 *','quantity',current.quantity,'number',stockAttributes)}${inputField('最低库存 *','min_stock',current.min_stock??0,'number',stockAttributes)}${inputField('最高库存（0 表示不设上限）','max_stock',current.max_stock??0,'number',stockAttributes)}${inputField('仓库','warehouse',current.warehouse,'text','maxlength="200"')}${inputField('库位','bin_location',current.bin_location,'text','maxlength="200"')}<label>归属部门 *<select name="department_id" required>${departmentOptions(current.department_id)}</select></label>${inputField('保管人','owner',current.owner,'text',`maxlength="100" ${ownerReadonly?'readonly':''}`)}${permissions().editPrice?inputField('采购单价（元）','unit_price',current.unit_price??'','number','min="0" max="1000000000" step="0.000001"'):''}<h3 class="section-title">自定义技术参数</h3><p class="wide field-help">每项由参数名称、参数值和单位组成，最多 30 项。例如：内径 30 mm、工作压力 1.6 MPa、额定功率 15 kW。</p><div id="spares-parameters" class="wide record-list"></div><div class="wide toolbar"><span id="spares-parameter-count" class="field-help" aria-live="polite"></span><button class="button small" type="button" id="spares-parameter-add">${icon('plus')}添加参数</button></div><h3 class="section-title">其他信息</h3><label class="wide">备注<textarea name="notes" maxlength="4000">${escapeHtml(current.notes||'')}</textarea></label><p id="spares-form-error" class="wide field-help" role="alert"></p></form>`;
    openDialog(part?'编辑备品备件':'新增备品备件',part?`${part.code} · 当前版本 ${part.version}`:'建立独立备件资料，按实际需求填写技术参数',body,`<button class="button" data-close>取消</button><button class="button primary" id="spares-save">保存备品备件</button>`,true);
    const form=$('#spares-form'),parameterRoot=$('#spares-parameters',form);
    const updateParameterCount=()=>{const count=$$('[data-spares-parameter-row]',parameterRoot).length;$('#spares-parameter-count',form).textContent=`已添加 ${count} / 30 项参数`;$('#spares-parameter-add',form).disabled=count>=30;};
    const addParameter=(parameter={})=>{
      if($$('[data-spares-parameter-row]',parameterRoot).length>=30)return;
      const row=document.createElement('div');row.className='form-grid spares-parameter-row';row.dataset.sparesParameterRow='';
      row.innerHTML=`<label>参数名称 *<input data-spares-parameter-name maxlength="100" value="${escapeHtml(parameter.name||'')}" placeholder="如：内径、工作压力"></label><label>参数值<input data-spares-parameter-value maxlength="1000" value="${escapeHtml(parameter.value??'')}" placeholder="如：30、1.6"></label><label>单位<input data-spares-parameter-unit maxlength="30" value="${escapeHtml(parameter.unit||'')}" placeholder="如：mm、MPa"></label><button class="button danger small" type="button" data-spares-parameter-remove aria-label="删除此项参数">删除参数</button>`;
      parameterRoot.append(row);updateParameterCount();return row;
    };
    (current.parameters||[]).forEach(addParameter);updateParameterCount();
    $('#spares-parameter-add',form).addEventListener('click',()=>{const row=addParameter();$('[data-spares-parameter-name]',row)?.focus();});
    parameterRoot.addEventListener('click',(event)=>{const button=event.target.closest('[data-spares-parameter-remove]');if(button){button.closest('[data-spares-parameter-row]').remove();updateParameterCount();}});
    const save=async()=>{
      if(!form.reportValidity())return;
      const values=Object.fromEntries(new FormData(form));
      for(const key of Object.keys(values))if(typeof values[key]==='string')values[key]=values[key].trim();
      values.parameters=[];const names=new Set();
      for(const row of $$('[data-spares-parameter-row]',parameterRoot)){
        const name=$('[data-spares-parameter-name]',row),value=$('[data-spares-parameter-value]',row).value.trim(),unit=$('[data-spares-parameter-unit]',row).value.trim();
        if(!name.value.trim()&&!value&&!unit)continue;
        if(!name.value.trim()){$('#spares-form-error',form).textContent='请为每个已填写的参数输入名称。';name.focus();return;}
        if(names.has(name.value.trim())){$('#spares-form-error',form).textContent=`参数名称不能重复：${name.value.trim()}`;name.focus();return;}
        names.add(name.value.trim());values.parameters.push({name:name.value.trim(),value,unit});
      }
      values.department_id=Number(values.department_id);
      for(const key of ['quantity','min_stock','max_stock'])if(Object.hasOwn(values,key))values[key]=Number(values[key]);
      if(permissions().editPrice)values.unit_price=values.unit_price===''?null:Number(values.unit_price);else delete values.unit_price;
      if(values.max_stock>0&&values.max_stock<values.min_stock){$('#spares-form-error',form).textContent='最高库存不能小于最低库存。';$('[name="max_stock"]',form).focus();return;}
      if(part)values.version=part.version;
      const button=$('#spares-save');if(!button||button.disabled)return;button.disabled=true;button.textContent='正在保存…';$('#spares-form-error',form).textContent='';
      try{
        const result=await request(part?apiPath(part.id):'/api/spares',{method:part?'PUT':'POST',body:values});
        if(!form.isConnected){await reload();return;}
        closeModal();toast(part?'备件资料和参数已更新':'备品备件已新增');await reload();await openPart(part?.id||result.id);
      }catch(error){if(form.isConnected){$('#spares-form-error',form).textContent=error.message;button.disabled=false;button.textContent='保存备品备件';}toast(error.message,'error');}
    };
    form.addEventListener('submit',(event)=>{event.preventDefault();save();});$('#spares-save').addEventListener('click',save);
  }

  async function openMovement(id,kind){
    if(!permissions().manageData||state.page!==activePage)return;
    const sequence=++detailSequence,page=state.page;
    try{const data=await request(apiPath(id));if(sequence===detailSequence&&page===state.page)movementForm(data.part,kind);}catch(error){toast(error.message,'error');}
  }

  function movementForm(part,kind){
    if(!permissions().manageData)return toast('当前角色没有库存维护权限','error');
    if(!['in','out','adjust'].includes(kind))return;
    ++detailSequence;
    const title=movementNames[kind],unit=part.unit||'件';
    openDialog(`${title} · ${part.name}`,`${part.code} · 当前库存 ${formatNumber(part.quantity)} ${unit}`,`<form id="spares-movement-form" class="form-grid"><div class="notice wide">${kind==='adjust'?'盘点调整填写盘点后的实际库存数量，系统会保留调整前后余额。':kind==='out'?'记录领用、维修更换等出库数量，出库后库存不能小于零。':'记录采购到货、退料等新增入库数量。'}</div>${inputField(`${kind==='adjust'?'盘点实存数量':'本次'+title+'数量'}（${escapeHtml(unit)}） *`,'quantity',kind==='adjust'?part.quantity:'','number',`min="${kind==='adjust'?'0':'0.000001'}" max="${kind==='out'?Number(part.quantity):1000000000}" step="0.000001" required`)}<label>操作后库存<input id="spares-stock-preview" disabled value="—"></label><label class="wide">${title}原因 / 用途 *<textarea name="reason" maxlength="1000" required placeholder="如：采购到货、设备维修领用、年度盘点差异"></textarea></label><p id="spares-movement-error" class="wide field-help" role="alert"></p></form>`,`<button class="button" id="spares-movement-back">返回备件详情</button><button class="button primary" id="spares-movement-save">确认${title}</button>`);
    const form=$('#spares-movement-form'),quantityInput=$('[name="quantity"]',form),preview=$('#spares-stock-preview',form);
    const refreshPreview=()=>{const amount=Number(quantityInput.value);const after=kind==='adjust'?amount:Number(part.quantity)+(kind==='in'?amount:-amount);preview.value=quantityInput.value!==''&&Number.isFinite(after)?`${formatNumber(after)} ${unit}`:'—';};
    quantityInput.addEventListener('input',refreshPreview);refreshPreview();
    $('#spares-movement-back').addEventListener('click',()=>openPart(part.id));
    const save=async()=>{
      if(!form.reportValidity())return;
      const reason=$('[name="reason"]',form).value.trim();if(!reason){$('#spares-movement-error',form).textContent='请填写库存操作原因。';$('[name="reason"]',form).focus();return;}
      const button=$('#spares-movement-save');if(!button||button.disabled)return;button.disabled=true;button.textContent='正在保存…';$('#spares-movement-error',form).textContent='';
      try{await request(`${apiPath(part.id)}/movements`,{method:'POST',body:{kind,quantity:Number(quantityInput.value),reason,version:part.version}});if(!form.isConnected){await reload();return;}closeModal();toast(`${title}记录已保存`);await reload();await openPart(part.id);}catch(error){if(form.isConnected){$('#spares-movement-error',form).textContent=error.message;button.disabled=false;button.textContent=`确认${title}`;}toast(error.message,'error');}
    };
    form.addEventListener('submit',(event)=>{event.preventDefault();save();});$('#spares-movement-save').addEventListener('click',save);
  }

  async function downloadExport(event){
    if(!permissions().exportData)return;
    const button=event.currentTarget;button.disabled=true;
    try{
      const query=queryString(currentQuery(),{paging:false});
      const response=await fetch(`/api/spares/export${query?'?'+query:''}`,{credentials:'same-origin'});
      if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(result.error||'备件台账导出失败');}
      const blob=await response.blob(),link=document.createElement('a'),url=URL.createObjectURL(blob);
      link.href=url;link.download=`备品备件台账-${new Date().toLocaleDateString('sv-SE')}.xls`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('备件台账已导出');
    }catch(error){toast(error.message,'error');}finally{if(button.isConnected)button.disabled=false;}
  }

  return {render};
}
