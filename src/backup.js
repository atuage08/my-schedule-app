import {parseState,serializeState,rollTasks,dateKey,newId} from './model.js';

export const MAX_FILE_BYTES=8*1024*1024;
export class BackupError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
const fail=(code,message)=>{throw new BackupError(code,message);};
export function freeze(value){
  if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
}
function depthCheck(text){
  let depth=0,string=false,escape=false;
  for(const char of text){
    if(string){if(escape)escape=false;else if(char==='\\')escape=true;else if(char==='"')string=false;}
    else if(char==='"')string=true;
    else if(char==='{'||char==='['){if(++depth>8)fail('structure','JSONの入れ子が深すぎます');}
    else if(char==='}'||char===']')depth--;
  }
}
function structure(value){
  const pending=[value];let count=0;
  while(pending.length){
    const current=pending.pop();if(++count>500000)fail('structure','JSONの構造が大きすぎます');
    if(current&&typeof current==='object'){
      const keys=Object.keys(current);
      if((Array.isArray(current)&&current.length>10000)||(!Array.isArray(current)&&keys.length>32))fail('structure','JSONの構造が大きすぎます');
      for(const key of keys){if(['__proto__','constructor','prototype'].includes(key))fail('structure','未対応のJSON項目です');pending.push(current[key]);}
    }
  }
}
export function checkedData(data){
  try{return parseState(serializeState(data));}catch{fail('data','データ形式・件数・日時・関連情報・保存容量を確認してください');}
}
export function canonicalData(data){
  const clean=checkedData(data);
  function ordered(value){
    if(Array.isArray(value))return value.map(ordered);
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])]));
    return value;
  }
  return JSON.stringify(ordered(clean));
}
export async function dataDigest(data){
  const bytes=new TextEncoder().encode(canonicalData(data));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function decodeBackup(input){
  let bytes;
  try{bytes=input instanceof Uint8Array?input:new Uint8Array(input);}catch{fail('file','ファイルを読み込めません');}
  if(!bytes.byteLength||bytes.byteLength>MAX_FILE_BYTES)fail('size','ファイルは空でない8MiB以下のJSONを選んでください');
  if(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf)bytes=bytes.subarray(3);
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('encoding','不正なUTF-8ファイルです');}
  if(text.startsWith('\ufeff'))fail('encoding','BOMが重複しています');
  depthCheck(text);
  let envelope;
  try{envelope=JSON.parse(text);}catch{fail('json','JSONが破損しているか形式が異なります');}
  structure(envelope);
  if(!envelope||Array.isArray(envelope)||Object.keys(envelope).sort().join(',')!=='data,exportedAt,format,formatVersion'||envelope.format!=='my-schedule-backup'||envelope.formatVersion!==1)fail('format','未対応のバックアップ形式・バージョンです');
  const at=envelope.exportedAt;
  if(typeof at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)||!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at)fail('format','作成日時の形式が不正です');
  return freeze({exportedAt:at,data:checkedData(envelope.data)});
}
export async function readBackupFile(file){
  if(!file||!Number.isSafeInteger(file.size)||!file.size||file.size>MAX_FILE_BYTES)fail('size','ファイルは空でない8MiB以下のJSONを選んでください');
  let bytes;try{bytes=await file.arrayBuffer();}catch{fail('file','ファイルを読み込めません');}
  if(bytes.byteLength!==file.size)fail('file','ファイルの読み込みサイズが一致しません');
  return decodeBackup(bytes);
}
export async function createBackup(data,now=new Date()){
  const exportedAt=now.toISOString(),clean=checkedData(data);
  const bytes=new TextEncoder().encode(JSON.stringify({format:'my-schedule-backup',formatVersion:1,exportedAt,data:clean}));
  const decoded=decodeBackup(bytes); // Exports must pass the exact import conditions.
  const name='my-schedule-'+exportedAt.replace(/[:.]/g,'-')+'.json';
  return Object.freeze({id:newId(),file:new File([bytes],name,{type:'application/json'}),data:decoded.data,exportedAt,digest:await dataDigest(decoded.data)});
}
export function prepareRestore(data,day=dateKey()){
  const original=checkedData(data),candidate=structuredClone(original);
  try{rollTasks(candidate,day);}catch{fail('date','現在日付が対応範囲外、または繰り越しを計算できません');}
  const raw=serializeState(candidate),byId=new Map(candidate.items.map(item=>[item.id,item]));
  const changes=[];
  for(const item of original.items)if(item.type==='task'){
    const after=byId.get(item.id);
    if(!after)changes.push({title:item.title,before:item.due,after:null,reason:'完了済み・除外日を考慮すると、対応日付範囲内に次回が存在しません'});
    else if(after.due!==item.due)changes.push({title:item.title,before:item.due,after:after.due,reason:'現在日付へ期限を繰り越します'});
  }
  return freeze({day,candidate,raw,changes});
}
export function counts(data){return {events:data.items.filter(item=>item.type==='event').length,tasks:data.items.filter(item=>item.type==='task').length,history:data.history.length};}
export function createQuarantine(raw,now=new Date()){
  if(typeof raw!=='string')fail('raw','現在の保存文字列を読み取れません');
  if(raw.length*2>MAX_FILE_BYTES)fail('size','破損データが8MiBを超えるため完全な退避ファイルを作れません');
  const bytes=new Uint8Array(raw.length*2);
  for(let index=0;index<raw.length;index++){const unit=raw.charCodeAt(index);bytes[index*2]=unit&255;bytes[index*2+1]=unit>>>8;}
  return Object.freeze({raw,file:new File([bytes],'my-schedule-corrupt-'+now.toISOString().replace(/[:.]/g,'-')+'.bin',{type:'application/octet-stream'})});
}
