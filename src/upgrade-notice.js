import {LOCK_NAME} from './storage.js';

// Version this receipt when the write protocol requires another explicit
// acknowledgment. It is not proof that uncooperative/old tabs are absent.
export const UPGRADE_KEY='my-schedule.write-protocol-ack.v1';
const RECEIPT='web-locks-v1-acknowledged';
export class UpgradeNotice{
  constructor({storage,locks}){this.storage=storage;this.locks=locks;this.required=true;this.refresh();}
  refresh(){
    try{this.required=this.storage.getItem(UPGRADE_KEY)!==RECEIPT;}catch{this.required=true;}
    return this.required;
  }
  async acknowledge(confirmed){
    if(!confirmed)return {ok:false,message:'旧版を終了して新版を開き直したことを確認してください'};
    if(!this.locks?.request)return {ok:false,message:'確認を記録できません。案内を表示したままにします'};
    try{
      return await this.locks.request(LOCK_NAME,{mode:'exclusive'},()=>{
        this.storage.setItem(UPGRADE_KEY,RECEIPT);
        if(this.storage.getItem(UPGRADE_KEY)!==RECEIPT)throw Error('Receipt not verified');
        this.required=false;return {ok:true};
      });
    }catch{this.required=true;return {ok:false,message:'確認を記録できませんでした。案内は消していません'};}
  }
}
