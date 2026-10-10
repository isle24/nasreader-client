export interface ContentVersion {id:number;hash:string}
export interface ContentVersionState<T extends ContentVersion> {changed:boolean;checking:boolean;latest:T|null}
export type VersionCheckResult='changed'|'unchanged'|'skipped'|'failed';
export interface ContentVersionGuard<T extends ContentVersion> {canWrite():boolean;check():Promise<VersionCheckResult>;state():ContentVersionState<T>;dispose():void}

/** One opened edition remains frozen until the reader is explicitly replaced. */
export function createContentVersionGuard<T extends ContentVersion>(opened:T,options:{fetch:(signal:AbortSignal)=>Promise<T>;eligible:()=>boolean;onState?:(state:ContentVersionState<T>)=>void;timeoutMs?:number}):ContentVersionGuard<T>{
 const openedID=opened.id,openedHash=opened.hash;
 let snapshot:ContentVersionState<T>={changed:false,checking:false,latest:null};
 let closed=false,epoch=0,controller:AbortController|undefined,active:Promise<VersionCheckResult>|undefined;
 const update=(value:Partial<ContentVersionState<T>>)=>{snapshot={...snapshot,...value};options.onState?.({...snapshot})};
 function check():Promise<VersionCheckResult>{
   if(closed||!options.eligible())return Promise.resolve('skipped');
   if(active)return active;
   const generation=++epoch,requestAbort=new AbortController();controller=requestAbort;update({checking:true});
   const timeout=setTimeout(()=>requestAbort.abort(),options.timeoutMs??8000);
   const cancelled=new Promise<T>((_resolve,reject)=>requestAbort.signal.addEventListener('abort',()=>reject(new Error('version check aborted')),{once:true}));
   active=(async()=>{
     try{
       const latest=await Promise.race([options.fetch(requestAbort.signal),cancelled]);
       if(closed||epoch!==generation)return 'skipped';
       if(latest.id!==openedID||!latest.hash)return 'failed';
       const changed=latest.hash!==openedHash;update({changed,latest});
       return changed?'changed':'unchanged';
     }catch{return 'failed'}
     finally{clearTimeout(timeout);if(epoch===generation){controller=undefined;active=undefined;if(!closed)update({checking:false})}}
   })();
   return active;
 }
 return {
   canWrite:()=>!closed&&!snapshot.changed&&!snapshot.checking,
   check,state:()=>({...snapshot}),
   dispose(){closed=true;epoch++;controller?.abort();controller=undefined;active=undefined},
 };
}
