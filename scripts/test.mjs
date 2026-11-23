import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(new URL('../test/',import.meta.url)).filter(name=>name.endsWith('.test.js')).sort();
const development=name=>/^(notification-|shortcut-|migration-protection\.test\.js|backup-ui\.test\.js)/.test(name);
let failed=false;
for(const enabled of [false,true]){
  const selected=files.filter(name=>development(name)===enabled).map(name=>'test/'+name);
  if(!selected.length)continue;
  console.log(enabled?'Notification development regressions (isolated Node loader)':'Basic release tests (notifications disabled)');
  const args=[...(enabled?['--import','./test/fixtures/notification-development.js']:[]),'--test',...selected];
  const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',env:process.env});
  if(result.error||result.status!==0)failed=true;
}
process.exitCode=failed?1:0;
