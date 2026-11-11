import { getUser } from './security.mjs';

export function json(res,status,payload,headers={}) {
  const body = JSON.stringify(payload);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store',...headers});
  res.end(body);
}

export function fail(res,status,message,details) { json(res,status,{ error:message,details }); }

export async function bodyJson(req,max=12*1024*1024) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('请求内容过大'),{status:413});
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON格式错误'),{status:400}); }
}

export function requireUser(req,res) {
  const user = getUser(req);
  if (!user) { fail(res,401,'登录已失效，请重新登录'); return null; }
  if (!['GET','HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== user.csrf_token) {
    fail(res,403,'安全令牌校验失败'); return null;
  }
  return user;
}

export function xmlEscape(value) {
  return String(value ?? '').replace(/[<>&'\"]/g,(char) => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[char]));
}

export function spreadsheet(headers,rows) {
  const head=headers.map((item)=>`<Cell><Data ss:Type="String">${xmlEscape(item.label)}</Data></Cell>`).join('');
  const data=rows.map((row)=>`<Row>${headers.map((item)=>`<Cell><Data ss:Type="${item.number&&row[item.key]!==''?'Number':'String'}">${xmlEscape(row[item.key] ?? '')}</Data></Cell>`).join('')}</Row>`).join('');
  return `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="设备台账"><Table><Row>${head}</Row>${data}</Table></Worksheet></Workbook>`;
}
