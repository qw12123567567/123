import { db } from './db.mjs';
import { audit, scopeClause } from './security.mjs';
import { bodyJson, fail, json } from './http.mjs';

const codePattern = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;
const fold = (value) => String(value ?? '').trim().normalize('NFC').toLowerCase();
const invalid = (status, message) => Object.assign(new Error(message), { status });
const canManage = (user) => user?.role_code === 'super_admin' && !!user.manage_config;

function values(body, old) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid(400, '设备类型数据格式错误');
  const name = typeof (body.name ?? old?.name) === 'string' ? (body.name ?? old.name).trim().normalize('NFC') : '';
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw invalid(400, '设备类型名称需为1至80个字符，且不能包含控制字符');
  if (name === '通用' && name !== old?.name) throw invalid(400, '“通用”用于所有设备的公共参数，请使用其他类型名称');
  const code = old?.code ?? (typeof body.code === 'string' ? body.code.trim() : '');
  if (!old && !codePattern.test(code)) throw invalid(400, '类型编码需以英文字母开头，长度2至40位，可包含字母、数字、下划线和短横线');
  const rawOrder = body.sort_order ?? old?.sort_order ?? 0;
  if ((typeof rawOrder !== 'number' && typeof rawOrder !== 'string') || String(rawOrder).trim() === '') throw invalid(400, '排序需为0至999999的整数');
  const sortOrder = Number(rawOrder);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 999999) throw invalid(400, '排序需为0至999999的整数');
  const status = body.status ?? old?.status ?? 'active';
  if (!['active', 'disabled'].includes(status)) throw invalid(400, '设备类型状态无效');
  return { code, name, sort_order: sortOrder, status };
}

function renamedJson(content, oldName, nextName, isSnapshot, source = '自定义参数草稿或历史版本') {
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw invalid(409, `${source}无法读取，请先修复配置后重命名`); }
  if (isSnapshot ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid(409, `${source}格式异常，请先修复配置后重命名`);
  }
  const fields = isSnapshot ? parsed : [parsed];
  let changed = false;
  for (const field of fields) {
    if (field && typeof field === 'object' && field.category === oldName) {
      field.category = nextName;
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : null;
}

function renameReferences(req, oldName, nextName, user) {
  const drafts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='field_drafts'").get()
    ? db.prepare('SELECT field_id,content FROM field_drafts').all()
    : [];
  // Prepare every JSON change before touching rows, so malformed history cannot be silently lost.
  const draftUpdates = drafts.map((row) => ({ ...row, next: renamedJson(row.content, oldName, nextName, false) })).filter((row) => row.next !== null);
  const snapshots = db.prepare("SELECT id,content FROM config_versions WHERE config_type='custom_fields'").all();
  const snapshotUpdates = snapshots.map((row) => ({ ...row, next: renamedJson(row.content, oldName, nextName, true) })).filter((row) => row.next !== null);
  const views = db.prepare('SELECT id,config FROM saved_views').all();
  const viewUpdates = views.map((row) => ({ ...row, next: renamedJson(row.config, oldName, nextName, false, '保存的筛选视图') })).filter((row) => row.next !== null);
  for (const device of db.prepare('SELECT id,code,version FROM devices WHERE category=?').all(oldName)) {
    audit(req, user, 'update', 'device', device.id, `设备类型更名：${device.code}，${oldName} → ${nextName}`,
      { category: oldName, version: device.version }, { category: nextName, version: Number(device.version) + 1 });
  }
  const result = db.prepare('UPDATE devices SET category=?,version=version+1,updated_by=?,updated_at=? WHERE category=?')
    .run(nextName, user.id, new Date().toISOString(), oldName);
  db.prepare('UPDATE custom_fields SET category=? WHERE category=?').run(nextName, oldName);
  for (const row of draftUpdates) db.prepare('UPDATE field_drafts SET content=? WHERE field_id=?').run(row.next, row.field_id);
  for (const row of snapshotUpdates) db.prepare('UPDATE config_versions SET content=? WHERE id=?').run(row.next, row.id);
  for (const row of viewUpdates) db.prepare('UPDATE saved_views SET config=? WHERE id=?').run(row.next, row.id);
  return Number(result.changes);
}

// Also used by the legacy category dictionary endpoint so both entry points share validation and migrations.
export function saveDeviceType(req, user, body, id = null) {
  if (!canManage(user)) throw invalid(403, '只有平台管理员可维护全局设备类型');
  const updating = id !== null;
  if (updating && (!Number.isSafeInteger(Number(id)) || Number(id) < 1)) throw invalid(400, '设备类型编号无效');
  db.exec('BEGIN IMMEDIATE');
  try {
    const old = updating ? db.prepare("SELECT * FROM dictionary_items WHERE id=? AND dict_type='category'").get(Number(id)) : null;
    if (updating && !old) throw invalid(404, '设备类型不存在');
    const next = values(body, old);
    const rows = db.prepare("SELECT id,code,name FROM dictionary_items WHERE dict_type='category'").all();
    if (!old && rows.some((row) => fold(row.code) === fold(next.code))) throw invalid(409, '类型编码已存在（不区分大小写）');
    if (rows.some((row) => row.id !== old?.id && fold(row.name) === fold(next.name))) throw invalid(409, '类型名称已存在（不区分大小写）');
    const renaming = old && old.name !== next.name;
    if (renaming && rows.some((row) => row.id !== old.id && fold(row.name) === fold(old.name))) {
      throw invalid(409, '原类型名称对应多个历史字典项，无法安全同步重命名，请先整理重复类型');
    }
    let renamedDevices = 0;
    let savedId;
    if (old) {
      if (renaming) renamedDevices = renameReferences(req, old.name, next.name, user);
      db.prepare('UPDATE dictionary_items SET name=?,sort_order=?,status=? WHERE id=?').run(next.name, next.sort_order, next.status, old.id);
      savedId = Number(old.id);
    } else {
      const result = db.prepare("INSERT INTO dictionary_items(dict_type,code,name,department_id,sort_order,status) VALUES('category',?,?,NULL,?,?)")
        .run(next.code, next.name, next.sort_order, next.status);
      savedId = Number(result.lastInsertRowid);
    }
    audit(req, user, old ? 'update' : 'create', 'device_type', savedId,
      old ? `修改设备类型：${old.name}${renaming ? ` → ${next.name}，同步${renamedDevices}台设备` : ''}` : `新增设备类型：${next.name}`,
      old, { ...next, renamed_devices: renamedDevices });
    db.exec('COMMIT');
    return { ok: true, id: savedId, renamed_devices: renamedDevices };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createDeviceType(req, user, body) {
  return saveDeviceType(req, user, body);
}

export function updateDeviceType(req, user, id, body) {
  return saveDeviceType(req, user, body, id);
}

export async function deviceTypes(req, res, url, user) {
  const match = url.pathname.match(/^\/api\/device-types\/(\d+)$/);
  if (url.pathname !== '/api/device-types' && !match) return false;
  if (!user) return fail(res, 401, '请先登录');
  if (url.pathname === '/api/device-types' && req.method === 'GET') {
    const scope = scopeClause(user, 'd');
    const rows = db.prepare(`SELECT t.id,t.code,t.name,t.sort_order,t.status,
      (SELECT COUNT(*) FROM devices d WHERE d.category=t.name AND d.deleted=0 AND ${scope.sql}) device_count,
      (SELECT COUNT(*) FROM custom_fields f WHERE f.category=t.name AND f.status<>'disabled') field_count
      FROM dictionary_items t WHERE t.dict_type='category' ORDER BY t.sort_order,t.id`).all(...scope.params);
    return json(res, 200, { rows });
  }
  if ((url.pathname === '/api/device-types' && req.method === 'POST') || (match && req.method === 'PUT')) {
    if (!canManage(user)) return fail(res, 403, '只有平台管理员可维护全局设备类型');
    try {
      const result = saveDeviceType(req, user, await bodyJson(req), match ? Number(match[1]) : null);
      return json(res, match ? 200 : 201, result);
    } catch (error) {
      if (error.status) return fail(res, error.status, error.message);
      throw error;
    }
  }
  return fail(res, 405, '该设备类型操作不受支持');
}
