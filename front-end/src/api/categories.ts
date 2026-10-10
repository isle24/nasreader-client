import type {ContentKind,LibraryClient} from './libraries';
export interface Category {id:number;library_id:number;content_kind:ContentKind;parent_id:number|null;name:string;deleted:boolean;revision:number;book_count:number;can_manage:boolean}
export interface CategoryPage {items:Category[];total:number}
export interface BookCategories {items:Category[];revision:number;manual:boolean;library_id:number;content_kind:ContentKind;can_manage:boolean}
export type CategoryMode='add'|'replace';
export type AIMode='review'|'direct';
export interface CategoryAISettings {library_id:number;content_kind:ContentKind;ai_enabled:boolean;ai_mode:AIMode;auto_new:boolean;revision:number;taxonomy_revision:number;can_admin:boolean;configured:boolean}
export type CategoryTaskStatus='pending'|'running'|'review'|'applied'|'skipped'|'failed'|'rejected'|'cancelled';
export interface CategoryTask {id:number;book_id:number;title:string;status:CategoryTaskStatus;category_ids:number[];confidence:number;reason:string;error:string;created_at:number;updated_at:number}
export interface CategoryTasks {items:CategoryTask[];total:number;page:number;page_size:number;counts:Partial<Record<CategoryTaskStatus,number>>}
export interface CategoryPreview {eligible:number;queued:number;skipped:number;limit:number;mode:AIMode}
export function createCategoriesApi(client:LibraryClient){return {
 list:(filter:{library?:number;content_kind?:ContentKind;deleted?:boolean})=>client.get<CategoryPage>('/categories?'+new URLSearchParams({...(filter.library?{library:String(filter.library)}:{}),...(filter.content_kind?{content_kind:filter.content_kind}:{}),...(filter.deleted?{deleted:'1'}:{})})),
 create:(body:{library_id:number;name:string;parent_id?:number|null})=>client.post<Category>('/categories',body),
 update:(id:number,body:{name?:string;parent_id?:number|null;revision:number})=>client.send<Category>(`/categories/${id}`,'PATCH',body),
 remove:(id:number,revision:number)=>client.delete<void>(`/categories/${id}?revision=${revision}`),
 restore:(id:number,revision:number)=>client.post<Category>(`/categories/${id}/restore`,{revision}),
 defaults:(library_id:number)=>client.post<CategoryPage>('/categories/defaults',{library_id}),
 book:(id:number)=>client.get<BookCategories>(`/books/${id}/categories`),
 assignBook:(id:number,ids:number[],revision:number)=>client.put<BookCategories>(`/books/${id}/categories`,{ids,revision}),
 assign:(body:{library_id:number;books:{id:number;revision:number}[];category_ids:number[];mode:CategoryMode})=>client.post<{updated:number}>('/categories/assign',body),
 assignCollection:(body:{library_id:number;collection_id:number;collection_revision:number;category_ids:number[];mode:CategoryMode})=>client.post<{updated:number}>('/categories/assign-collection',body),
 settings:(library:number)=>client.get<CategoryAISettings>(`/category-ai/settings?library=${library}`),
 saveSettings:(library:number,body:{ai_enabled:boolean;ai_mode:AIMode;auto_new:boolean;revision:number})=>client.put<CategoryAISettings>(`/category-ai/settings?library=${library}`,body),
 enqueue:(body:{library_id:number;book_ids?:number[];limit?:number;dry_run?:boolean})=>client.post<CategoryPreview>('/category-ai/enqueue',body),
 tasks:(library:number,status:CategoryTaskStatus|''='',page=1,page_size=20)=>client.get<CategoryTasks>('/category-ai/tasks?'+new URLSearchParams({library:String(library),status,page:String(page),page_size:String(page_size)})),
 cancel:(library_id:number,ids?:number[])=>client.post<{cancelled:number}>('/category-ai/tasks/cancel',{library_id,...(ids?{ids}:{})}),
 retry:(library_id:number,ids?:number[])=>client.post<{retried:number;skipped:number}>('/category-ai/tasks/retry',{library_id,...(ids?{ids}:{})}),
 review:(library_id:number,ids:number[],action:'apply'|'reject')=>client.post<{applied:number;rejected:number;conflicts:{id:number;reason:string}[]}>('/category-ai/tasks/review',{library_id,ids,action}),
};}
export interface CategoryOption extends Category {path:string;depth:number}
/** Reject malformed trees locally; the server remains authoritative for depth and cycles. */
export function categoryOptions(items:Category[],library?:number,kind?:ContentKind,includeDeleted=false):CategoryOption[]{
 const scoped=items.filter(c=>(!library||c.library_id===library)&&(!kind||c.content_kind===kind)&&(includeDeleted||!c.deleted)),byID=new Map(scoped.map(c=>[c.id,c])),result:CategoryOption[]=[];
 function path(c:Category,seen=new Set<number>()):{path:string;depth:number}|null{
  if(seen.has(c.id)||seen.size>=3)return null;seen.add(c.id);
  if(c.parent_id===null)return {path:c.name,depth:0};
  const parent=byID.get(c.parent_id);if(!parent||parent.library_id!==c.library_id||parent.content_kind!==c.content_kind)return null;
  const prefix=path(parent,seen);return prefix?{path:prefix.path+' / '+c.name,depth:prefix.depth+1}:null;
 }
 const order=(parent:number|null,libraryID:number,contentKind:ContentKind,seen=new Set<number>())=>{
  for(const c of scoped.filter(c=>c.parent_id===parent&&c.library_id===libraryID&&c.content_kind===contentKind)){
   if(seen.has(c.id))continue;seen.add(c.id);const detail=path(c);if(detail)result.push({...c,...detail});order(c.id,libraryID,contentKind,seen);
  }
 };
 const roots=new Set(scoped.map(c=>c.library_id+':'+c.content_kind));for(const root of roots){const [id,k]=root.split(':');order(null,Number(id),k as ContentKind)}
 return result;
}

/** Deleted-list responses omit active ancestors, so load them as path context. */
export async function loadCategoryTree(api:Pick<ReturnType<typeof createCategoriesApi>,'list'>,library:number,kind:ContentKind,deleted=false):Promise<Category[]>{
 const [active,removed]=await Promise.all([api.list({library,content_kind:kind}),deleted?api.list({library,content_kind:kind,deleted:true}):Promise.resolve({items:[] as Category[],total:0})]);
 return [...new Map([...active.items,...removed.items].filter(c=>c.library_id===library&&c.content_kind===kind).map(c=>[c.id,c])).values()];
}
