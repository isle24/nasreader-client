import {openDB} from 'idb';import {cacheKey} from '../reader/core';import type {Book,Chapter} from './client';
export type Snapshot={book:Book,chapters:Chapter[],texts:Record<number,string>,file?:Blob,progress?:any,notes?:any[]};

/**
 * IndexedDB stores data with the structured clone algorithm, which rejects Vue's
 * reactive Proxy objects ("could not be cloned"). Callers pass reactive books and
 * notes, so every record is converted to plain objects first. Blobs / typed arrays /
 * Dates are preserved so the downloaded EPUB and PDF bytes survive the copy.
 */
export function toPlain<T>(value:T):T{
  if(value===null||typeof value!=='object')return value;
  if(typeof Blob!=='undefined'&&value instanceof Blob)return value;
  if(typeof ArrayBuffer!=='undefined'&&(value instanceof ArrayBuffer||ArrayBuffer.isView(value)))return value;
  if(value instanceof Date)return value;
  if(Array.isArray(value))return value.map(item=>toPlain(item)) as unknown as T;
  const out:Record<string,unknown>={};
  for(const [key,item] of Object.entries(value as Record<string,unknown>))out[key]=toPlain(item);
  return out as T;
}

const db=()=>openDB('nasreader-private-v1',1,{upgrade(d){d.createObjectStore('books');d.createObjectStore('queue',{keyPath:'id',autoIncrement:true})}});
export async function saveBook(server:string,user:number,book:Book,data:Omit<Snapshot,'book'>){await(await db()).put('books',toPlain({...data,book}),cacheKey(server,user,book.id,book.hash))}
export async function loadBook(server:string,user:number,book:number,version:string):Promise<Snapshot|undefined>{return(await db()).get('books',cacheKey(server,user,book,version))}
export async function cachedBooks(server:string,user:number):Promise<Snapshot[]>{const d=await db();const keys=await d.getAllKeys('books');const records:Snapshot[]=[];for(const key of keys){const [s,u]=JSON.parse(String(key));if(s===server&&u===user)records.push(await d.get('books',key))}return records}
export async function queueMutation(server:string,user:number,path:string,method:string,body:any){return Number(await(await db()).add('queue',toPlain({server,user,path,method,body})))}
export async function pendingMutations(server:string,user:number){return(await(await db()).getAll('queue')).filter(x=>x.server===server&&x.user===user)}
export async function removeMutation(id:number){await(await db()).delete('queue',id)}
export async function clearCached(server:string,user:number){const d=await db();for(const key of await d.getAllKeys('books')){const[s,u]=JSON.parse(String(key));if(s===server&&u===user)await d.delete('books',key)}}

export async function removeCachedBooks(server:string,user:number,ids:number[]){const denied=new Set(ids),d=await db();for(const key of await d.getAllKeys('books')){const[s,u,id]=JSON.parse(String(key));if(s===server&&u===user&&denied.has(id))await d.delete('books',key)}}
