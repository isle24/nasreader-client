export interface EpubCoverBook {sections?:{id?:string;linear?:string}[];landmarks?:{type?:string[];href?:string}[];resolveHref?:(href:string)=>{index:number}|null}
/** Cover images and filenames do not prove that a spine section is a cover. */
export function declaredCoverSections(book:EpubCoverBook):number[]{
 const indexes:number[]=[];for(const landmark of book.landmarks??[]){if(!landmark.type?.includes('cover')||!landmark.href)continue;try{const index=book.resolveHref?.(landmark.href)?.index;if(index!==undefined&&index>=0&&index<(book.sections?.length??0)&&!indexes.includes(index))indexes.push(index)}catch{/* malformed declaration does not create a synthetic page */}}
 return indexes;
}
export function shouldShowIntroduction(state:{desktop:boolean;firstEntry:boolean;declaredCover:boolean;resuming:boolean}):boolean{return state.desktop&&(state.declaredCover||state.firstEntry&&!state.resuming)}
export function keepPageArrows(state:{hover?:boolean;focus?:boolean;panel?:boolean;selection?:boolean}):boolean{return !!(state.hover||state.focus||state.panel||state.selection)}
export interface DocumentInteraction {kind:'tap'|'key'|'pointer'|'wheel';x?:number;y?:number;key?:string;deltaY?:number;ctrlKey?:boolean;metaKey?:boolean;selection?:boolean}
export interface DocumentInfo {sections:number;coverSections:number[];bodySection:number;currentSection:number;onCover:boolean}
