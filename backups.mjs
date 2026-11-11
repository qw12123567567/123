import path from 'node:path';
import { mkdir,cp,readdir,stat,rm,copyFile,readFile,writeFile } from 'node:fs/promises';
import { randomBytes,createCipheriv,createDecipheriv } from 'node:crypto';
import { backup,DatabaseSync } from 'node:sqlite';
import { db,paths } from './db.mjs';

export async function createBackup(){
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
  const file=path.join(paths.data,'.backup-key');
  try{return Buffer.from((await readFile(file,'utf8')).trim(),'hex');}catch(cause){if(cause.code!=='ENOENT')throw cause;if(!create)throw new Error('缺少备份解密密钥，请恢复原data/.backup-key或配置BACKUP_ENCRYPTION_KEY');const key=randomBytes(32);try{await writeFile(file,key.toString('hex'),{flag:'wx',mode:0o600});return key;}catch(error){if(error.code==='EEXIST')return Buffer.from((await readFile(file,'utf8')).trim(),'hex');throw error;}}
}

async function encryptFile(source,target,key){const data=await readFile(source);const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);const encrypted=Buffer.concat([cipher.update(data),cipher.final()]);await writeFile(target,Buffer.concat([Buffer.from('DLBK1'),iv,cipher.getAuthTag(),encrypted]),{mode:0o600});}
async function decryptFile(source,target,key){const data=await readFile(source);if(data.length<33||data.subarray(0,5).toString()!=='DLBK1')throw new Error('备份格式无效');const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(5,17));decipher.setAuthTag(data.subarray(17,33));await writeFile(target,Buffer.concat([decipher.update(data.subarray(33)),decipher.final()]),{mode:0o600});}

export async function listBackups(){
  const names=await readdir(paths.backups);const rows=[];
  for(const name of names.filter((name)=>name.endsWith('.sqlite')||name.endsWith('.sqlite.enc'))){const detail=await stat(path.join(paths.backups,name));const attachmentsIncluded=await stat(path.join(paths.backups,name+'.uploads')).then((entry)=>entry.isDirectory()).catch(()=>false);rows.push({fileName:name,size:detail.size,createdAt:detail.mtime.toISOString(),attachmentsIncluded,encrypted:name.endsWith('.enc')});}
  return rows.sort((left,right)=>right.createdAt.localeCompare(left.createdAt));
}

export async function pruneBackups(){
  const cutoff=Date.now()-30*86400000;
  for(const row of await listBackups())if(new Date(row.createdAt).getTime()<cutoff){await rm(path.join(paths.backups,row.fileName),{force:true});await rm(path.join(paths.backups,row.fileName+'.uploads'),{recursive:true,force:true});}
}

export async function restoreBackup(fileName,targetDirectory){
  if(!/^device-ledger-[A-Za-z0-9T-]+\.sqlite(?:\.enc)?$/.test(fileName))throw new Error('备份文件名无效');
  const source=path.join(paths.backups,fileName);const target=path.resolve(targetDirectory);
  if(target===paths.data)throw new Error('请先恢复到新的目录，验收后再切换数据目录');
  await mkdir(target,{recursive:true});
  await mkdir(path.join(target,'uploads'),{recursive:true});
  if(fileName.endsWith('.enc')){
    const key=await backupKey(false);await decryptFile(source,path.join(target,'device-ledger.sqlite'),key);
    for(const entry of await readdir(source+'.uploads',{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.enc'))await decryptFile(path.join(source+'.uploads',entry.name),path.join(target,'uploads',entry.name.slice(0,-4)),key);
  }else{
    await copyFile(source,path.join(target,'device-ledger.sqlite'));
    await cp(source+'.uploads',path.join(target,'uploads'),{recursive:true});
  }
  const check=new DatabaseSync(path.join(target,'device-ledger.sqlite'),{readOnly:true});
  try{return{integrity:check.prepare('PRAGMA integrity_check').get().integrity_check,devices:check.prepare('SELECT COUNT(*) count FROM devices WHERE deleted=0').get().count,attachments:check.prepare('SELECT COUNT(*) count FROM attachments').get().count};}finally{check.close();}
}
