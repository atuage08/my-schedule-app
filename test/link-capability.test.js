import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestLink} from './fixtures/link-capability.js';
test('a successfully created link runs the test without marking it skipped',async()=>{
  let skipped=false;assert.equal(await createTestLink({skip(){skipped=true;}},async()=>{},{platform:'win32',required:false}),true);assert.equal(skipped,false);
});
test('Windows creation EPERM and EACCES explicitly mark defense as unverified rather than successful',async()=>{
  for(const code of ['EPERM','EACCES']){
    let reason;const result=await createTestLink({skip(message){reason=message;}},async()=>{throw Object.assign(Error('blocked'),{code});},{kind:'junction',platform:'win32',required:false});
    assert.equal(result,false);assert.ok(reason.includes(code));assert.ok(reason.includes('Cannot verify'));
  }
});
test('filesystem and lock errors other than creation permission errors still fail',async()=>{
  for(const code of ['EIO','ENOENT','EBUSY','EEXIST'])await assert.rejects(createTestLink({skip(){throw Error('must not skip');}},async()=>{throw Object.assign(Error(code),{code});},{platform:'win32',required:false}),error=>error.code===code);
});
test('Linux permission failures remain failures',async()=>{
  await assert.rejects(createTestLink({skip(){throw Error('must not skip');}},async()=>{throw Object.assign(Error('permission'),{code:'EPERM'});},{platform:'linux',required:false}),error=>error.code==='EPERM');
});
test('strict link mode never permits a permission skip',async()=>{
  await assert.rejects(createTestLink({skip(){throw Error('must not skip');}},async()=>{throw Object.assign(Error('permission'),{code:'EPERM'});},{platform:'win32',required:true}),error=>error.code==='EPERM');
});
