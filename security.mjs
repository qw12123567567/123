import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { db, PRICE_FIELDS } from './db.mjs';
import { calculateFormula,formulaDependencies } from './formula.mjs';

export function verifyPassword(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 64);
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of value.replace(/=+$/g, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index >= 0) bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index,index+8),2));
  return Buffer.from(bytes);
}

export function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const digest = crypto.createHmac('sha1',base32Decode(secret)).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6,'0');
}

export function verifyTotp(secret, code) {
  return !!code && [-30000,0,30000].some((offset) => totp(secret,Date.now()+offset) === String(code));
}

export function parseCookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0,index).trim()] = decodeURIComponent(part.slice(index+1));
  }
  return result;
}

export function getUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const user = db.prepare(`SELECT u.*,r.code role_code,r.name role_name,r.data_scope,
    r.view_price,r.edit_price,r.export_price,r.view_sensitive,r.sensitive_files,r.manage_config,
    r.manage_users,r.manage_data,r.import_data,r.export_data,r.delete_data,r.view_audit,
    d.name department_name,s.csrf_token,s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN roles r ON r.id=u.role_id
    LEFT JOIN departments d ON d.id=u.department_id WHERE s.token=?`).get(token);
  if (!user || user.status !== 'active' || new Date(user.expires_at) <= new Date()) {
    db.prepare('DELETE FROM sessions WHERE token=?').run(token);
    return null;
  }
  return user;
}

export function publicUser(user) {
  return {
    id:user.id, username:user.username, name:user.name,
    role:{ id:user.role_id, code:user.role_code, name:user.role_name, dataScope:user.data_scope },
    department:{ id:user.department_id, name:user.department_name },
    permissions:{
      viewPrice:!!user.view_price, editPrice:!!user.edit_price, exportPrice:!!user.export_price,
      viewSensitive:!!user.view_sensitive, sensitiveFiles:!!user.sensitive_files,
      manageConfig:!!user.manage_config, manageUsers:!!user.manage_users,
      manageData:!!user.manage_data,
      importData:!!user.import_data, exportData:!!user.export_data,
      deleteData:!!user.delete_data, viewAudit:!!user.view_audit,
    },
    csrfToken:user.csrf_token,
    fieldPermissions:Object.fromEntries(db.prepare("SELECT * FROM custom_fields WHERE status='published'").all().map((field)=>[field.code,{view:fieldPermission(user,field,'view'),edit:fieldPermission(user,field,'edit'),export:fieldPermission(user,field,'export')} ])),
  };
}

export function descendants(departmentId) {
  if (!departmentId) return [];
  return db.prepare(`WITH RECURSIVE tree(id) AS (
    SELECT id FROM departments WHERE id=? UNION ALL
    SELECT d.id FROM departments d JOIN tree t ON d.parent_id=t.id)
    SELECT id FROM tree`).all(departmentId).map((row) => row.id);
}

export function scopeClause(user, alias = 'd') {
  if (user.data_scope === 'all') return { sql:'1=1', params:[] };
  if (user.data_scope === 'department_descendants') {
    const ids = descendants(user.department_id);
    return ids.length ? { sql:`${alias}.department_id IN (${ids.map(() => '?').join(',')})`, params:ids } : { sql:'1=0',params:[] };
  }
  return { sql:`${alias}.owner=?`, params:[user.name] };
}

export function canAccessDepartment(user, departmentId) {
  if (user.data_scope === 'all') return true;
  if (user.data_scope === 'department_descendants') return descendants(user.department_id).includes(Number(departmentId));
  return Number(departmentId) === Number(user.department_id);
}

export function safeJson(value, fallback = {}) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

export function maskDevice(row, user) {
  const original=safeJson(row.custom_data,{});const custom={};
  for(const field of db.prepare("SELECT * FROM custom_fields WHERE status='published'").all()){
    if(field.field_type==='formula'){
      if(!fieldPermission(user,field,'view')){custom[field.code]='***';continue;}
      try{custom[field.code]=calculateFormula((field.validation_rule||'').slice(8),{...original,...row});}catch{custom[field.code]=null;}
    }else if(Object.hasOwn(original,field.code))custom[field.code]=fieldPermission(user,field,'view')?original[field.code]:'***';
  }
  const output = { ...row, critical:!!row.critical, custom_data:custom };
  if (!user.view_price) {
    PRICE_FIELDS.forEach((field) => delete output[field]);
    output.price_masked = true;
  }
  return output;
}

export function audit(req,user,action,objectType,objectId,summary,oldValue=null,newValue=null) {
  const ip = clientIp(req);
  db.prepare(`INSERT INTO audit_logs(action,object_type,object_id,summary,old_value,new_value,user_id,user_name,ip)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(action,objectType,String(objectId ?? ''),summary,
      oldValue == null ? null : JSON.stringify(oldValue), newValue == null ? null : JSON.stringify(newValue),
      user?.id ?? null,user?.name ?? '匿名',ip);
}

export function randomToken(bytes=32) { return crypto.randomBytes(bytes).toString('hex'); }

export function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  if (process.env.TRUST_PROXY !== '1') return remote;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
  return isIP(forwarded) ? forwarded : remote;
}

export function sessionCookie(token,maxAge=28800) {
  const secure = process.env.APP_ENV === 'production' ? '; Secure' : '';
  return `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export function fieldPermission(user,field,operation='view'){
  if(field.field_type==='formula'){
    if(operation==='edit')return false;
    for(const reference of formulaDependencies(field.validation_rule?.slice(8))){
      if(PRICE_FIELDS.includes(reference)){if(!user.view_price||operation==='export'&&!user.export_price)return false;}
      else{const dependency=db.prepare('SELECT * FROM custom_fields WHERE code=?').get(reference);if(!dependency||dependency.field_type==='formula'||!fieldPermission(user,dependency,operation))return false;}
    }
  }
  const permission=db.prepare('SELECT * FROM field_permissions WHERE role_id=? AND field_code=?').get(user.role_id,field.code);
  const allowed=permission?!!permission[`can_${operation}`]:!field.sensitive||!!user.view_sensitive;
  if(operation==='edit')return allowed&&!!user.manage_data;
  if(operation==='export')return allowed&&!!user.export_data&&!!field.exportable;
  return allowed;
}
