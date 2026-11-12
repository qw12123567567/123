import path from 'node:path';
import { mkdir,cp,readdir,stat,rm,copyFile,readFile,writeFile } from 'node:fs/promises';
import { randomBytes,createCipheriv,createDecipheriv } from 'node:crypto';
import { backup,DatabaseSync } from 'node:sqlite';
import { db,paths,cloudDatabase } from './db.mjs';
import { writeStored,readStored,listStored,removeStored } from './storage.mjs';

async function cloudSnapshot(target){
  // Rebuild a native SQLite snapshot while the remote read transaction keeps
  // schema and rows at one consistent point in time. Include private files.
  const snapshot=new DatabaseSync(target);
  db.exec('BEGIN');
  try{
    const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN ('cloud_files','cloud_file_chunks') ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").all();
    snapshot.exec('BEGIN');snapshot.exec('PRAGMA defer_foreign_keys=ON');
    const tables=objects.filter(row=>row.type==='table');
    for(const object of tables)snapshot.exec(object.sql);
    for(const object of tables){
      const table='"'+object.name.replaceAll('"','""')+'"';
      const rows=db.prepare(`SELECT * FROM ${table}`).all();
      const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);
      const insert=snapshot.prepare(`INSERT INTO ${table}(${columns.map(name=>'"'+name.replaceAll('"','""')+'"').join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
      for(const row of rows)insert.run(...columns.map(name=>row[name]));
    }
    const sequences=db.prepare('SELECT name,seq FROM sqlite_sequence').all();
    for(const row of sequences)snapshot.prepare('INSERT OR REPLACE INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq);
    for(const object of objects.filter(row=>row.type!=='table'))snapshot.exec(object.sql);
    snapshot.exec('COMMIT');
    const uploads=[];
    for(const file of await listStored('uploads'))uploads.push({name:file.name,data:(await readStored('uploads',file.name)).toString('base64')});
    db.exec('COMMIT');return uploads;
  }catch(error){db.exec('ROLLBACK');throw error;}finally{snapshot.close();}
}
async function createCloudBackup(){
  const fileName=`device-ledger-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite.enc`;
  const temporary=path.join(paths.backups,fileName+'.snapshot');
  try{
    const key=await backupKey();const uploads=await cloudSnapshot(temporary);
    const contents=Buffer.from(JSON.stringify({format:'DLBK-CLOUD-1',database:(await readFile(temporary)).toString('base64'),uploads}));
    const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);
    const encrypted=Buffer.concat([cipher.update(contents),cipher.final()]);
    await writeStored('backups',fileName,Buffer.concat([Buffer.from('DLBC1'),iv,cipher.getAuthTag(),encrypted]));
    return fileName;
  }finally{await rm(temporary,{force:true});}
}

export async function createBackup(){
  if(cloudDatabase)return createCloudBackup();
  const stamp=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().replace(/[:.]/g,'-');
  const fileName=`device-ledger-${stamp}.sqlite.enc`;const temporary=path.join(paths.backups,`${fileName}.snapshot`);
  const key=await backupKey();await backup(db,temporary);
  try{
    const check=new DatabaseSync(temporary,{readOnly:true});
    try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('备份完整性检查失败');}finally{check.close();}
    await encryptFile(temporary,path.join(paths.backups,fileName),key);
    const uploadTarget=path.join(paths.backups,fileName+'.uploads');await mkdir(uploadTarget,{recursive:true});
    for(const entry of await readdir(paths.uploads,{withFileTypes:true}))if(entry.isFile())await encryptFile(path.join(paths.uploads,entry.name),path.join(uploadTarget,entry.name+'.enc'),key);
    return fileName;
  }finally{await rm(temporary,{force:true});}
}

async function backupKey(create=true){
  if(process.env.BACKUP_ENCRYPTION_KEY){if(!/^[a-f0-9]{64}$/i.test(process.env.BACKUP_ENCRYPTION_KEY))throw new Error('BACKUP_ENCRYPTION_KEY需为64位十六进制密钥');return Buffer.from(process.env.BACKUP_ENCRYPTION_KEY,'hex');}
  if(cloudDatabase){
    db.exec('CREATE TABLE IF NOT EXISTS cloud_private_config(name TEXT PRIMARY KEY,value TEXT NOT NULL)');
    if(create)db.prepare('INSERT OR IGNORE INTO cloud_private_config(name,value) VALUES(?,?)').run('backup-key',randomBytes(32).toString('hex'));
    const row=db.prepare('SELECT value FROM cloud_private_config WHERE name=?').get('backup-key');
    if(!row)throw new Error('云端备份密钥不存在');return Buffer.from(row.value,'hex');
  }
  const file=path.join(paths.data,'.backup-key');
  try{return Buffer.from((await readFile(file,'utf8')).trim(),'hex');}catch(cause){if(cause.code!=='ENOENT')throw cause;if(!create)throw new Error('缺少备份解密密钥，请恢复原data/.backup-key或配置BACKUP_ENCRYPTION_KEY');const key=randomBytes(32);try{await writeFile(file,key.toString('hex'),{flag:'wx',mode:0o600});return key;}catch(error){if(error.code==='EEXIST')return Buffer.from((await readFile(file,'utf8')).trim(),'hex');throw error;}}
}

async function encryptFile(source,target,key){const data=await readFile(source);const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);const encrypted=Buffer.concat([cipher.update(data),cipher.final()]);await writeFile(target,Buffer.concat([Buffer.from('DLBK1'),iv,cipher.getAuthTag(),encrypted]),{mode:0o600});}
async function decryptFile(source,target,key){const data=await readFile(source);if(data.length<33||data.subarray(0,5).toString()!=='DLBK1')throw new Error('备份格式无效');const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(5,17));decipher.setAuthTag(data.subarray(17,33));await writeFile(target,Buffer.concat([decipher.update(data.subarray(33)),decipher.final()]),{mode:0o600});}

export async function listBackups(){
  if(cloudDatabase)return(await listStored('backups')).map(row=>({fileName:row.name,size:row.size,createdAt:row.created_at,attachmentsIncluded:true,encrypted:true}));
  const names=await readdir(paths.backups);const rows=[];
  for(const name of names.filter((name)=>name.endsWith('.sqlite')||name.endsWith('.sqlite.enc'))){const detail=await stat(path.join(paths.backups,name));const attachmentsIncluded=await stat(path.join(paths.backups,name+'.uploads')).then((entry)=>entry.isDirectory()).catch(()=>false);rows.push({fileName:name,size:detail.size,createdAt:detail.mtime.toISOString(),attachmentsIncluded,encrypted:name.endsWith('.enc')});}
  return rows.sort((left,right)=>right.createdAt.localeCompare(left.createdAt));
}

export async function pruneBackups(){
  const cutoff=Date.now()-30*86400000;
  if(cloudDatabase){for(const row of await listBackups())if(new Date(row.createdAt).getTime()<cutoff)await removeStored('backups',row.fileName);return;}
  for(const row of await listBackups())if(new Date(row.createdAt).getTime()<cutoff){await rm(path.join(paths.backups,row.fileName),{force:true});await rm(path.join(paths.backups,row.fileName+'.uploads'),{recursive:true,force:true});}
}

export async function restoreBackup(fileName,targetDirectory){
  if(!/^device-ledger-[A-Za-z0-9T-]+\.sqlite(?:\.enc)?$/.test(fileName))throw new Error('备份文件名无效');
  const source=path.join(paths.backups,fileName);const target=path.resolve(targetDirectory);
  if(target===paths.data)throw new Error('请先恢复到新的目录，验收后再切换数据目录');
  await mkdir(target,{recursive:true});
  await mkdir(path.join(target,'uploads'),{recursive:true});
  if(cloudDatabase){
    const bytes=await readStored('backups',fileName);if(bytes.subarray(0,5).toString()!=='DLBC1')throw new Error('云端备份格式无效');
    const decipher=createDecipheriv('aes-256-gcm',await backupKey(false),bytes.subarray(5,17));decipher.setAuthTag(bytes.subarray(17,33));
    const contents=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(33)),decipher.final()]).toString('utf8'));
    if(contents.format!=='DLBK-CLOUD-1')throw new Error('备份格式无效');
    await writeFile(path.join(target,'device-ledger.sqlite'),Buffer.from(contents.database,'base64'));
    for(const file of contents.uploads){if(path.basename(file.name)!==file.name)throw new Error('备份附件名无效');await writeFile(path.join(target,'uploads',file.name),Buffer.from(file.data,'base64'));}
  }else if(fileName.endsWith('.enc')){
    const key=await backupKey(false);await decryptFile(source,path.join(target,'device-ledger.sqlite'),key);
    for(const entry of await readdir(source+'.uploads',{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.enc'))await decryptFile(path.join(source+'.uploads',entry.name),path.join(target,'uploads',entry.name.slice(0,-4)),key);
  }else{
    await copyFile(source,path.join(target,'device-ledger.sqlite'));
    await cp(source+'.uploads',path.join(target,'uploads'),{recursive:true});
  }
  const check=new DatabaseSync(path.join(target,'device-ledger.sqlite'),{readOnly:true});
  try{return{integrity:check.prepare('PRAGMA integrity_check').get().integrity_check,devices:check.prepare('SELECT COUNT(*) count FROM devices WHERE deleted=0').get().count,attachments:check.prepare('SELECT COUNT(*) count FROM attachments').get().count};}finally{check.close();}
}
