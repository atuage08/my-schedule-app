// Node-only regression environment. Never copied into public assets.
// The release policy source stays false; no application URL/storage override.
import {registerHooks} from 'node:module';
const policy=new URL('../../src/features.js',import.meta.url).href;
registerHooks({load(url,context,next){
  const result=next(url,context);
  if(url!==policy)return result;
  const source=String(result.source),marker='export const NOTIFICATIONS_ENABLED=false;';
  if(!source.includes(marker))throw Error('Unexpected notification policy source');
  return {...result,source:source.replace(marker,'export const NOTIFICATIONS_ENABLED=true;')};
}});
