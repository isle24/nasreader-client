import type {AdapterRef,DiscoverClient,ImportJob} from './discover';

export interface Subscription {id:number;name:string;url:string;source_count:number;updated_at:number}
export interface PreviewSource {key:string;name:string;supported:boolean;capabilities:string[];issues:string[];change:'added'|'changed'|'removed'|'unchanged';local_edit?:boolean;conflict?:boolean}
export interface SubscriptionPreview {url:string;revision:string;total:number;sources:PreviewSource[]}
export interface SubscriptionResult {id:number;added:number;changed:number;removed:number;source_count:number}
export interface RuleResult {source:unknown;report:{supported?:boolean;capabilities?:string[];issues?:string[]};version:number;allowed_hosts?:string[];reader_adapter_id?:number|null;upstream_source?:unknown;local_edit?:boolean;removed?:boolean}
export interface BookSource {binding_id:number;adapter_name:string;remote_url:string;last_checked:number;status:string;can_update:boolean;versions?:unknown[]}
interface SourceClient extends DiscoverClient {put<T=any>(path:string,body?:unknown):Promise<T>;send?<T=any>(path:string,method:string,body?:unknown):Promise<T>}
export function createSourcePluginsApi(client:SourceClient){
  return {
    platformCatalog:()=>client.get<{items:PlatformDescriptor[];total:number}>('/adapters/platforms'),
    createPlatform:(kind:PlatformKind,draft:PlatformDraft)=>client.post<AdapterRef>(`/adapters/platforms/${kind}`,{...platformAdapterBody(draft),enabled:false}),
    updatePlatform:(id:number,draft:PlatformDraft,original:AdapterRef)=>{
      if(!client.send)throw new Error('当前客户端不支持更新平台配置');
      return client.send<AdapterRef>(`/adapters/${id}`,'PATCH',platformAdapterBody(draft,original));
    },
    readerSources:(id:number)=>client.get<{items:ReaderSource[];total:number}>(`/adapters/${id}/reader-sources`),
    subscriptions:()=>client.get<{items:Subscription[];total:number}>('/subscriptions'),
    preview:(url:string)=>client.post<SubscriptionPreview>('/subscriptions/preview',{url}),
    importSubscription:(name:string,url:string,source_keys:string[],revision:string)=>client.post<SubscriptionResult>('/subscriptions',{name,url,source_keys,revision}),
    previewUpdate:(id:number)=>client.post<SubscriptionPreview>(`/subscriptions/${id}/preview`,{}),
    updateSubscription:(id:number,source_keys:string[],revision:string)=>client.post<SubscriptionResult>(`/subscriptions/${id}/update`,{source_keys,revision}),
    rule:(id:number)=>client.get<RuleResult>(`/adapters/${id}/rule`),
    saveRule:(id:number,body:{source:unknown;reader_adapter_id?:number;allowed_hosts?:string[]})=>client.put<RuleResult>(`/adapters/${id}/rule`,body),
    rollbackRule:(id:number)=>client.post<RuleResult>(`/adapters/${id}/rule/rollback`),
    associateSource:(id:number,adapter_id:number,candidate_id:string)=>client.post<BookSource>(`/books/${id}/source`,{adapter_id,candidate_id}),
    bookSource:(id:number)=>client.get<BookSource>(`/books/${id}/source`),
    updateBook:(id:number)=>client.post<ImportJob>(`/books/${id}/update`,{}),
  };
}
export function selectablePreviewKeys(sources:PreviewSource[]):string[]{return sources.filter(s=>s.supported&&s.change!=='removed').map(s=>s.key)}
export function validateSubscriptionUrl(value:string):string{
  try{const url=new URL(value.trim());if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return '请填写不含账号密码的 HTTP 或 HTTPS 订阅地址';return ''}
  catch{return '请填写完整的订阅 URL'}
}
export function capabilityStatus(adapter:Pick<AdapterRef,'kind'|'supported'|'engine'|'platform_config'>):string{
  if(adapter.supported===false)return '当前定义不支持';
  if(isPlatformKind(adapter.kind)){
    const mode=adapter.platform_config?.mode??'web';
    return mode==='api'?'自配兼容 API · 请测试可用性':mode==='reader'?'reader 兼容服务 · 请测试可用性':'官网公开网页 · 内容与搜索受平台限制';
  }
  if(adapter.engine==='reader-compat')return 'reader 兼容执行 · 尚未实测';
  if(adapter.kind==='legado')return '定义兼容 · 尚未实测';
  return '外部服务连接 · 请测试可用性';
}
export function adapterUpdateBody(draft:{name:string;kind:string;base_url:string;enabled:boolean;secret?:string}){
  return {name:draft.name,kind:draft.kind,base_url:draft.base_url,enabled:draft.enabled,...(draft.secret?{secret:draft.secret}:{})};
}
export const RESULT_LABEL:Record<string,string>={added:'已新增',updated:'已更新',unchanged:'无变化',conflict:'内容冲突，已保留现有版本'};

export type PlatformKind='fanqie'|'qimao';
export type PlatformMode='web'|'api'|'reader';
export interface PlatformDescriptor {kind:PlatformKind;name:string;origin:string;version:string;capabilities:string[];limitations:string[]}
export interface ReaderSource {key:string;name:string;enabled:boolean}
export interface PlatformDraft {kind:PlatformKind;name:string;enabled:boolean;mode:PlatformMode;api_base_url:string;api_token:string;clear_api_token:boolean;reader_adapter_id:string;source_key:string}
export function isPlatformKind(kind:string):kind is PlatformKind{return kind==='fanqie'||kind==='qimao'}
export function newPlatformDraft(kind:PlatformKind,name:string):PlatformDraft{return {kind,name,enabled:false,mode:'web',api_base_url:'',api_token:'',clear_api_token:false,reader_adapter_id:'',source_key:''}}
export function editPlatformDraft(adapter:AdapterRef):PlatformDraft{
  const config=adapter.platform_config;
  return {...newPlatformDraft(isPlatformKind(adapter.kind)?adapter.kind:'fanqie',adapter.name),enabled:adapter.enabled===true,mode:config?.mode??'web',api_base_url:config?.api_base_url??'',reader_adapter_id:config?.reader_adapter_id?String(config.reader_adapter_id):'',source_key:config?.source_key??''};
}
export function platformEndpoint(value:string):string{return value.trim().replace(/\/+$/,'')}
export function platformAdapterBody(draft:PlatformDraft,original?:AdapterRef){
  let platform_config:{mode:PlatformMode;api_base_url?:string;api_token?:string;clear_api_token?:boolean;reader_adapter_id?:number;source_key?:string}={mode:draft.mode};
  if(draft.mode==='api'){
    platform_config.api_base_url=platformEndpoint(draft.api_base_url);
    const changed=!!original&&(original.platform_config?.mode!=='api'||platformEndpoint(original.platform_config.api_base_url??'')!==platform_config.api_base_url);
    if(draft.clear_api_token)platform_config.clear_api_token=true;
    else if(draft.api_token)platform_config.api_token=draft.api_token;
    else if(changed)platform_config.clear_api_token=true;
  }else if(draft.mode==='reader'){
    platform_config={mode:'reader',reader_adapter_id:Number(draft.reader_adapter_id),source_key:draft.source_key.trim()};
  }
  return {name:draft.name.trim(),enabled:draft.enabled,platform_config};
}
export function validatePlatformDraft(draft:PlatformDraft):string{
  if(!draft.name.trim())return '请填写插件名称';
  if(draft.mode==='api'){
    try{const url=new URL(draft.api_base_url.trim());if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return '请填写不含账号密码、查询参数或片段的 HTTP / HTTPS API 地址'}
    catch{return '请填写完整的兼容 API 地址'}
  }
  if(draft.mode==='reader'){
    const id=Number(draft.reader_adapter_id);if(!Number.isSafeInteger(id)||id<=0)return '请从列表选择 reader 服务';
    if(!draft.source_key.trim())return '请选择兼容书源；无法发现时可在高级配置填写源 key';
  }
  return '';
}
export function platformReaderOptions(adapters:AdapterRef[],query=''):AdapterRef[]{return adapters.filter(item=>item.kind==='reader'&&item.name.toLowerCase().includes(query.trim().toLowerCase()))}
