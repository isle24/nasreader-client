import type {Book} from './client';
import type {ContentKind,LibraryClient} from './libraries';

export interface Collection {
 id:number;library_id:number;name:string;description:string;content_kind:ContentKind;
 automatic:boolean;customized:boolean;deleted:boolean;book_count:number;revision:number;can_manage:boolean;preview_books:Book[];
}
export type CollectionMember=Book&{position:number};
export interface CollectionFilters {content_kind:ContentKind;library?:number;q?:string;page?:number;page_size?:number;deleted?:boolean}
export interface CollectionPage<T>{items:T[];total:number}
export function createCollectionsApi(client:LibraryClient){return {
 list:(filter:CollectionFilters)=>client.get<CollectionPage<Collection>>('/collections?'+new URLSearchParams({content_kind:filter.content_kind,...(filter.library?{library:String(filter.library)}:{}),q:filter.q??'',page:String(filter.page??1),page_size:String(filter.page_size??24),...(filter.deleted?{deleted:'1'}:{})})),
 detail:(id:number)=>client.get<Collection>(`/collections/${id}`),
 members:(id:number,page=1,page_size=24)=>client.get<CollectionPage<CollectionMember>>(`/collections/${id}/books?${new URLSearchParams({page:String(page),page_size:String(page_size)})}`),
 create:(body:{name:string;description?:string;library_id:number;book_ids?:number[]})=>client.post<Collection>('/collections',body),
 update:(id:number,body:{name?:string;description?:string;revision:number})=>client.send<Collection>(`/collections/${id}`,'PATCH',body),
 replaceMembers:(id:number,ids:number[],revision:number)=>client.put<Collection>(`/collections/${id}/books`,{ids,revision}),
 remove:(id:number,revision:number)=>client.delete<void>(`/collections/${id}?revision=${revision}`),
 restore:(id:number,revision:number)=>client.post<Collection>(`/collections/${id}/restore`,{revision}),
 candidates:(library:number,kind:ContentKind,q='',page=1,page_size=20)=>client.get<CollectionPage<Book>>('/books?'+new URLSearchParams({library:String(library),content_kind:kind,q,page:String(page),page_size:String(page_size)})),
};}
export type CollectionsApi=ReturnType<typeof createCollectionsApi>;

/** A replacement must include every existing member and the revision it was read at. */
export async function loadCollectionMembersForEdit(api:CollectionsApi,id:number,pageSize=100):Promise<{collection:Collection;members:CollectionMember[]}>{
 const collection=await api.detail(id),members:CollectionMember[]=[];
 let total=0,page=1;
 do{
  const response=await api.members(id,page++,pageSize);
  if(page>2&&response.total!==total)throw new Error('集合已被更新，请重新打开成员管理');
  total=response.total;
  if(response.items.length===0&&members.length<total)throw new Error('成员列表不完整，请重新加载后再编辑');
  members.push(...response.items);
 }while(members.length<total);
 if(members.length!==total||new Set(members.map(book=>book.id)).size!==total)throw new Error('成员列表不完整，请重新加载后再编辑');
 const latest=await api.detail(id);
 if(latest.revision!==collection.revision)throw new Error('集合已被更新，请重新打开成员管理');
 return {collection,members};
}
export function moveCollectionMember<T>(members:T[],index:number,direction:-1|1):T[]{
 const next=[...members],target=index+direction;
 if(index<0||index>=next.length||target<0||target>=next.length)return next;
 [next[index],next[target]]=[next[target],next[index]];
 return next;
}
