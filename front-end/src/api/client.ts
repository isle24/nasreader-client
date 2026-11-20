import type {components} from './schema';
export type Session=components['schemas']['Session']; export type Book=components['schemas']['Book']&{can_manage?:boolean;reader_mode?:string;document_format?:string;library_name?:string}; export type Chapter=components['schemas']['Chapter']; export type Note=components['schemas']['Note']; export type Progress=components['schemas']['Progress'];
export interface Sessions{read(server:string):Promise<Session|null>;write(server:string,value:Session|null):Promise<void>}
export class MemorySessions implements Sessions{private values=new Map<string,Session>();async read(s:string){return this.values.get(s)??null}async write(s:string,v:Session|null){v?this.values.set(s,v):this.values.delete(s)}}
export class PersistentSessions implements Sessions{
 private native=typeof window!=='undefined'&&'__TAURI_INTERNALS__' in window;
 async read(server:string){if(this.native){const {invoke}=await import('@tauri-apps/api/core');const value=await invoke<string|null>('credentials_read',{server});return value?JSON.parse(value):null}const value=localStorage.getItem('nasreader.session:'+server);return value?JSON.parse(value):null}
 async write(server:string,value:Session|null){if(this.native){const {invoke}=await import('@tauri-apps/api/core');if(value)await invoke('credentials_write',{server,value:JSON.stringify(value)});else await invoke('credentials_clear',{server});return}if(value)localStorage.setItem('nasreader.session:'+server,JSON.stringify(value));else localStorage.removeItem('nasreader.session:'+server)}
}
export class ApiError extends Error{constructor(public status:number,public body:any){super(body?.error?.message??`请求失败 (${status})`)}}
export class ApiClient{
 session:Session|null=null;
 private sessionGeneration=0;
 private refreshing:Promise<void>|null=null;private fetcher:typeof fetch;
 // `window.fetch` must be called with `window` as its receiver; calling the bare
 // reference as `this.fetcher(...)` throws "Illegal invocation" in browsers, so the
 // default is wrapped instead of taken as an unbound reference.
 constructor(public server:string,private persistence:Sessions,fetcher?:typeof fetch){this.fetcher=fetcher??((input,init)=>globalThis.fetch(input,init))}
 async restore(){const generation=++this.sessionGeneration,server=this.server;const session=await this.persistence.read(server);if(generation===this.sessionGeneration&&server===this.server)this.session=session}
 async setSession(value:Session|null){const generation=++this.sessionGeneration,server=this.server;await this.persistence.write(server,value);if(generation===this.sessionGeneration&&server===this.server)this.session=value}
 async request<T=any>(path:string,options:RequestInit={},retry=true):Promise<T>{
 const requestedServer=this.server,requestedUser=this.session?.user.id,requestedToken=this.session?.access_token,sessionGeneration=this.sessionGeneration;
 const current=()=>this.server===requestedServer&&this.session?.user.id===requestedUser&&this.sessionGeneration===sessionGeneration;
 const headers=new Headers(options.headers);if(this.session)headers.set('Authorization',`Bearer ${this.session.access_token}`);
 const response=await this.fetcher(this.server+'/api/v1'+path,{...options,headers});
 if(response.status===401&&retry&&this.session&&current()){if(this.session.access_token===requestedToken){if(!this.refreshing)this.refreshing=this.rotate().finally(()=>this.refreshing=null);await this.refreshing}if(!current())throw new Error('请求账户或服务器已变更，请重新操作');return this.request(path,options,false)}
 if(!response.ok){let body;try{body=await response.json()}catch{body={error:{message:`服务返回 ${response.status}；请检查服务版本和地址`}}}throw new ApiError(response.status,body)}
 if(response.status===204)return undefined as T;if(options.headers&&new Headers(options.headers).get('Accept')==='application/octet-stream')return await response.blob() as T;
 const content=response.headers.get('content-type')??'';return content.includes('json')?response.json():response.blob() as Promise<T>;
 }
 private async rotate(){
  const server=this.server,generation=this.sessionGeneration,current=()=>this.server===server&&this.sessionGeneration===generation;
  const response=await this.fetcher(server+'/api/v1/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:this.session?.refresh_token})});
  if(!current())throw new Error('请求账户或服务器已变更，请重新操作');
  if(!response.ok){await this.setSession(null);throw new Error('登录已过期，请重新登录')}
  const session=await response.json();if(!current())throw new Error('请求账户或服务器已变更，请重新操作');
  // Token rotation continues the same login visit; explicit login/restore advances its generation.
  await this.persistence.write(server,session);if(current())this.session=session;
 }
 get<T=any>(path:string){return this.request<T>(path)}
 send<T=any>(path:string,method:string,body?:unknown){return this.request<T>(path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})}
 post<T=any>(p:string,b?:unknown){return this.send<T>(p,'POST',b)}put<T=any>(p:string,b?:unknown){return this.send<T>(p,'PUT',b)}delete<T=any>(p:string){return this.send<T>(p,'DELETE')}
 blob(p:string){return this.request<Blob>(p,{headers:{Accept:'application/octet-stream'}})}
}
