export interface ComicDocumentBook {format:string;reader_mode?:string;document_format?:string}
export function comicDocumentMode(book:ComicDocumentBook):boolean{return book.format==='pdf'||book.reader_mode==='document'}
export function comicDocumentFormat(book:ComicDocumentBook):string{return book.document_format||(book.format==='pdf'?'pdf':'epub')}
export function encodeComicProgress(position:{edition:string;page:number;y:number;document_locator?:string}):string|null{const raw=JSON.stringify({type:'comic',version:1,...position});return new TextEncoder().encode(raw).length<=2048?raw:null}
