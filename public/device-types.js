export function createDeviceTypesUI(context) {
  const { $, $$, state, request, toast, openDialog, closeModal, inputField, escapeHtml, icon, loadMeta } = context;
  const canManage = () => state.user?.role?.code === 'super_admin' && !!state.user?.permissions?.manageConfig;
  let rows = [];

  async function refresh() {
    await loadMeta();
    await render();
  }

  async function render() {
    const data = await request('/api/device-types');
    rows = data.rows;
    const writable = canManage();
    $('#page-root').innerHTML = `<header class="page-head"><div><h1>设备类型</h1><p>按公司设备实际情况维护类型，并为各类型设置专属技术参数</p></div><div class="head-actions">${writable ? `<button class="button primary" id="add-device-type">${icon('plus')}新增设备类型</button>` : ''}</div></header>
      <article class="panel"><div class="panel-head"><h2>类型目录</h2><span class="type-tag">${rows.length} 个类型</span></div><div class="panel-body"><p class="field-help">在“自定义配置”中新增参数，将“适用设备类型”设为对应类型并发布，即可在设备表单和详情中使用。停用后不能给新设备选择该类型，原有设备和历史参数保留。设备数量按当前账号可见范围统计。</p>${!writable ? '<p class="field-help">当前账号可查看类型，平台管理员可新增、改名和停用。</p>' : ''}</div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>类型名称</th><th>类型编码</th><th>设备数量</th><th>专属参数</th><th>排序</th><th>状态</th>${writable ? '<th>操作</th>' : ''}</tr></thead><tbody>${rows.map((row) => `<tr><td><span class="cell-title">${escapeHtml(row.name)}</span></td><td>${escapeHtml(row.code)}</td><td>${Number(row.device_count) || 0}</td><td>${Number(row.field_count) || 0}</td><td>${Number(row.sort_order) || 0}</td><td><span class="status-tag">${row.status === 'active' ? '启用' : '停用'}</span></td>${writable ? `<td><button class="button small" data-edit-device-type="${Number(row.id)}">编辑</button> <button class="button small ${row.status === 'active' ? 'danger' : ''}" data-toggle-device-type="${Number(row.id)}">${row.status === 'active' ? '停用' : '启用'}</button></td>` : ''}</tr>`).join('') || `<tr><td colspan="${writable ? 7 : 6}"><div class="empty-state">暂无设备类型${writable ? '，点击“新增设备类型”建立目录' : ''}</div></td></tr>`}</tbody></table></div></article>`;
    $('#add-device-type')?.addEventListener('click', () => typeForm());
    $$('[data-edit-device-type]').forEach((button) => button.addEventListener('click', () => typeForm(rows.find((row) => Number(row.id) === Number(button.dataset.editDeviceType)))));
    $$('[data-toggle-device-type]').forEach((button) => button.addEventListener('click', () => toggleForm(rows.find((row) => Number(row.id) === Number(button.dataset.toggleDeviceType)))));
  }

  function typeForm(item = null) {
    if (!canManage()) return;
    openDialog(item ? '编辑设备类型' : '新增设备类型', item ? '修改名称会同步设备和该类型的自定义参数，类型编码保持不变' : '类型编码用于设备编号规则，创建后保持不变',
      `<form id="device-type-form" class="form-grid">${inputField('类型名称 *', 'name', item?.name, 'text', 'required maxlength="80"')}${item ? `<label>类型编码<input value="${escapeHtml(item.code)}" disabled></label>` : inputField('类型编码 *', 'code', '', 'text', 'required minlength="2" maxlength="40" pattern="[A-Za-z][A-Za-z0-9_\\-]{1,39}" placeholder="如 PUMP、MOTOR_01"')}<p class="field-help wide">编码以英文字母开头，长度2至40位，可使用字母、数字、下划线和短横线；编码与名称均不可重复。</p>${inputField('排序', 'sort_order', item?.sort_order ?? 0, 'number', 'required min="0" max="999999" step="1"')}${item ? `<label>状态<select name="status"><option value="active" ${item.status === 'active' ? 'selected' : ''}>启用</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option></select></label>` : ''}</form>`,
      '<button class="button" data-close>取消</button><button class="button primary" id="save-device-type">保存类型</button>');
    const form = $('#device-type-form');
    const save = $('#save-device-type');
    const submit = async (event) => {
      event?.preventDefault();
      if (save.disabled || !form.reportValidity()) return;
      save.disabled = true;
      try {
        await request(item ? `/api/device-types/${item.id}` : '/api/device-types', { method: item ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(form)) });
        closeModal();
        toast('设备类型已保存');
        await refresh();
      } catch (error) {
        toast(error.message, 'error');
        save.disabled = false;
      }
    };
    save.addEventListener('click', submit);
    form.addEventListener('submit', submit);
  }

  function toggleForm(item) {
    if (!canManage() || !item) return;
    const disabling = item.status === 'active';
    openDialog(disabling ? '停用设备类型' : '启用设备类型', item.name,
      `<p>${disabling ? '停用后，新建设备将无法选择该类型。已有设备、专属参数和历史记录会保留。' : '启用后，新建设备可选择该类型，并使用已发布的专属参数。'}</p>`,
      `<button class="button" data-close>取消</button><button class="button ${disabling ? 'danger' : 'primary'}" id="confirm-device-type-status">确认${disabling ? '停用' : '启用'}</button>`);
    const save = $('#confirm-device-type-status');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await request(`/api/device-types/${item.id}`, { method: 'PUT', body: { status: disabling ? 'disabled' : 'active' } });
        closeModal();
        toast(`设备类型已${disabling ? '停用' : '启用'}`);
        await refresh();
      } catch (error) {
        toast(error.message, 'error');
        save.disabled = false;
      }
    });
  }

  return { render };
}
