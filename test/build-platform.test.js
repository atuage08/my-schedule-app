import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,realpath,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {buildSite} from '../scripts/build.mjs';
import {PROJECT_ROOT,PUBLIC_FILES,readSource} from '../scripts/files.mjs';
import {createTestLink} from './fixtures/link-capability.js';

async function fixture(t){
  const base=await mkdtemp(join(tmpdir(),'my-schedule-platform-'));
  t.after(()=>{
    if(dirname(resolve(base))!==resolve(tmpdir())||!basename(base).startsWith('my-schedule-platform-'))throw Error('Unexpected cleanup path');
    return rm(base,{recursive:true,force:true});
  });
  const root=join(base,'project');await mkdir(root);
  for(const name of ['package.json',...PUBLIC_FILES]){
    await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),await readSource(PROJECT_ROOT,name));
  }
  return {base,root};
}
test('a regular output remains valid through native path spelling aliases',async t=>{
  const {root}=await fixture(t);
  await mkdir(join(root,'dist'));await writeFile(join(root,'dist','stray.txt'),'old artifact');
  const alias=process.platform==='win32'?join(dirname(root),basename(root).toUpperCase()):join(root,'.');
  const output=resolve(alias,'dist'),canonical=await realpath(output);
  assert.equal((await lstat(output)).isSymbolicLink(),false);
  if(process.platform==='win32')assert.notEqual(canonical,output,'reproduce the old false-positive predicate');
  const source=await readFile(join(root,'src/app.js'));
  await buildSite(alias);
  await assert.rejects(lstat(join(output,'stray.txt')),error=>error.code==='ENOENT');
  assert.deepEqual(await readFile(join(root,'src/app.js')),source);
  assert.equal((await lstat(output)).isDirectory(),true);
});
test('real output junctions/symlinks outside the project stay rejected and untouched',async t=>{
  const {base,root}=await fixture(t),outside=join(base,'outside');await mkdir(outside);
  await writeFile(join(outside,'keep.txt'),'outside fixture');
  if(!await createTestLink(t,()=>symlink(outside,join(root,'dist'),process.platform==='win32'?'junction':'dir'),{kind:'outside output junction/symlink'}))return;
  await assert.rejects(buildSite(root),/linked/);
  assert.equal(await readFile(join(outside,'keep.txt'),'utf8'),'outside fixture');
  assert.equal((await lstat(join(root,'dist'))).isSymbolicLink(),true);
});
test('an output link to another directory inside the project is also refused',async t=>{
  const {root}=await fixture(t),other=join(root,'other');await mkdir(other);await writeFile(join(other,'keep.txt'),'inside fixture');
  if(!await createTestLink(t,()=>symlink(other,join(root,'dist'),process.platform==='win32'?'junction':'dir'),{kind:'inside output junction/symlink'}))return;
  await assert.rejects(buildSite(root),/linked/);assert.equal(await readFile(join(other,'keep.txt'),'utf8'),'inside fixture');
});
test('a regular file named dist is refused without being removed',async t=>{
  const {root}=await fixture(t);await writeFile(join(root,'dist'),'not a directory');
  await assert.rejects(buildSite(root),/non-directory/);assert.equal(await readFile(join(root,'dist'),'utf8'),'not a directory');
});
