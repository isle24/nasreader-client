export interface ComicLocator {type:'comic';version:1;edition:string;page:number;y:number;document_locator?:string}
export function parseComicLocator(raw:string,edition:string,total=Number.MAX_SAFE_INTEGER):ComicLocator|null {try{const l=JSON.parse(raw);return l.type==='comic'&&l.version===1&&l.edition===edition&&Number.isSafeInteger(l.page)&&l.page>=1&&l.page<=total&&Number.isFinite(l.y)&&l.y>=0&&l.y<=1?l:null}catch{return null}}
export function comicPercent(page:number,y:number,total:number){return Math.max(0,Math.min(1,(page-1+y)/Math.max(1,total)))}
export function nextComicPage(page:number,total:number,direction:'ltr'|'rtl',swipe:'left'|'right'){return Math.max(1,Math.min(total,page+((swipe==='left')===(direction==='ltr')?1:-1)))}
export function canComicSwipe(touches:number,zoom:number,pinched:boolean){return touches===1&&zoom===1&&!pinched}
export function comicWindow(page:number,total:number,radius=1){return Array.from({length:Math.min(total,page+radius)-Math.max(1,page-radius)+1},(_,i)=>Math.max(1,page-radius)+i)}
export function comicScrollTop(offsets:number[],page:number,y:number){const start=offsets[page-1]??0;return start+Math.max(0,Math.min(1,y))*Math.max(1,(offsets[page]??start+1)-start)}
export function comicScrollPosition(offsets:number[],top:number){let page=1;while(page<offsets.length-1&&offsets[page]<=top)page++;const start=offsets[page-1]??0;return {page,y:Math.max(0,Math.min(1,(top-start)/Math.max(1,(offsets[page]??start+1)-start)))}}
