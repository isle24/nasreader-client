export type ContentKind='book'|'comic';
export type Visibility='shared'|'private'|'restricted';
export interface LibraryRef {id:number;name:string;content_kind:ContentKind;storage_kind:'directory'|'virtual';owner_user_id:number|null;visibility:Visibility;archived:boolean;is_personal_default:boolean;can_read:boolean;can_contribute:boolean;can_manage:boolean;path?:string;book_count?:number;job_count?:number;last_scan?:number}
export interface LibraryGrant {user_id:number;username?:string;permission:'read'|'contribute'|'manage'}
export interface ManagedUser {id:number;username:string;role:string;disabled:boolean;created_at?:number;owned_library_count?:number;active_job_count?:number;progress_count?:number;note_count?:number}
export interface ScanReport {discovered:number;imported:number;skipped:number;failed:number;formats:Record<string,{found:number;imported:number;skipped:number;failed:number}>;issues:(string|{name?:string;message?:string})[]}
export interface LibraryClient {get<T=any>(path:string):Promise<T>;post<T=any>(path:string,body?:unknown):Promise<T>;put<T=any>(path:string,body?:unknown):Promise<T>;send<T=any>(path:string,method:string,body?:unknown):Promise<T>;delete<T=any>(path:string):Promise<T>}
export function catalogKind(path:string):ContentKind|undefined{return path==='/shelves'?undefined:'book'}
export function bookKind(book:{content_kind?:string;format?:string}):ContentKind{return book.content_kind==='comic'||!book.content_kind&&book.format==='cbz'?'comic':'book'}
export function booksOfKind<T extends {content_kind?:string;format?:string}>(books:T[],kind?:ContentKind):T[]{return kind?books.filter(book=>bookKind(book)===kind):books}
export function readableLibraries(libs:LibraryRef[],kind?:ContentKind):LibraryRef[]{return libs.filter(lib=>lib.can_read&&!lib.archived&&(!kind||lib.content_kind===kind))}
export function contributionLibraries(libs:LibraryRef[],kind:ContentKind):LibraryRef[]{return readableLibraries(libs,kind).filter(lib=>lib.can_contribute)}
export function defaultLibraryID(libs:LibraryRef[],user:number,kind:ContentKind):number{return contributionLibraries(libs,kind).find(lib=>lib.is_personal_default&&lib.owner_user_id===user)?.id??0}
export function createLibraryApi(client:LibraryClient){return {
 users:(q='',page=1,page_size=20)=>client.get<{items:ManagedUser[];total:number}>(`/users?${new URLSearchParams({q,page:String(page),page_size:String(page_size)})}`),
 directory:(q='',page=1,page_size=20)=>client.get<{items:{id:number;username:string}[];total:number}>(`/member-directory?${new URLSearchParams({q,page:String(page),page_size:String(page_size)})}`),
 user:(id:number)=>client.get<ManagedUser>(`/users/${id}`),
 updateUser:(id:number,body:unknown)=>client.send<ManagedUser>(`/users/${id}`,'PATCH',body),
 libraries:(manage=false,archived=false)=>client.get<{items:LibraryRef[];total?:number}>('/libraries'+(manage||archived?'?'+new URLSearchParams({...(manage?{manage:'1'}:{}),...(archived?{archived:'1'}:{})}):'')),
 library:(id:number,manage=false)=>client.get<LibraryRef>(`/libraries/${id}${manage?'?manage=1':''}`),
 create:(body:{name:string;content_kind:ContentKind;storage_kind:'directory'|'virtual';visibility?:Visibility;path?:string})=>client.post<LibraryRef>('/libraries',body),
 update:(id:number,body:{name?:string;visibility?:Visibility})=>client.send<LibraryRef>(`/libraries/${id}`,'PATCH',body),
 grants:(id:number)=>client.get<{grants:LibraryGrant[]}>(`/libraries/${id}/permissions`),
 saveGrants:(id:number,grants:LibraryGrant[])=>client.put<{grants:LibraryGrant[]}>(`/libraries/${id}/permissions`,{grants:grants.map(({user_id,permission})=>({user_id,permission}))}),
 archive:(id:number)=>client.delete<void>(`/libraries/${id}`),restore:(id:number)=>client.post<LibraryRef>(`/libraries/${id}/restore`),
};}
export function scanReportText(report:ScanReport):string{return `发现 ${report.discovered} · 导入 ${report.imported} · 跳过 ${report.skipped} · 失败 ${report.failed}${report.imported===0?' · 本次没有导入内容':''}`}
