import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT, PUBLIC_FILES, readSource } from './files.mjs';

export async function buildSite(projectRoot = PROJECT_ROOT) {
  const root = resolve(projectRoot);
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
  const existing = await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing && (existing.isSymbolicLink() || await realpath(output) !== output)) throw Error('Refusing a linked build directory');
  if (output !== join(root, 'dist')) throw Error('Unexpected build output path');
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
