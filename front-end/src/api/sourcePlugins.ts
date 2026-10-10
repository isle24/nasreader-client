import type {AdapterRef,DiscoverClient,ImportJob} from './discover';

export interface Subscription {id:number;name:string;url:string;source_count:number;updated_at:number}
export interface PreviewSource {key:string;name:string;supported:boolean;capabilities:string[];issues:string[];change:'added'|'changed'|'removed'|'unchanged';local_edit?:boolean;conflict?:boolean}
export interface SubscriptionPreview {url:string;revision:string;total:number;sources:PreviewSource[]}
export interface SubscriptionResult {id:number;added:number;changed:number;removed:number;source_count:number}
export interface RuleResult {source:unknown;report:{supported?:boolean;capabilities?:string[];issues?:string[]};version:number;allowed_hosts?:string[];reader_adapter_id?:number|null;upstream_source?:unknown;local_edit?:boolean;removed?:boolean}
export interface BookSource {binding_id:number;adapter_name:string;remote_url:string;last_checked:number;status:string;can_update:boolean;versions?:unknown[]}
interface SourceClient extends DiscoverClient {put<T=any>(path:string,body?:unknown):Promise<T>}
export function createSourcePluginsApi(client:SourceClient){
  return {
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
export function capabilityStatus(adapter:Pick<AdapterRef,'kind'|'supported'|'engine'>):string{
  if(adapter.supported===false)return '当前定义不支持';
  if(adapter.engine==='reader-compat')return 'reader 兼容执行 · 尚未实测';
  if(adapter.kind==='legado')return '定义兼容 · 尚未实测';
  return '外部服务连接 · 请测试可用性';
}
export function adapterUpdateBody(draft:{name:string;kind:string;base_url:string;enabled:boolean;secret?:string}){
  return {name:draft.name,kind:draft.kind,base_url:draft.base_url,enabled:draft.enabled,...(draft.secret?{secret:draft.secret}:{})};
}
export const RESULT_LABEL:Record<string,string>={added:'已新增',updated:'已更新',unchanged:'无变化',conflict:'内容冲突，已保留现有版本'};
