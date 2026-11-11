import crypto from 'node:crypto';
import { db,passwordHash } from './db.mjs';
import { json,fail,bodyJson } from './http.mjs';
import { randomToken,audit } from './security.mjs';
import { configuration } from './business.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS mail_deliveries(id INTEGER PRIMARY KEY,delivery_key TEXT UNIQUE,status TEXT,detail TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);

export async function sendMail(to,subject,text){
  if(!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)throw new Error('邮件渠道尚未配置，请设置RESEND_API_KEY和MAIL_FROM');
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.MAIL_FROM,to:Array.isArray(to)?to:[to],subject,text}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`邮件发送失败（${response.status}）`);
}

const recoveryAttempts=new Map();
export async function publicAccount(req,res,url){
  if(req.method!=='POST'||!['/api/forgot-password','/api/reset-password'].includes(url.pathname))return false;
  const {clientIp}=await import('./security.mjs');const ip=clientIp(req);const previous=recoveryAttempts.get(ip)||{count:0,expires:Date.now()+900000};if(previous.expires<Date.now()){previous.count=0;previous.expires=Date.now()+900000;}previous.count++;recoveryAttempts.set(ip,previous);if(previous.count>10)return fail(res,429,'操作过于频繁，请稍后再试');
  const body=await bodyJson(req,65536);
  if(url.pathname==='/api/forgot-password'){
    if(!process.env.RESEND_API_KEY||!process.env.MAIL_FROM||!(process.env.APP_URL||process.env.RENDER_EXTERNAL_URL))return fail(res,503,'邮件找回尚未配置，请联系管理员重置密码');
    const user=db.prepare("SELECT * FROM users WHERE username=? AND status='active'").get(String(body.username||''));
    if(user?.email){const appUrl=new URL(process.env.APP_URL||process.env.RENDER_EXTERNAL_URL);if(appUrl.protocol!=='https:'&&process.env.APP_ENV==='production')return fail(res,503,'找回链接需要HTTPS站点地址');const token=randomToken();const hash=crypto.createHash('sha256').update(token).digest('hex');db.prepare('DELETE FROM password_resets WHERE user_id=?').run(user.id);db.prepare('INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash,user.id,new Date(Date.now()+1800000).toISOString());await sendMail(user.email,'设备台账密码重置',`请在30分钟内打开链接重置密码：${appUrl.origin}/#reset?token=${token}\n本次操作不会取消动态验证码。`);audit(req,user,'password_recovery','user',user.id,'申请邮件找回密码');}
    return json(res,200,{ok:true,message:'若账号已绑定邮箱，重置链接将发送到邮箱。'});
  }
  if(typeof body.token!=='string'||String(body.newPassword||'').length<12)return fail(res,400,'重置链接及至少12位新密码必填');
  const hash=crypto.createHash('sha256').update(body.token).digest('hex');const reset=db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND used=0 AND expires_at>?').get(hash,new Date().toISOString());if(!reset)return fail(res,400,'重置链接无效或已过期');const credentials=passwordHash(body.newPassword);db.exec('BEGIN');try{db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').run(credentials.hash,credentials.salt,reset.user_id);db.prepare('UPDATE password_resets SET used=1 WHERE token_hash=?').run(hash);db.prepare('DELETE FROM sessions WHERE user_id=?').run(reset.user_id);audit(req,{id:reset.user_id,name:'账号使用人'},'change_password','user',reset.user_id,'通过邮件重置密码');db.exec('COMMIT');return json(res,200,{ok:true});}catch(cause){db.exec('ROLLBACK');throw cause;}
}

export function reminderRows(user){
  const settings=configuration('reminders',user?.department_id);const days=Number(settings.days)||30;
  const parts=[];const parameters=[];const fields=[['warranty_end','保修到期'],['next_maintenance','维保到期'],['next_calibration','校准到期']];
  let scope='1=1',scopeParameters=[];
  if(user){if(user.data_scope==='self'){scope='d.owner=?';scopeParameters=[user.name];}else if(user.data_scope!=='all'){const rows=db.prepare('WITH RECURSIVE tree(id) AS(SELECT id FROM departments WHERE id=? UNION ALL SELECT p.id FROM departments p JOIN tree ON p.parent_id=tree.id) SELECT id FROM tree').all(user.department_id);scope=`d.department_id IN(${rows.map(()=>'?').join(',')||'NULL'})`;scopeParameters=rows.map((row)=>row.id);}}
  for(const [field,type] of fields){parts.push(`SELECT d.id,d.code,d.name,d.owner,p.name department_name,d.warranty_end,d.next_maintenance,d.next_calibration,'${type}' reminder_type,d.${field} due_date FROM devices d LEFT JOIN departments p ON p.id=d.department_id WHERE d.deleted=0 AND d.status<>'报废' AND ${scope} AND date(d.${field})<=date('now',?)`);parameters.push(...scopeParameters,`+${days} day`);}
  parts.push(`SELECT d.id,d.code,d.name,d.owner,p.name department_name,d.warranty_end,d.next_maintenance,d.next_calibration,'借用逾期' reminder_type,l.due_date FROM lifecycle_records l JOIN devices d ON d.id=l.device_id LEFT JOIN departments p ON p.id=d.department_id WHERE d.deleted=0 AND ${scope} AND l.record_type='借出' AND l.status='completed' AND l.due_date<date('now') AND NOT EXISTS(SELECT 1 FROM lifecycle_records r WHERE r.device_id=l.device_id AND r.record_type='归还' AND r.status='completed' AND r.id>l.id)`);parameters.push(...scopeParameters);
  const rows=db.prepare(parts.join(' UNION ALL ')+' ORDER BY due_date LIMIT 2000').all(...parameters);
  const reads=user?new Set(db.prepare('SELECT message_key FROM reminder_reads WHERE user_id=?').all(user.id).map((entry)=>entry.message_key)):new Set();
  return rows.map((row)=>{const key=`${row.id}:${row.reminder_type}:${row.due_date}`;return{...row,message_key:key,read:reads.has(key)};});
}

export async function sendReminderDigest(){
  const today=new Date().toLocaleDateString('sv-SE');
  async function deliver(scope,settings,rows){
    if(!settings.mailEnabled||!rows.length)return;const key=`reminders-${today}-${scope}`;if(db.prepare("SELECT id FROM mail_deliveries WHERE delivery_key=? AND status='sent'").get(key))return;
    const recipients=String(settings.recipients||'').split(',').map((item)=>item.trim()).filter((email)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));if(!recipients.length)return;
    try{await sendMail(recipients,`设备台账：${rows.length}项到期提醒`,rows.map((row)=>`${row.reminder_type} | ${row.code} | ${row.name} | ${row.due_date} | ${row.owner||'未指定责任人'}`).join('\n'));db.prepare("INSERT INTO mail_deliveries(delivery_key,status,detail) VALUES(?,'sent',?) ON CONFLICT(delivery_key) DO UPDATE SET status='sent',detail=excluded.detail").run(key,`${rows.length}项`);}catch(cause){db.prepare("INSERT INTO mail_deliveries(delivery_key,status,detail) VALUES(?,'failed',?) ON CONFLICT(delivery_key) DO UPDATE SET status='failed',detail=excluded.detail").run(key,cause.message);}
  }
  const global=configuration('reminders');await deliver('global',global,reminderRows());
  for(const department of db.prepare("SELECT id FROM departments WHERE status='active'").all()){
    const settings=configuration('reminders',department.id);if(JSON.stringify(settings)===JSON.stringify(global))continue;
    const deviceIds=new Set(db.prepare('SELECT id FROM devices WHERE department_id=? AND deleted=0').all(department.id).map((row)=>row.id));
    await deliver(`department-${department.id}`,settings,reminderRows({department_id:department.id,data_scope:'department_descendants'}).filter((row)=>deviceIds.has(row.id)));
  }
}
