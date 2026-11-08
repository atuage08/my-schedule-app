import { lstat, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT, PUBLIC_FILES, readSource } from './files.mjs';

export async function buildSite(projectRoot = PROJECT_ROOT) {
  const root = resolve(projectRoot);
  const same=(a,b)=>a.ino!==0n&&b.ino!==0n&&a.dev===b.dev&&a.ino===b.ino;
  // Pin the original project identity before reading any inputs. A later path
  // redirect must not turn an outside directory into the "expected" parent.
  const initialRoot=await lstat(root,{bigint:true});
  if(initialRoot.isSymbolicLink()||!initialRoot.isDirectory()||initialRoot.ino===0n)throw Error('Cannot verify the original project directory');
  const config = JSON.parse((await readSource(root,'package.json')).toString('utf8'));
  if (config.name !== 'my-schedule-prototype') throw Error('This is not the My Schedule project');
  // Read every input before replacing a previous artifact.
  // Wait for every protected read (and its handle cleanup), even after an input fails.
  const results=await Promise.allSettled(PUBLIC_FILES.map(async name=>[name,await readSource(root,name)]));
  for(const result of results)if(result.status==='rejected')throw result.reason;
  const sources=results.map(result=>result.value);
  for (const [name, contents] of sources) if (name.endsWith('.js')) {
    const result=spawnSync(process.execPath,['--input-type=module','--check'],{input:contents,encoding:'utf8'});
    if(result.status!==0)throw Error(`Build refused invalid JavaScript: ${name}`);
  }
  const output = resolve(root, 'dist');
  if (output !== join(root, 'dist')) throw Error('Unexpected build output path');
  const currentRoot=await lstat(root,{bigint:true});
  if(currentRoot.isSymbolicLink()||!currentRoot.isDirectory()||!same(initialRoot,currentRoot))throw Error('Project directory identity changed during build');
  const existing = await lstat(output,{bigint:true}).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if(existing){
    if(existing.isSymbolicLink()||!existing.isDirectory())throw Error('Refusing a linked or non-directory build output');
    const canonicalOutput=await realpath(output);
    const leaf=basename(canonicalOutput);
    if((process.platform==='win32'?leaf.toLowerCase():leaf)!=='dist')throw Error('Unexpected canonical build output name');
    // realpath expands Windows 8.3 names and case aliases. Compare directory
    // identities, not lexical spellings (and don't lowercase all Linux paths).
    const [rootInfo,parentInfo,targetInfo,current]=await Promise.all([
      stat(root,{bigint:true}),stat(dirname(canonicalOutput),{bigint:true}),
      stat(canonicalOutput,{bigint:true}),lstat(output,{bigint:true})
    ]);
    if(!rootInfo.isDirectory()||!parentInfo.isDirectory()||!same(initialRoot,rootInfo)||!same(initialRoot,parentInfo))throw Error('Build output escapes the original project directory');
    if(!targetInfo.isDirectory()||current.isSymbolicLink()||!current.isDirectory()||!same(existing,targetInfo)||!same(existing,current))throw Error('Build output identity changed during verification');
  }
  // Only the verified <this project>/dist artifact is replaced; no repository/source deletion.
  await rm(output, { recursive: true, force: true });
  await mkdir(output);
  for (const [name, contents] of sources) {
    await mkdir(dirname(join(output, name)), { recursive: true });
    await writeFile(join(output, name), contents);
  }
  await writeFile(join(output, '.nojekyll'), '');
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`Pages build: ${await buildSite()}`);
}
