import path from 'node:path';
import { readFile, writeFile, unlink, stat, readdir } from 'node:fs/promises';
import { db, paths, cloudDatabase } from './db.mjs';

// Cloud data is authoritative in Turso. /tmp is used only for restore checks.
if (cloudDatabase) db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_files(namespace TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(namespace,name));
  CREATE TABLE IF NOT EXISTS cloud_file_chunks(namespace TEXT NOT NULL,name TEXT NOT NULL,part INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(namespace,name,part),FOREIGN KEY(namespace,name) REFERENCES cloud_files(namespace,name) ON DELETE CASCADE);
`);
const directory = namespace => namespace === 'uploads' ? paths.uploads : namespace === 'backups' ? paths.backups : path.join(paths.data,'exports');
export async function writeStored(namespace,name,data) {
  if (!cloudDatabase) return writeFile(path.join(directory(namespace),name),data,{flag:'wx'});
  const bytes=Buffer.from(data);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO cloud_files(namespace,name,size,created_at) VALUES(?,?,?,?)').run(namespace,name,bytes.length,new Date().toISOString());
    const insert=db.prepare('INSERT INTO cloud_file_chunks(namespace,name,part,data) VALUES(?,?,?,?)');
    for(let offset=0,part=0;offset<bytes.length;offset+=512*1024,part++) insert.run(namespace,name,part,bytes.subarray(offset,offset+512*1024));
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}
export async function readStored(namespace,name) {
  if (!cloudDatabase) return readFile(path.join(directory(namespace),name));
  const file=db.prepare('SELECT size FROM cloud_files WHERE namespace=? AND name=?').get(namespace,name);
  if(!file) throw Object.assign(new Error('文件不存在'),{code:'ENOENT',status:404});
  const data=Buffer.concat(db.prepare('SELECT data FROM cloud_file_chunks WHERE namespace=? AND name=? ORDER BY part').all(namespace,name).map(row=>Buffer.from(row.data)));
  if(data.length!==file.size) throw new Error('云端文件完整性校验失败');
  return data;
}
export async function removeStored(namespace,name) {
  if (!cloudDatabase) return unlink(path.join(directory(namespace),name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  db.prepare('DELETE FROM cloud_files WHERE namespace=? AND name=?').run(namespace,name);
}
export async function listStored(namespace) {
  if (cloudDatabase) return db.prepare('SELECT name,size,created_at FROM cloud_files WHERE namespace=? ORDER BY created_at DESC').all(namespace);
  const rows=[];
  for(const name of await readdir(directory(namespace))) {
    const info=await stat(path.join(directory(namespace),name));
    if(info.isFile()) rows.push({name,size:info.size,created_at:info.mtime.toISOString()});
  }
  return rows;
}
