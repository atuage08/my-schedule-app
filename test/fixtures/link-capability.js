// Only fixture creation may be permission-skipped. Assertions against the
// production reader/builder, link cleanup and race-worker failures still fail.
export async function createTestLink(t,create,{kind='link',platform=process.platform,required=process.env.MY_SCHEDULE_REQUIRE_LINKS==='1'}={}){
  try{await create();return true;}
  catch(error){
    if(!required&&platform==='win32'&&['EPERM','EACCES'].includes(error?.code)){
      t.skip(`Cannot verify ${kind} defense: Windows denied fixture creation (${error.code}). Run in a link-capable environment; MY_SCHEDULE_REQUIRE_LINKS=1 makes this a failure.`);
      return false;
    }
    throw error;
  }
}
