import {sentences} from './core';
export interface DocumentSpeechPart {text:string;locator:string;range?:Range}
export function pdfSpeechText(items:any[]):string{return items.filter(x=>typeof x.str==='string').map(x=>x.str+(x.hasEOL?'\n':' ')).join('').trim()}
export function serverSpeechVoice(voice:string):string{return /^[a-z]{2}-[A-Z]{2}-[\w-]+Neural$/.test(voice)?voice:''}
/** Read only visible body text, never executable/style/navigation content. Keep
 * original DOM ranges so highlighting and saved CFIs refer to the actual EPUB. */
export function epubSpeechParts(doc:Document,index:number,getCFI:(index:number,range:Range)=>string,start?:Range,root:Element=doc.body):DocumentSpeechPart[]{
 const walker=doc.createTreeWalker(root,4,{acceptNode(node){
  const el=node.parentElement;
  if(!node.textContent?.trim()||el?.closest('script,style,noscript,nav,[hidden],[aria-hidden="true"]'))return 2;
  if(el&&doc.defaultView){const style=doc.defaultView.getComputedStyle(el);if(style.display==='none'||style.visibility==='hidden')return 2}
  return 1;
 }});
 const nodes:Text[]=[];let node:Node|null;
 while((node=walker.nextNode()))nodes.push(node as Text);
 const result:DocumentSpeechPart[]=[];
 // Segment each paragraph independently; inline markup stays together.
 const blocks=new Map<Element,Text[]>();
 for(const text of nodes){const block=text.parentElement?.closest('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div')??root;const group=blocks.get(block)??[];group.push(text);blocks.set(block,group)}
 for(const group of blocks.values()){
  const text=group.map(n=>n.data).join('');let offset=0;
  for(const sentence of sentences(text)){
   if(!sentence.trim())continue;
   const begin=text.indexOf(sentence,offset);if(begin<0)continue;const end=begin+sentence.length;offset=end;
   const range=doc.createRange();let sum=0;
   for(const n of group){if(begin>=sum&&begin<sum+n.length)range.setStart(n,begin-sum);if(end>sum&&end<=sum+n.length){range.setEnd(n,end-sum);break}sum+=n.length}
   if(start&&start.startContainer.ownerDocument===doc&&(()=>{const boundary=start.cloneRange();boundary.collapse(true);return range.compareBoundaryPoints(2,boundary)<=0})())continue;
   result.push({text:sentence,locator:'e:'+getCFI(index,range),range});
  }
 }
 return result;
}
