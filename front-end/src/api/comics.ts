import type {ApiClient} from './client';
export interface ComicPage {index:number;width:number;height:number;mime_type:string;size:number}
export interface ComicManifest {book_id:number;edition:string;total:number;direction:'ltr'|'rtl';pages:ComicPage[];next_cursor:number|null}
export const comicPages=(api:ApiClient,id:number,cursor:number,signal:AbortSignal)=>api.request<ComicManifest>(`/books/${id}/comic/pages?cursor=${cursor}&limit=100`,{signal});
export const comicImage=(api:ApiClient,id:number,page:number,edition:string,signal:AbortSignal,thumbnail=false)=>api.request<Blob>(`/books/${id}/comic/pages/${page}/${thumbnail?'thumbnail':'image'}?edition=${encodeURIComponent(edition)}`,{signal,headers:{Accept:'application/octet-stream'}});
