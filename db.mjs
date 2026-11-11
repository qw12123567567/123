import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
export const paths = {
  root,
  public: path.join(root, 'public'),
  data: dataRoot,
  uploads: path.join(dataRoot, 'uploads'),
  backups: path.join(dataRoot, 'backups'),
  database: path.join(dataRoot, 'device-ledger.sqlite'),
};
await Promise.all([paths.public, paths.data, paths.uploads, paths.backups].map((value) => mkdir(value, { recursive: true })));

export const db = new DatabaseSync(paths.database);
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS departments(
 id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 parent_id INTEGER REFERENCES departments(id), manager TEXT, sort_order INTEGER DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'active', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS roles(
 id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, data_scope TEXT NOT NULL,
 view_price INTEGER DEFAULT 0, edit_price INTEGER DEFAULT 0, export_price INTEGER DEFAULT 0,
 view_sensitive INTEGER DEFAULT 0, sensitive_files INTEGER DEFAULT 0, manage_config INTEGER DEFAULT 0,
 manage_users INTEGER DEFAULT 0, manage_data INTEGER DEFAULT 0, import_data INTEGER DEFAULT 0, export_data INTEGER DEFAULT 0,
 delete_data INTEGER DEFAULT 0, view_audit INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 password_salt TEXT NOT NULL, name TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id),
 department_id INTEGER REFERENCES departments(id), status TEXT DEFAULT 'active',
 mfa_enabled INTEGER DEFAULT 0, mfa_secret TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(
 token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), csrf_token TEXT NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS devices(
 id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, asset_code TEXT, sn TEXT, name TEXT NOT NULL,
 category TEXT NOT NULL, model TEXT, brand TEXT, manufacturer TEXT, vendor TEXT,
 purchase_date TEXT, start_date TEXT, purchase_price REAL, unit_price REAL, contract_amount REAL,
 invoice_amount REAL, residual_value REAL, repair_cost REAL, department_id INTEGER REFERENCES departments(id),
 location TEXT, owner TEXT, status TEXT DEFAULT '在用', critical INTEGER DEFAULT 0,
 warranty_end TEXT, maintenance_cycle INTEGER, next_maintenance TEXT, calibration_cycle INTEGER,
 next_calibration TEXT, scrap_date TEXT, notes TEXT, custom_data TEXT DEFAULT '{}',
 version INTEGER DEFAULT 1, deleted INTEGER DEFAULT 0, created_by INTEGER REFERENCES users(id),
 updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_device_search ON devices(code,name,sn,model);
CREATE INDEX IF NOT EXISTS idx_device_scope ON devices(department_id,status,owner,updated_at);
CREATE INDEX IF NOT EXISTS idx_device_dates ON devices(warranty_end,next_maintenance,next_calibration);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS attachments(
 id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id), type TEXT NOT NULL,
 file_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, storage_name TEXT NOT NULL,
 uploaded_by INTEGER REFERENCES users(id), uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS custom_fields(
 id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, field_type TEXT NOT NULL,
 category TEXT DEFAULT '通用', required INTEGER DEFAULT 0, sensitive INTEGER DEFAULT 0,
 filterable INTEGER DEFAULT 1, exportable INTEGER DEFAULT 1, options_json TEXT DEFAULT '[]',
 validation_rule TEXT, sort_order INTEGER DEFAULT 0, status TEXT DEFAULT 'published',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS dictionary_items(
 id INTEGER PRIMARY KEY, dict_type TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
 department_id INTEGER REFERENCES departments(id), sort_order INTEGER DEFAULT 0,
 status TEXT DEFAULT 'active', UNIQUE(dict_type,code,department_id));
CREATE TABLE IF NOT EXISTS audit_logs(
 id INTEGER PRIMARY KEY, action TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT,
 summary TEXT NOT NULL, old_value TEXT, new_value TEXT, user_id INTEGER REFERENCES users(id),
 user_name TEXT, ip TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_audit ON audit_logs(created_at DESC,action);
CREATE TABLE IF NOT EXISTS config_versions(
 id INTEGER PRIMARY KEY, config_type TEXT NOT NULL, version_no INTEGER NOT NULL, content TEXT NOT NULL,
 status TEXT DEFAULT 'published', published_by INTEGER REFERENCES users(id), published_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS saved_views(
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
 scope TEXT DEFAULT 'personal', config TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

const roleColumns=db.prepare('PRAGMA table_info(roles)').all().map((column)=>column.name);
if(!roleColumns.includes('manage_data'))db.exec('ALTER TABLE roles ADD COLUMN manage_data INTEGER DEFAULT 0');
if(!db.prepare('PRAGMA table_info(attachments)').all().some((column)=>column.name==='deleted'))db.exec('ALTER TABLE attachments ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
if(!db.prepare('PRAGMA table_info(attachments)').all().some((column)=>column.name==='field_code'))db.exec('ALTER TABLE attachments ADD COLUMN field_code TEXT');

export const PRICE_FIELDS = ['purchase_price','unit_price','contract_amount','invoice_amount','residual_value','repair_cost'];
export const SENSITIVE_FILE_TYPES = new Set(['合同','发票','供应商报价']);
export const DEVICE_FIELDS = [
  'code','asset_code','sn','name','category','model','brand','manufacturer','vendor','purchase_date','start_date',
  ...PRICE_FIELDS,'department_id','location','owner','status','critical','warranty_end','maintenance_cycle',
  'next_maintenance','calibration_cycle','next_calibration','scrap_date','notes','custom_data',
];

export function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function seed() {
  const roleCount=db.prepare('SELECT COUNT(*) count FROM roles').get().count;
  const userCount=db.prepare('SELECT COUNT(*) count FROM users').get().count;
  if(roleCount&&userCount)return;
  if(roleCount&&!userCount)db.exec('DELETE FROM roles; DELETE FROM departments;');
  const dept = db.prepare('INSERT INTO departments(code,name,parent_id,manager,sort_order) VALUES(?,?,?,?,?)');
  const hq = Number(dept.run('HQ','总部',null,'林总',1).lastInsertRowid);
  const it = Number(dept.run('IT','信息技术部',hq,'陈工',2).lastInsertRowid);
  const ops = Number(dept.run('OPS','生产运营部',hq,'周经理',3).lastInsertRowid);
  const lab = Number(dept.run('LAB','质量实验室',ops,'吴主任',4).lastInsertRowid);
  const fin = Number(dept.run('FIN','财务部',hq,'赵经理',5).lastInsertRowid);

  const role = db.prepare(`INSERT INTO roles(code,name,data_scope,view_price,edit_price,export_price,
   view_sensitive,sensitive_files,manage_config,manage_users,manage_data,import_data,export_data,delete_data,view_audit)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const superRole = Number(role.run('super_admin','超级管理员','all',1,1,1,1,1,1,1,1,1,1,1,1).lastInsertRowid);
  const assetRole = Number(role.run('asset_admin','资产管理员','all',1,1,0,1,1,0,0,1,1,1,1,1).lastInsertRowid);
  const deptRole = Number(role.run('department_admin','部门管理员','department_descendants',0,0,0,0,0,1,0,1,1,1,1,1).lastInsertRowid);
  const financeRole = Number(role.run('finance','财务角色','all',1,0,1,1,1,0,0,0,0,1,0,1).lastInsertRowid);
  const staffRole = Number(role.run('staff','普通员工','self',0,0,0,0,0,0,0,0,0,0,0,0).lastInsertRowid);

  const user = db.prepare(`INSERT INTO users(username,password_hash,password_salt,name,role_id,department_id,mfa_enabled,mfa_secret)
   VALUES(?,?,?,?,?,?,?,?)`);
  const users = [
    ['admin','Admin@123','系统管理员',superRole,hq,1,'JBSWY3DPEHPK3PXP'],
    ['asset','Asset@123','资产管理员',assetRole,it,0,null],
    ['dept','Dept@123','部门管理员',deptRole,ops,0,null],
    ['finance','Finance@123','财务专员',financeRole,fin,0,null],
    ['staff','Staff@123','王工程师',staffRole,it,0,null],
  ];
  for (const [username,password,name,roleId,departmentId,mfa,secret] of users) {
    const credentials = passwordHash(password);
    user.run(username,credentials.hash,credentials.salt,name,roleId,departmentId,mfa,secret);
  }

  const dictionary = db.prepare('INSERT INTO dictionary_items(dict_type,code,name,department_id,sort_order) VALUES(?,?,?,?,?)');
  const dictionaries = {
    category:['计算机设备','网络设备','生产设备','检测仪器','办公设备'],
    status:['在用','闲置','维修','借出','报废'],
    location:['总部机房','A栋办公室','一号车间','二号车间','质量实验室'],
    vendor:['联想','戴尔','华为','海克斯康','西门子'],
    brand:['Lenovo','Dell','Huawei','Hexagon','Siemens'],
  };
  for (const [type,values] of Object.entries(dictionaries)) {
    values.forEach((name,index) => dictionary.run(type,`${type.toUpperCase()}_${index+1}`,name,null,index+1));
  }
  const field = db.prepare('INSERT INTO custom_fields(code,name,field_type,category,required,sensitive,sort_order) VALUES(?,?,?,?,?,?,?)');
  field.run('cpu','CPU','text','计算机设备',0,0,1);
  field.run('memory','内存','text','计算机设备',0,0,2);
  field.run('ip_address','IP地址','text','网络设备',0,1,3);
  field.run('accuracy','精度等级','text','检测仪器',1,0,4);
  field.run('rated_power','额定功率(kW)','number','生产设备',0,0,5);

  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  const insertDevice = db.prepare(`INSERT INTO devices(code,asset_code,sn,name,category,model,brand,manufacturer,vendor,
   purchase_date,start_date,purchase_price,unit_price,contract_amount,invoice_amount,residual_value,repair_cost,
   department_id,location,owner,status,critical,warranty_end,maintenance_cycle,next_maintenance,calibration_cycle,
   next_calibration,notes,custom_data,created_by,updated_by) VALUES(${Array(31).fill('?').join(',')})`);
  const devices = [
    ['IT-PC-2026-0001','FA-2026-001','PF3Z8K21','研发工作站01','计算机设备','ThinkStation P3','Lenovo','联想','联想','2026-01-08','2026-01-12',18500,18500,18500,18500,1800,0,it,'A栋办公室','王工程师','在用',1,'2029-01-08',180,'2027-01-12',null,null,'用于三维设计',{cpu:'i9-14900K',memory:'64GB'}],
    ['IT-NET-2026-0002','FA-2026-002','HW-S5735-01','核心交换机01','网络设备','S5735-L48T4X-A1','Huawei','华为','华为','2026-02-02','2026-02-05',23600,23600,23600,23600,2500,0,it,'总部机房','陈工','在用',1,'2029-02-02',90,'2026-12-06',null,null,'双机热备主节点',{ip_address:'10.10.0.2'}],
    ['OPS-MCH-2025-0007','FA-2025-117','SIE-82819','数控加工中心','生产设备','VMC-850','Siemens','华东机床','西门子','2025-04-16','2025-05-01',860000,860000,820000,820000,86000,12600,ops,'一号车间','刘班长','在用',1,'2027-04-16',30,'2026-11-18',null,null,'关键产线设备',{rated_power:32}],
    ['LAB-INS-2024-0021','FA-2024-221','MET-20240117','三坐标测量机','检测仪器','GLOBAL S','Hexagon','海克斯康','海克斯康','2024-06-09','2024-06-20',438000,438000,438000,438000,45000,8000,lab,'质量实验室','吴工','在用',1,'2027-06-09',90,'2026-11-14',365,'2026-11-22','年度校准即将到期',{accuracy:'1.8μm'}],
    ['OPS-MCH-2023-0012','FA-2023-088','ROB-AF201','焊接机器人A','生产设备','ARC Mate 100iD','FANUC','发那科','发那科','2023-03-11','2023-03-20',315000,315000,305000,305000,30000,23500,ops,'二号车间','孙班长','维修',1,'2026-03-11',30,'2026-11-08',null,null,'等待更换伺服电机',{rated_power:12}],
  ];
  for (const item of devices) insertDevice.run(...item.slice(0,-1),JSON.stringify(item.at(-1)),adminId,adminId);
  db.prepare(`INSERT INTO audit_logs(action,object_type,object_id,summary,user_id,user_name,ip)
   VALUES('seed','system','initial','初始化系统演示数据',?,'系统管理员','127.0.0.1')`).run(adminId);
}

function seedProduction() {
  const knownPasswords = new Map([
    ['admin','Admin@123'],['asset','Asset@123'],['dept','Dept@123'],
    ['finance','Finance@123'],['staff','Staff@123'],
  ]);
  const users = db.prepare('SELECT * FROM users').all();
  for (const user of users) {
    const knownPassword = knownPasswords.get(user.username);
    if (knownPassword && passwordHash(knownPassword,user.password_salt).hash === user.password_hash) {
      throw new Error('Production cannot start with default demo credentials. Use a new persistent data directory.');
    }
  }
  if (users.length) {
    const administrators = db.prepare("SELECT u.mfa_enabled,u.mfa_secret FROM users u JOIN roles r ON r.id=u.role_id WHERE r.code='super_admin' AND u.status='active'").all();
    if (!administrators.length || administrators.some((user)=>!user.mfa_enabled || !/^[A-Z2-7]{32}$/.test(user.mfa_secret || ''))) {
      throw new Error('An active production administrator with a private MFA secret is required.');
    }
    return;
  }
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || '';
  const secret = process.env.ADMIN_MFA_SECRET || '';
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) throw new Error('Invalid ADMIN_USERNAME.');
  if (password.length < 16 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('Set ADMIN_PASSWORD to at least 16 characters, including a letter and a number.');
  }
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error('Set ADMIN_MFA_SECRET to a private 32-character base32 secret.');
  const credentials = passwordHash(password);
  db.exec('BEGIN');
  try {
    const departmentId = Number(db.prepare('INSERT INTO departments(code,name,sort_order) VALUES(?,?,?)').run('HQ','总部',1).lastInsertRowid);
    const roleId = Number(db.prepare(`INSERT INTO roles(code,name,data_scope,manage_config,manage_users,manage_data,import_data,export_data,delete_data,view_audit)
      VALUES('super_admin','超级管理员','all',1,1,1,1,1,1,1)`).run().lastInsertRowid);
    const adminId = Number(db.prepare(`INSERT INTO users(username,password_hash,password_salt,name,role_id,department_id,mfa_enabled,mfa_secret)
      VALUES(?,?,?,?,?,?,1,?)`).run(username,credentials.hash,credentials.salt,'系统管理员',roleId,departmentId,secret).lastInsertRowid);
    const dictionary = db.prepare('INSERT INTO dictionary_items(dict_type,code,name,sort_order) VALUES(?,?,?,?)');
    const defaults = {category:['计算机设备','网络设备','生产设备','检测仪器','办公设备'],status:['在用','闲置','维修','借出','报废']};
    for (const [type,values] of Object.entries(defaults)) values.forEach((name,index)=>dictionary.run(type,`${type.toUpperCase()}_${index+1}`,name,index+1));
    db.prepare("INSERT INTO audit_logs(action,object_type,summary,user_id,user_name) VALUES('initialize','system','正式环境初始化',?,'系统管理员')").run(adminId);
    db.exec('COMMIT');
  } catch (cause) {
    db.exec('ROLLBACK');
    throw cause;
  }
}

if (process.env.APP_ENV === 'production') seedProduction();
else seed();
