import path from 'node:path';

const fileTypes={
  '.pdf':'application/pdf',
  '.doc':'application/msword',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg',
  '.txt':'text/plain',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const attachmentTypes=new Set(['说明书','合格证','验收单','图纸','照片','维修记录','合同','发票','供应商报价','其他']);
export const previewMimes=new Set(['application/pdf','image/png','image/jpeg','text/plain']);
export const MAX_ATTACHMENT_BYTES=process.env.VERCEL?50*1024*1024:8*1024*1024;
export const UPLOAD_CHUNK_BYTES=2*1024*1024;

export function validateAttachmentMetadata(body){
  const fileName=path.basename(String(body.fileName||'').replaceAll('\\','/')).replace(/[\x00-\x1f/:*?"<>|]/g,'_');
  const extension=path.extname(fileName).toLowerCase();
  const mimeType=fileTypes[extension];
  if(!mimeType||fileName.length>200)throw Object.assign(new Error('仅支持PDF、Word、PNG/JPG、Excel和TXT文件'),{status:400});
  const type=body.type||'其他';
  if(!attachmentTypes.has(type))throw Object.assign(new Error('附件分类无效'),{status:400});
  return{fileName,mimeType,type};
}

export function validateAttachment(body,{maxBytes=MAX_ATTACHMENT_BYTES}={}){
  const {fileName,mimeType,type}=validateAttachmentMetadata(body);
  const extension=path.extname(fileName).toLowerCase();
  let data;
  if(Buffer.isBuffer(body.data))data=body.data;
  else{
    const encoded=body.dataBase64;
    if(typeof encoded!=='string'||!encoded.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw Object.assign(new Error('附件内容无效'),{status:400});
    data=Buffer.from(encoded,'base64');
  }
  if(!data.length||data.length>maxBytes)throw Object.assign(new Error(`附件必须非空且不超过${Math.floor(maxBytes/1024/1024)}MB`),{status:400});
  const head=data.subarray(0,1024);
  const valid=extension==='.pdf'?head.includes(Buffer.from('%PDF-')):
    extension==='.doc'?head.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex')):
    ['.docx','.xlsx'].includes(extension)?head.subarray(0,4).equals(Buffer.from('504b0304','hex')):
    extension==='.png'?head.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):
    ['.jpg','.jpeg'].includes(extension)?head.subarray(0,3).equals(Buffer.from('ffd8ff','hex')):!head.includes(0);
  if(!valid)throw Object.assign(new Error('文件内容与扩展名不符，请选择有效文件'),{status:400});
  return{fileName,mimeType,data,type};
}
