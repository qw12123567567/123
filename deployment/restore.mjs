import { restoreBackup } from '../backups.mjs';
import { db } from '../db.mjs';
import '../business.mjs';

const [fileName,target]=process.argv.slice(2);
try{
  if(!fileName||!target)throw new Error('Usage: node deployment/restore.mjs BACKUP_FILENAME NEW_DATA_DIRECTORY');
  const result=await restoreBackup(fileName,target);
  if(result.integrity!=='ok')throw new Error('Restored database failed integrity check');
  console.log(JSON.stringify(result));
}finally{db.close();}
