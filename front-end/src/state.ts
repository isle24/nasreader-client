// Global session/app state. Only the non-sensitive server URL is kept in
// localStorage; the session itself lives in the Tauri Keychain (native) or the
// browser origin storage through PersistentSessions.
import {reactive} from 'vue';
import {ApiClient,PersistentSessions,type Session} from './api/client';
import {defaultServer,normalizeServer} from './reader/core';
import {pendingMutations,removeMutation,cachedBooks,removeCachedBooks} from './api/cache';
import {checkBookAccess} from './api/access';
import {errorMessage,isOffline} from './api/errors';
import type {LicenseStatus} from './licensing';

function readServer():string{try{return localStorage.getItem('nasreader.server')??''}catch{return ''}}
function writeServer(value:string){try{localStorage.setItem('nasreader.server',value)}catch{/* private mode */ }}

/** Native (Tauri) builds start unconfigured; web builds talk to their own origin. */
export const native=typeof window!=='undefined'&&'__TAURI_INTERNALS__' in window;
const saved=readServer();

export const state=reactive({
  ready:false,
  native,
  server:saved||defaultServer({native}),
  user:null as Session['user']|null,
  license:null as LicenseStatus|null,
  error:'',
  offline:!navigator.onLine,
  syncMessage:'',
  syncing:false,
  accessEpoch:0,
  accessRevision:null as unknown,
  revokedBookIDs:[] as number[],
  /** True when the server came from the page itself rather than from the user. */
  serverLocked:!native&&!saved,
  /** True when the user typed or switched to another server by hand. */
  serverManual:!!saved&&!native,
  /** True once the app reached a server and asked for its setup state. */
  serverReachable:false,
});
export const api=new ApiClient(state.server,new PersistentSessions());

/** True when the app discovers its own server and must not ask for an address. */
export const autoServer=()=>!!state.server&&!state.native;

/** Point the app at a server and load the session that belongs to it. */
export async function connect(server?:string,manual=false){
  const requested=normalizeServer(server??state.server);
  if(!requested)throw new Error('请输入服务地址，例如 http://192.168.3.56:18089');
  if(state.server!==requested)state.license=null;
  state.server=requested;
  state.serverLocked=!manual&&!state.native;
  state.serverManual=manual&&!state.native;
  api.server=state.server;
  writeServer(state.server);
  await api.restore();
  state.user=(api.session as Session|null)?.user??null;
  state.serverReachable=true;
  state.ready=true;
}

/** Drop a manually chosen server and fall back to the page's own origin. */
export async function resetServer(){
  const fallback=defaultServer({native});
  try{localStorage.removeItem('nasreader.server')}catch{/* private mode */}
  state.license=null;
  state.server=fallback;
  state.serverLocked=!native;
  state.serverManual=false;
  state.serverReachable=false;
  api.server=fallback;
  await api.restore();
  state.user=(api.session as Session|null)?.user??null;
  state.ready=true;
}

/** Replay queued offline mutations for the current account, oldest first. */
export async function syncQueue(){
  if(!state.user||!navigator.onLine||state.syncing)return;
  state.syncing=true;
  try{
    const items=await pendingMutations(state.server,state.user.id);
    let done=0;
    for(const item of items){
      try{await api.send(item.path,item.method,item.body);await removeMutation(item.id);done++}
      catch(e:any){
        if(e?.status===409){
          state.syncMessage='离线进度与服务器上的新位置冲突，本地记录已保留；请在阅读器里选择保留哪一个位置';
          return;
        }
        state.syncMessage=`离线同步待重试（${done}/${items.length}）：${isOffline(e)?'网络不可用':errorMessage(e)}`;
        return;
      }
    }
    state.syncMessage=items.length?`离线修改已同步（${done} 条）`:'';
  }finally{state.syncing=false}
}

window.addEventListener('online',()=>{state.offline=false;void syncQueue()});
window.addEventListener('offline',()=>{state.offline=true});

let accessChecking:Promise<number[]>|null=null;const accessQueued=new Set<number>();
/** Online revocation only removes resources explicitly refused by the server. */
export function refreshAccess(extraIDs:number[]=[]):Promise<number[]>{
 if(!state.user||state.offline||!navigator.onLine)return Promise.resolve([]);
 for(const id of extraIDs)if(Number.isSafeInteger(id)&&id>0)accessQueued.add(id);
 if(accessChecking)return accessChecking;
 const server=state.server,user=state.user.id;
 accessChecking=(async()=>{
  const recentKey='nasreader.recent:'+server+':'+user;
  let recent:number[]=[];try{const value=JSON.parse(localStorage.getItem(recentKey)??'[]');if(Array.isArray(value))recent=value.filter(id=>Number.isSafeInteger(id)&&id>0)}catch{/* malformed optional history */}
  const snapshots=await cachedBooks(server,user),ids=[...recent,...snapshots.map(snapshot=>snapshot.book.id),...accessQueued];accessQueued.clear();
  if(!ids.length)return [];
  const response=await checkBookAccess(api,ids);
  if(state.server!==server||state.user?.id!==user)return [];
  await removeCachedBooks(server,user,response.denied);
  if(response.denied.length){try{localStorage.setItem(recentKey,JSON.stringify(recent.filter(id=>!response.denied.includes(id))))}catch{/* no persistent history */}}
  const changed=response.denied.length>0||JSON.stringify(state.accessRevision)!==JSON.stringify(response.revision);state.revokedBookIDs=response.denied;state.accessRevision=response.revision;if(changed)state.accessEpoch++;
  return response.denied;
 })().finally(()=>{accessChecking=null});
 return accessChecking;
}
