// Test-only protocol. Register each expected message before sending a command.
export function raceSession(worker,{timeoutMs=15000}={}){
  let pending,result,fatal,finishTimer,finished=false;
  let resolveDone,rejectDone;
  const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
  done.catch(()=>{});
  function fail(error){
    fatal??=error;clearTimeout(finishTimer);
    if(pending){clearTimeout(pending.timer);pending.reject(error);pending=undefined;}
    rejectDone(error);
  }
  worker.on('message',message=>{
    if(fatal)return;
    if(message?.type==='result'){
      if(pending||finished===false||result)return fail(Error('Unexpected race worker result'));
      result=message;return;
    }
    if(!pending||message?.type!==pending.type||message.round!==pending.round)return fail(Error('Unexpected race worker message'));
    const current=pending;pending=undefined;clearTimeout(current.timer);current.resolve(message);
  });
  worker.on('error',fail);
  worker.on('exit',code=>{
    if(code!==0||pending||!finished||!result?.restored)return fail(Error('Race worker exited before completed restoration'));
    clearTimeout(finishTimer);resolveDone(result);
  });
  return {
    exchange(command,type,round){
      if(fatal)return Promise.reject(fatal);
      if(pending||finished)throw Error('Overlapping race worker command');
      return new Promise((resolve,reject)=>{
        pending={type,round,resolve,reject,timer:setTimeout(()=>fail(Error('Race worker protocol timed out')),timeoutMs)};
        try{worker.postMessage({type:command,round});}catch(error){fail(error);}
      });
    },
    finish(){
      if(fatal)return Promise.reject(fatal);
      if(pending||finished)throw Error('Cannot finish an active race round');
      finished=true;finishTimer=setTimeout(()=>fail(Error('Race worker exit timed out')),timeoutMs);
      try{worker.postMessage({type:'stop',round:10});}catch(error){fail(error);}
      return done;
    },
    // Exceptions must not leave a worker stranded at a release barrier.
    async dispose(){clearTimeout(finishTimer);if(pending)fail(Error('Race session disposed before restoration'));await worker.terminate();},
  };
}
