import { randomBytes } from 'node:crypto';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let bits='';for(const byte of randomBytes(20))bits+=byte.toString(2).padStart(8,'0');
let secret='';for(let index=0;index<bits.length;index+=5)secret+=alphabet[parseInt(bits.slice(index,index+5),2)];
console.log(JSON.stringify({ADMIN_PASSWORD:`Ledger-${randomBytes(24).toString('base64url')}9a`,ADMIN_MFA_SECRET:secret},null,2));
