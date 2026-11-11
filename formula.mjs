export function formulaDependencies(expression){
  return[...String(expression||'').matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((match)=>match[1]);
}

export function calculateFormula(expression,values){
  if(typeof expression!=='string'||expression.length>240)throw new Error('公式最多240字符');
  const substituted=expression.replace(/\{([a-z][a-z0-9_]*)\}/g,(_,key)=>{const value=Number(values[key]??0);if(!Number.isFinite(value))throw new Error(`公式引用的${key}不是数字`);return `(${value})`;});
  const tokens=substituted.match(/(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?|[()+*/-]/g)||[];
  if(tokens.join('')!==substituted.replace(/\s/g,'')||tokens.length>160)throw new Error('公式仅支持字段引用、数字、括号和加减乘除');
  let index=0;
  function atom(){const token=tokens[index++];if(token==='+'||token==='-'){const value=atom();return token==='-'?-value:value;}if(token==='('){const value=sum();if(tokens[index++]!==')')throw new Error('公式括号不匹配');return value;}if(token==null||!Number.isFinite(Number(token)))throw new Error('公式格式无效');return Number(token);}
  function product(){let value=atom();while(tokens[index]==='*'||tokens[index]==='/'){const operation=tokens[index++];const next=atom();if(operation==='/'&&next===0)throw new Error('公式除数为零');value=operation==='*'?value*next:value/next;}return value;}
  function sum(){let value=product();while(tokens[index]==='+'||tokens[index]==='-'){const operation=tokens[index++];const next=product();value=operation==='+'?value+next:value-next;}return value;}
  const result=sum();if(index!==tokens.length||!Number.isFinite(result))throw new Error('公式计算结果无效');return Math.round(result*1e8)/1e8;
}
