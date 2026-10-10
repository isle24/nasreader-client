<script setup lang="ts">
// EPUB (foliate-js) and PDF (pdfjs-dist) rendering.
//
// Reading settings are applied here so they survive on fixed-format books too:
// typography and colors are injected into the EPUB document and foliate's flow is
// switched between paginated and scrolled; PDFs keep their page layout, adapt to the
// night theme by inverting the canvas, and render viewport-fitted book spreads or
// lazily while scrolling. The optional book layout leaves comic PDFs single-page.
import {ref,computed,onMounted,onBeforeUnmount,nextTick,watch} from 'vue';
import * as pdfjs from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'foliate-js/view.js';
import {readerSettings} from '../reader/core';
import {epubStyleSheet,pdfCanvasFilter} from '../reader/settings';
import {isTap,type TouchPoint} from '../reader/gestures';
import {epubSpeechParts,pdfSpeechText,type DocumentSpeechPart} from '../reader/documentSpeech';
import {sentences} from '../reader/core';
import {declaredCoverSections,type DocumentInteraction,type DocumentInfo} from '../reader/desktop';
import {pdfAssetOptions} from '../reader/pdfAssets';
import {pdfBlobBytes} from '../reader/pdfBlob';
import {pdfSpreadColumns,pdfPageRange,pdfTurnPage,pdfCachePages,fitPDFSpread,containPDFPage,pdfRasterSize,type PDFLayout} from '../reader/pdfSpread';
import {pdfViewZoom,pdfViewRotation,pdfViewPan,pdfZoomAnchor,pdfViewRaster,type PDFPoint} from '../reader/pdfViewing';

const props=withDefaults(defineProps<{file:Blob;format:string;locator:string;theme:string;size:number;lineHeight:number;font:string;mode:string;wheelZoom?:'paginated'|'scroll';pdfLayout?:PDFLayout;showTools?:boolean}>(),{pdfLayout:'single',showTools:true});
const emit=defineEmits<{progress:[{locator:string;percent:number;chapter_idx:number;page_start?:number;page_end?:number;total_pages?:number}];error:[string];toc:[any[]];selection:[any];interaction:[DocumentInteraction];documentInfo:[DocumentInfo];speechReady:[{busy:boolean;available:boolean;reason:string}];toolsActive:[boolean];revealTools:[]}>();
const root=ref<HTMLElement|null>(null),busy=ref(true),pages=ref(0),page=ref(1);
let pdf:any,pdfLoadingTask:ReturnType<typeof pdfjs.getDocument>|undefined,epub:any,closed=false,ticking=false,sectionIndex=-1,epubStyleTimer:ReturnType<typeof setTimeout>|undefined;
let frameTouchStart:TouchPoint|null=null,frameTouchAt=0,lastFrameTouchAt=0;
const sheets=new Map<number,HTMLElement>(),canvases=new Map<number,HTMLCanvasElement>(),rendered=new Set<number>();
let observer:IntersectionObserver|undefined;
let speechParts:DocumentSpeechPart[]=[],speechSection=-1;
const pdfTexts=ref<Record<number,string[]>>({}),activeSpeech=ref(-1);
const textLayers=new Map<number,HTMLElement>(),pdfParts=new Map<number,DocumentSpeechPart[]>();
function setTextLayer(n:number,el:any){if(el)textLayers.set(n,el);else textLayers.delete(n)}
let speechRevision=0,coverSections:number[]=[],bodySection=0;
const pdfWidth=ref(0),pdfHeight=ref(0),finePointer=ref(false);
const pdfViewport=ref<HTMLElement|null>(null),pdfTools=ref<HTMLElement|null>(null),pdfToolsHeight=ref(48);
const pdfZoom=ref(1),pdfPan=ref<PDFPoint>({x:0,y:0}),pdfRotations=ref<Record<number,number>>({});
const bookPDF=computed(()=>props.format==='pdf'&&props.pdfLayout==='book');
const pdfSingleHeight=ref(Number.POSITIVE_INFINITY);
const bookPagination=computed(()=>props.pdfLayout==='book'&&props.mode==='paginated');
const pdfColumns=computed(()=>pdfSpreadColumns(props.pdfLayout,props.mode,finePointer.value,pdfWidth.value,pages.value));
const pdfRange=computed(()=>pdfPageRange(page.value,pages.value,pdfColumns.value));
const mountedPDFPages=computed(()=>props.mode==='scroll'?Array.from({length:pages.value},(_,i)=>i+1):pdfCachePages(page.value,pages.value,pdfColumns.value));
const pdfViewHeight=computed(()=>Math.max(1,pdfHeight.value-(bookPDF.value?pdfToolsHeight.value:0)));
const pdfFit=computed(()=>fitPDFSpread(pdfWidth.value,pdfViewHeight.value,pdfColumns.value));
const pdfBookFit=computed(()=>bookPagination.value?pdfFit.value:fitPDFSpread(pdfWidth.value,Number.MAX_SAFE_INTEGER,1));
const pdfPaperStyle=computed(()=>bookPDF.value?{width:pdfBookFit.value.paperWidth*pdfZoom.value+'px',height:pdfBookFit.value.paperHeight*pdfZoom.value+'px'}:{});
const pdfSpreadStyle=computed(()=>{
 if(!bookPDF.value)return {};
 const fit=pdfBookFit.value,zoom=pdfZoom.value;
 const scrollWidth=Math.max(pdfWidth.value,fit.paperWidth*zoom+fit.padding*2);
 // Both reading modes use a centered plane, so the shared symmetric pan limits
 // and cursor-relative zoom anchor can reach every edge of an oversized page.
 return bookPagination.value?{gap:fit.gap*zoom+'px',padding:fit.padding+'px',width:Math.max(pdfWidth.value,(fit.paperWidth*pdfColumns.value+fit.gap)*zoom+fit.padding*2)+'px',height:Math.max(pdfViewHeight.value,fit.paperHeight*zoom+fit.padding*2)+'px',transform:`translate(-50%,-50%) translate(${pdfPan.value.x}px,${pdfPan.value.y}px)`}:{width:scrollWidth+'px',transform:`translateX(${(pdfWidth.value-scrollWidth)/2+pdfPan.value.x}px)`,padding:fit.padding+'px'};
});
const pdfToolPages=computed(()=>Array.from({length:pdfRange.value.end-pdfRange.value.start+1},(_,i)=>pdfRange.value.start+i));
const pdfContentStyles=ref<Record<number,Record<string,string>>>({});
interface PDFRenderJob{generation:number;promise:Promise<void>;raster?:{cancel():void;promise:Promise<unknown>};text?:InstanceType<typeof pdfjs.TextLayer>}
const pdfJobs=new Map<number,PDFRenderJob>();
let pdfRasterJobs=0;const pdfRasterWaiters:Array<()=>void>=[];
async function acquirePDFRaster(){while(pdfRasterJobs>=2)await new Promise<void>(resolve=>pdfRasterWaiters.push(resolve));++pdfRasterJobs;return()=>{--pdfRasterJobs;pdfRasterWaiters.shift()?.()}}
let pdfGeneration=0,pdfNavigation=0,pdfScrollTarget:number|undefined,pdfResize:ResizeObserver|undefined,pdfSizingObserver:MutationObserver|undefined,pdfSizingSignature='',pdfResizeFrame=0,fineMedia:MediaQueryList|undefined;
let pdfOpenRevision=0,pdfViewFrame=0,pdfPreserveScroll:number|undefined,pdfIgnoreClickUntil=0;
const pdfPointers=new Map<number,PDFPoint>();
let pdfPointerStart:PDFPoint|undefined,pdfPointerPan:PDFPoint={x:0,y:0},pdfPointerScroll=0,pdfPinchDistance=0,pdfPinchZoom=1,pdfDragging=false;
let pdfToolsHover=false,pdfToolsFocus=false,pdfToolsActive=false;
function publishPDFToolsActivity(){const active=bookPDF.value&&props.showTools&&(pdfToolsHover||pdfToolsFocus);if(active!==pdfToolsActive){pdfToolsActive=active;emit('toolsActive',active)}}
function hoverPDFTools(value:boolean){pdfToolsHover=value;publishPDFToolsActivity()}
function focusPDFTools(event:FocusEvent){pdfToolsFocus=event.type==='focusin'||!!pdfTools.value?.contains(event.relatedTarget as Node|null);publishPDFToolsActivity()}
function resetPDFToolsActivity(){pdfToolsHover=false;pdfToolsFocus=false;publishPDFToolsActivity()}
function onPDFToolsKey(event:KeyboardEvent){if(event.key!=='Escape')event.stopPropagation()}
pdfjs.GlobalWorkerOptions.workerSrc=workerURL;

const settings=()=>readerSettings({theme:props.theme as any,size:props.size,lineHeight:props.lineHeight,font:props.font,mode:props.mode==='scroll'?'scroll':'paginated'});

/* ---------- PDF ---------- */

function setSheet(n:number,el:any){if(el)sheets.set(n,el as HTMLElement);else sheets.delete(n)}
function setCanvas(n:number,el:any){if(el){if(bookPDF.value&&canvases.get(n)!==el){el.width=0;el.height=0;el.dataset.rendered='false'}canvases.set(n,el as HTMLCanvasElement)}else canvases.delete(n)}
function emitProgress(){if(props.format==='pdf'&&pages.value)emit('progress',{locator:'p:'+page.value,percent:page.value/pages.value,chapter_idx:page.value-1,page_start:pdfRange.value.start,page_end:pdfRange.value.end,total_pages:pages.value})}
function cancelPDFPage(n:number){
 const job=pdfJobs.get(n);pdfJobs.delete(n);
 try{job?.raster?.cancel()}catch{/* completed render */}
 try{job?.text?.cancel()}catch{/* completed text layer */}
 rendered.delete(n);pdfParts.delete(n);delete pdfTexts.value[n];delete pdfContentStyles.value[n];
 const canvas=canvases.get(n);if(canvas){canvas.width=0;canvas.height=0;canvas.dataset.rendered='false'}
 textLayers.get(n)?.replaceChildren();
}
function invalidatePDF(){
 ++pdfGeneration;
 for(const n of new Set([...pdfJobs.keys(),...rendered]))cancelPDFPage(n);
 // Ranges belong to the old text nodes; their text/locators remain usable by TTS.
 const active=activeSpeech.value;clearSpeechHighlight();activeSpeech.value=active;speechParts=speechParts.map(({range,...part})=>part);
 for(const canvas of canvases.values())canvas.dataset.rendered='false';
 for(const layer of textLayers.values())layer.replaceChildren();
}
function renderPage(n:number):Promise<void>{
 if(!pdf||closed||rendered.has(n))return Promise.resolve();
 const existing=pdfJobs.get(n);if(existing)return existing.promise;
 const canvas=canvases.get(n),layer=textLayers.get(n);
 if(!canvas||!layer)return Promise.resolve();
 const generation=pdfGeneration,book=bookPDF.value,fit=pdfBookFit.value;
 const visible=n>=pdfRange.value.start&&n<=pdfRange.value.end,zoom=book?pdfZoom.value:1,userRotation=book?pdfRotations.value[n]||0:0;
 const width=pdfWidth.value||root.value?.clientWidth||800,singleHeight=pdfSingleHeight.value;
 const job:PDFRenderJob={generation,promise:Promise.resolve()};
 const current=()=>!closed&&generation===pdfGeneration&&pdfJobs.get(n)===job&&canvases.get(n)===canvas&&textLayers.get(n)===layer;
 pdfJobs.set(n,job);
 job.promise=(async()=>{
  let staging:HTMLCanvasElement|undefined,releaseRaster:(()=>void)|undefined;
  try{
   const pdfPage=await pdf.getPage(n);if(!current())return;
   const textContent=await pdfPage.getTextContent();if(!current())return;
   const rotation=pdfViewRotation(pdfPage.rotate||0,userRotation),base=pdfPage.getViewport({scale:1,rotation});
   const contained=book?containPDFPage(base.width,base.height,fit.contentWidth,fit.contentHeight):containPDFPage(base.width,base.height,width,singleHeight);
   const scale=book?contained.scale*zoom:Math.min(2.5,contained.scale);
   const viewport=pdfPage.getViewport({scale,rotation}),rasterSize=book?pdfViewRaster(viewport.width/(visible?1:zoom),viewport.height/(visible?1:zoom),window.devicePixelRatio,visible):pdfRasterSize(viewport.width,viewport.height,window.devicePixelRatio);
   const rasterDPR=rasterSize.dpr/(book&&!visible?zoom:1);
   // Render into a private canvas. Cancellation/rapid resize never causes two
   // PDF.js tasks to draw concurrently on a mounted or recycled canvas.
   releaseRaster=await acquirePDFRaster();if(!current())return;
   staging=document.createElement('canvas');staging.width=rasterSize.width;staging.height=rasterSize.height;
   const raster=pdfPage.render({canvas:staging,viewport,transform:[rasterDPR,0,0,rasterDPR,0,0]});job.raster=raster;
   await raster.promise;if(!current())return;
   const contents=document.createElement('div');contents.className='pdf-text-contents';
   contents.style.setProperty('--total-scale-factor',String(scale));
   job.text=new pdfjs.TextLayer({textContentSource:textContent,container:contents,viewport});
   await job.text.render();if(!current())return;
   // TextLayer uses unrotated raw coordinates. Its inner plane rotates inside
   // an outer box whose offset and dimensions exactly match the painted canvas.
   contents.style.width=viewport.rawDims.pageWidth*scale+'px';
   contents.style.height=viewport.rawDims.pageHeight*scale+'px';
   const left=book?(fit.pagePadding+contained.left)*zoom:Math.max(0,(width-viewport.width)/2);
   const top=book?(fit.pagePadding+contained.top)*zoom:0;
   pdfContentStyles.value[n]={width:viewport.width+'px',height:viewport.height+'px',left:left+'px',top:top+'px'};
   await nextTick();if(!current())return;
   canvas.width=rasterSize.width;canvas.height=rasterSize.height;
   // External comic fit-height CSS is accounted for in the viewport itself.
   // Both dimensions stay explicit so DPR and max-height cannot distort one axis.
   canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
   canvas.getContext('2d')?.drawImage(staging,0,0);
   layer.style.width=viewport.width+'px';layer.style.height=viewport.height+'px';
   layer.style.left=book?'0':left+'px';layer.style.top='0';
   layer.replaceChildren(contents);
   pdfTexts.value[n]=sentences(pdfSpeechText(textContent.items));
   const parts=epubSpeechParts(document,n,(_i,r)=>String(r.startOffset),undefined,layer).map((part,i)=>({...part,locator:`p:${n}:s:${i}`}));
   pdfParts.set(n,parts);if(speechSection===n&&speechParts.length)speechParts=speechParts.map(part=>parts.find(fresh=>fresh.locator===part.locator)??part);
   if(speechSection===n&&activeSpeech.value>=0&&speechParts[activeSpeech.value]?.range)setRangeHighlight(speechParts[activeSpeech.value]!.range!);
   rendered.add(n);canvas.dataset.rendered='true';
   if(pdfPreserveScroll!==undefined)restorePDFScrollAnchor();else alignPDFScrollTarget();
  }catch(e:any){if(current()&&e?.name!=='RenderingCancelledException'&&e?.name!=='AbortException')emit('error','PDF 页面渲染失败：'+(e?.message??e))}
  finally{if(staging){staging.width=0;staging.height=0}releaseRaster?.();if(pdfJobs.get(n)===job)pdfJobs.delete(n)}
 })();
 return job.promise;
}
async function renderPDFPosition(){
 if(closed||!pdf)return;
 if(bookPagination.value&&(pdfWidth.value<=0||pdfHeight.value<=0))return;
 const generation=pdfGeneration;
 if(props.mode==='scroll')watchSheets();
 const wanted=new Set(bookPDF.value?pdfCachePages(page.value,pages.value,pdfColumns.value):mountedPDFPages.value);
 for(const n of new Set([...rendered,...pdfJobs.keys()]))if(!wanted.has(n))cancelPDFPage(n);
 const {start,end}=pdfRange.value;
 await Promise.all(Array.from({length:end-start+1},(_,i)=>renderPage(start+i)));
 // Prefetch remains inside the same bounded page window.
 if(!closed&&generation===pdfGeneration)void(async()=>{for(const n of wanted){if(closed||generation!==pdfGeneration)return;if(n<start||n>end)await renderPage(n)}})();
}
function pdfScrollContainer(){return bookPDF.value?pdfViewport.value:root.value}
function pdfScrollAnchor(){const container=pdfScrollContainer(),sheet=sheets.get(page.value);return container&&sheet?(container.getBoundingClientRect().top-sheet.getBoundingClientRect().top)/Math.max(1,sheet.offsetHeight):0}
function restorePDFScrollAnchor(){
 const container=pdfScrollContainer(),sheet=sheets.get(page.value);if(!container||!sheet||pdfPreserveScroll===undefined)return;
 container.scrollTop+=sheet.getBoundingClientRect().top-container.getBoundingClientRect().top+pdfPreserveScroll*sheet.offsetHeight;
}
function clampPDFPan(point:PDFPoint){
 const fit=pdfBookFit.value,zoom=pdfZoom.value;
 return pdfViewPan(point,{width:(fit.paperWidth*pdfColumns.value+fit.gap)*zoom+fit.padding*2,height:props.mode==='scroll'?pdfViewHeight.value:fit.paperHeight*zoom+fit.padding*2},{width:pdfWidth.value,height:pdfViewHeight.value});
}
function resetPDFView(){pdfZoom.value=1;pdfPan.value={x:0,y:0};pdfPointers.clear();pdfPointerStart=undefined;pdfDragging=false}
function schedulePDFView(n?:number){
 if(closed||!bookPDF.value)return;
 if(props.mode==='scroll'){pdfPreserveScroll=pdfScrollAnchor();pdfScrollTarget=undefined}
 if(n===undefined)invalidatePDF();else cancelPDFPage(n);
 cancelAnimationFrame(pdfViewFrame);const generation=pdfGeneration;
 pdfViewFrame=requestAnimationFrame(async()=>{
  pdfViewFrame=0;await nextTick();if(closed||generation!==pdfGeneration)return;
  if(props.mode==='scroll')restorePDFScrollAnchor();
  await renderPDFPosition();if(closed||generation!==pdfGeneration)return;
  restorePDFScrollAnchor();pdfPreserveScroll=undefined;await updateSpeechAvailability();
 });
}
function zoomPDF(value:number,anchor:PDFPoint={x:0,y:0}){
 const next=pdfViewZoom(value),previous=pdfZoom.value;if(!bookPDF.value||next===previous)return;
 // Capture the old source-page position before reactive sheet dimensions change.
 const scrollAnchor=props.mode==='scroll'?pdfScrollAnchor():undefined;
 pdfZoom.value=next;pdfPan.value=clampPDFPan(pdfZoomAnchor(pdfPan.value,previous,next,anchor));schedulePDFView();
 if(scrollAnchor!==undefined)pdfPreserveScroll=scrollAnchor;
}
function fitPDF(){if(!bookPDF.value)return;const anchor=props.mode==='scroll'?pdfScrollAnchor():undefined;resetPDFView();schedulePDFView();if(anchor!==undefined)pdfPreserveScroll=anchor}
function rotatePDF(n:number,reset=false){if(!bookPDF.value)return;pdfRotations.value[n]=reset?0:pdfViewRotation(0,(pdfRotations.value[n]||0)+90);schedulePDFView(n)}
function onPDFWheel(event:WheelEvent){
 if(!bookPDF.value){releasePDFScrollTarget();return}
 if(isInteractiveTarget(event.target))return;
 if(props.mode==='scroll'&&!event.ctrlKey&&!event.metaKey){releasePDFScrollTarget();pdfPreserveScroll=undefined;return}
 event.preventDefault();event.stopPropagation();
 const box=pdfViewport.value?.getBoundingClientRect();zoomPDF(pdfZoom.value*Math.exp(-Math.max(-240,Math.min(240,event.deltaY))*0.002),box?{x:event.clientX-box.left-box.width/2,y:event.clientY-box.top-box.height/2}:{x:0,y:0});
}
function onPDFPointerDown(event:PointerEvent){
 releasePDFScrollTarget();if(!bookPDF.value||isInteractiveTarget(event.target)||event.button!==0||event.shiftKey)return;
 if(event.pointerType==='mouse'&&pdfZoom.value<=1)return;
 const point={x:event.clientX,y:event.clientY};pdfPointers.set(event.pointerId,point);
 pdfPointerStart=point;pdfPointerPan={...pdfPan.value};pdfPointerScroll=pdfScrollContainer()?.scrollTop||0;
 if(pdfPointers.size===2){const [a,b]=[...pdfPointers.values()];pdfPinchDistance=Math.hypot(a!.x-b!.x,a!.y-b!.y);pdfPinchZoom=pdfZoom.value;pdfDragging=true;pdfIgnoreClickUntil=Date.now()+700}
 if(pdfZoom.value>1||pdfPointers.size>1){event.preventDefault();event.stopPropagation();try{pdfViewport.value?.setPointerCapture(event.pointerId)}catch{/* synthetic or released pointer */}}
}
function onPDFPointerMove(event:PointerEvent){
 if(!pdfPointers.has(event.pointerId))return;
 pdfPointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
 if(pdfPointers.size===2){
  const [a,b]=[...pdfPointers.values()],box=pdfViewport.value?.getBoundingClientRect();
  if(pdfPinchDistance>0)zoomPDF(pdfPinchZoom*Math.hypot(a!.x-b!.x,a!.y-b!.y)/pdfPinchDistance,box?{x:(a!.x+b!.x)/2-box.left-box.width/2,y:(a!.y+b!.y)/2-box.top-box.height/2}:{x:0,y:0});
  pdfDragging=true;
 }else if(pdfPointerStart&&pdfZoom.value>1){
  const dx=event.clientX-pdfPointerStart.x,dy=event.clientY-pdfPointerStart.y;
  if(Math.hypot(dx,dy)>4)pdfDragging=true;
  pdfPan.value=clampPDFPan({x:pdfPointerPan.x+dx,y:pdfPointerPan.y+dy});
  if(props.mode==='scroll'){pdfPreserveScroll=undefined;const container=pdfScrollContainer();if(container)container.scrollTop=pdfPointerScroll-dy}
 }
 if(pdfDragging||pdfZoom.value>1){event.preventDefault();event.stopPropagation();pdfIgnoreClickUntil=Date.now()+700}
}
function onPDFPointerUp(event:PointerEvent){
 if(!pdfPointers.has(event.pointerId))return;
 const stationary=event.type==='pointerup'&&pdfPointers.size===1&&!pdfDragging&&!pdfPinchDistance&&pdfZoom.value>1&&pdfPointerStart&&Math.hypot(event.clientX-pdfPointerStart.x,event.clientY-pdfPointerStart.y)<=4;
 // Reveal chrome directly. Letting a zoomed edge tap reach the parent's tap
 // classifier would turn the document instead of recovering hidden controls.
 if(stationary)emit('revealTools');
 pdfPointers.delete(event.pointerId);
 if(pdfDragging||pdfZoom.value>1){event.preventDefault();event.stopPropagation();pdfIgnoreClickUntil=Date.now()+700}
 if(!pdfPointers.size){pdfPointerStart=undefined;pdfDragging=false;pdfPinchDistance=0}
 else{pdfPointerStart=[...pdfPointers.values()][0];pdfPointerPan={...pdfPan.value};pdfPointerScroll=pdfScrollContainer()?.scrollTop||0}
}
function stopPDFGesture(event:Event){if(bookPDF.value&&(pdfZoom.value>1&&!(event instanceof MouseEvent&&event.shiftKey)||Date.now()<pdfIgnoreClickUntil)){event.stopPropagation();if(event.type==='click'){event.preventDefault();if(pdfZoom.value>1&&Date.now()>=pdfIgnoreClickUntil&&!window.getSelection()?.toString())emit('revealTools')}}}
function onPDFMouseUp(event:MouseEvent){stopPDFGesture(event);if(props.format==='pdf'&&!pdfDragging)selectPDFText()}
function singlePDFHeightLimit(){
 const container=root.value,canvas=container?.querySelector('canvas');if(!canvas)return Number.POSITIVE_INFINITY;
 const maxHeight=Number.parseFloat(getComputedStyle(canvas).maxHeight);
 if(!Number.isFinite(maxHeight)||maxHeight<=0)return Number.POSITIVE_INFINITY;
 // ComicReader supplies the external limit. Reserve its existing caption and
 // margins so a complete original page and its label fit the viewport together.
 const sheet=[...sheets.values()].find(el=>el.getClientRects().length),caption=sheet?.querySelector<HTMLElement>('.pdf-page');
 const cssNumber=(value:string|undefined)=>Number.parseFloat(value||'')||0;
 const captionStyle=caption?getComputedStyle(caption):undefined,sheetStyle=sheet?getComputedStyle(sheet):undefined;
 const captionHeight=(caption?.offsetHeight||0)+cssNumber(captionStyle?.marginTop)+cssNumber(captionStyle?.marginBottom);
 const margins=cssNumber(sheetStyle?.marginTop)+cssNumber(sheetStyle?.marginBottom);
 return Math.max(1,Math.min(maxHeight,container?.clientHeight||maxHeight)-captionHeight-margins);
}
function pdfSizingKey(height=singlePDFHeightLimit()){
 // An unconstrained single page determines its own natural root height. That
 // height change cannot alter width-fit geometry and must not cancel fresh text.
 const viewHeight=bookPagination.value||Number.isFinite(height)?root.value?.clientHeight:'';
 return `${root.value?.clientWidth}:${viewHeight}:${height}:${window.devicePixelRatio}`;
}
function measurePDF(){const el=root.value;if(el){pdfWidth.value=el.clientWidth;pdfHeight.value=el.clientHeight;pdfToolsHeight.value=el.clientWidth<800?96:48;pdfSingleHeight.value=singlePDFHeightLimit();pdfSizingSignature=pdfSizingKey(pdfSingleHeight.value)}}
function schedulePDFLayout(){
 if(closed||props.format!=='pdf')return;
 // Publish the new box before cancelling. A concurrent navigation must never
 // start a job with the new generation and the previous viewport dimensions.
 measurePDF();
 resetPDFView();pdfPreserveScroll=undefined;cancelAnimationFrame(pdfViewFrame);
 if(props.mode==='scroll')pdfScrollTarget=page.value;
 invalidatePDF();cancelAnimationFrame(pdfResizeFrame);
 pdfResizeFrame=requestAnimationFrame(async()=>{
  pdfResizeFrame=0;measurePDF();await nextTick();
  if(closed)return;
  await renderPDFPosition();if(closed)return;
  emitProgress();await updateSpeechAvailability();
 });
}
function focusPDFPage(n:number){
 if(n===page.value||props.mode==='scroll')return;
 page.value=n;emitProgress();void updateSpeechAvailability();
}
function onPDFSheetPointer(n:number,event:PointerEvent){if(!bookPDF.value||pdfZoom.value===1&&pdfPointers.size<2&&event.pointerType!=='touch')focusPDFPage(n)}
function alignPDFScrollTarget(){
 if(closed||props.mode!=='scroll'||pdfScrollTarget===undefined)return;
 // Nearby lazy pages can gain height after this page is ready. Re-anchor after
 // every committed layout, keeping an explicit navigation target exact in WebKit.
 const container=pdfScrollContainer(),sheet=sheets.get(pdfScrollTarget);
 if(container&&sheet)container.scrollTop+=sheet.getBoundingClientRect().top-container.getBoundingClientRect().top;
}
function releasePDFScrollTarget(){pdfScrollTarget=undefined}
function selectPDFText(){
 const selection=window.getSelection();if(!selection?.toString().trim()||!selection.rangeCount)return;
 const range=selection.getRangeAt(0);
 const start=(range.startContainer.parentElement?.closest('.pdf-sheet') as HTMLElement|null),end=(range.endContainer.parentElement?.closest('.pdf-sheet') as HTMLElement|null);
 if(!start||!end||!root.value?.contains(start)||!root.value.contains(end))return;
 const first=Number(start.dataset.page),last=Number(end.dataset.page);focusPDFPage(first);
 emit('selection',{quote:selection.toString(),start_locator:'p:'+first,end_locator:'p:'+last});
}
function updateVisiblePage(){
  const container=pdfScrollContainer();
  if(!container||props.mode!=='scroll'||pdfScrollTarget!==undefined||pdfPreserveScroll!==undefined)return;
  const top=container.getBoundingClientRect().top;
  let best=page.value;
  // Ref registration order changes as the paginated cache evicts/remounts pages.
  for(let n=1;n<=pages.value;n++){const sheet=sheets.get(n);if(sheet&&sheet.getBoundingClientRect().bottom>top+2){best=n;break}}
  if(best!==page.value){const previous=page.value;page.value=best;if(bookPDF.value){cancelPDFPage(previous);cancelPDFPage(best);void nextTick().then(renderPDFPosition)}emitProgress();void updateSpeechAvailability()}
}
function onScroll(){
  if(props.mode!=='scroll'||ticking)return;
  ticking=true;
  requestAnimationFrame(()=>{ticking=false;updateVisiblePage()});
}
async function showPage(n:number){
  const navigation=++pdfNavigation;
  const wanted=Math.max(1,Math.min(pages.value||1,n));
  const changed=wanted!==page.value;
  if(changed&&bookPDF.value){resetPDFView();pdfPreserveScroll=undefined;cancelAnimationFrame(pdfViewFrame);invalidatePDF()}
  page.value=wanted;
  if(props.mode==='scroll')pdfScrollTarget=wanted;
  await nextTick();if(closed||navigation!==pdfNavigation)return;
  if(changed||props.mode!=='scroll')emitProgress();
  await renderPDFPosition();if(closed||navigation!==pdfNavigation)return;
  await updateSpeechAvailability();
}
function watchSheets(){
  if(bookPDF.value)return; // Book placeholders have stable geometry; render only the bounded page window.
  if(observer||typeof IntersectionObserver==='undefined')return;
  observer=new IntersectionObserver(entries=>{
    for(const entry of entries)if(entry.isIntersecting)void renderPage(Number((entry.target as HTMLElement).dataset.page||0));
  },{root:root.value,rootMargin:'300px 0px'});
  for(const sheet of sheets.values())observer.observe(sheet);
}
async function openPDF(){
  const revision=++pdfOpenRevision;
  const bytes=await pdfBlobBytes(props.file);if(closed||revision!==pdfOpenRevision)return;
  const task=pdfjs.getDocument({data:bytes,...pdfAssetOptions()});pdfLoadingTask=task;
  let doc:any;
  try{doc=await task.promise}catch(error){if(closed||revision!==pdfOpenRevision)return;throw error}
  if(closed||revision!==pdfOpenRevision){await task.destroy();return}
  pdf=doc;pages.value=doc.numPages;
  emit('toc',Array.from({length:pages.value},(_,i)=>({title:'第 '+(i+1)+' 页',locator:'p:'+(i+1)})));
  // The parent validates restored positions against this actual page count.
  await nextTick();
  if(closed||revision!==pdfOpenRevision)return;
  const wanted=Math.max(1,Math.min(pages.value,Number(/^p:(\d+)/.exec(props.locator||'')?.[1])||1));
  page.value=wanted;
  if(props.mode==='scroll')pdfScrollTarget=wanted;
  await nextTick();
  measurePDF();await nextTick();if(closed||revision!==pdfOpenRevision)return;await renderPDFPosition();if(closed||revision!==pdfOpenRevision)return;
  if(props.mode==='scroll'){await nextTick();alignPDFScrollTarget()}
  emitProgress();
}

/* ---------- EPUB ---------- */

function applyEpubSettings(){
  if(closed)return;
  const renderer=epub?.renderer;
  if(!renderer)return;
  try{renderer.setStyles?.(epubStyleSheet(settings()))}catch{/* renderer mid-teardown */ }
  try{renderer.setAttribute?.('flow',props.mode==='scroll'?'scrolled':'paginated')}catch{/* older foliate */ }
}
/**
 * Typography sliders fire the watcher on every input event; foliate re-renders the
 * whole section on each style write, and switching `flow` while a render is in flight
 * makes its internal view race (a console-only null dereference). Debouncing keeps the
 * renderer out of that race without delaying the visible result noticeably.
 */
function scheduleEpubSettings(){clearTimeout(epubStyleTimer);epubStyleTimer=setTimeout(applyEpubSettings,60)}
function isInteractiveTarget(target:EventTarget|null){
  return Boolean((target as HTMLElement|null)?.closest?.('a,button,input,select,textarea,video,audio'));
}
function frameClientX(doc:Document|undefined,x:number){
  const frame=doc?.defaultView?.frameElement;
  return frame ? frame.getBoundingClientRect().left+x : x;
}
function frameClientY(doc:Document|undefined,y:number){const frame=doc?.defaultView?.frameElement;return frame?frame.getBoundingClientRect().top+y:y}
function onFramePointer(e:PointerEvent){emit('interaction',{kind:'pointer',x:frameClientX(e.view?.document,e.clientX),y:frameClientY(e.view?.document,e.clientY),selection:!!e.view?.getSelection()?.toString()})}
function onFrameWheel(e:WheelEvent){if(!props.wheelZoom||isInteractiveTarget(e.target)||props.wheelZoom==='scroll'&&!e.ctrlKey&&!e.metaKey)return;e.preventDefault();emit('interaction',{kind:'wheel',x:frameClientX(e.view?.document,e.clientX),y:frameClientY(e.view?.document,e.clientY),deltaY:e.deltaY,ctrlKey:e.ctrlKey,metaKey:e.metaKey})}
function publishDocumentInfo(){emit('documentInfo',{sections:epub?.book?.sections?.length??0,coverSections:[...coverSections],bodySection,currentSection:sectionIndex,onCover:coverSections.includes(sectionIndex)})}
function onFrameClick(e:MouseEvent){
  if(isInteractiveTarget(e.target)||Date.now()-lastFrameTouchAt<700)return;
  if(e.view?.getSelection()?.toString())return;
  emit('interaction',{kind:'tap',x:frameClientX(e.view?.document,e.clientX)});
}
function onFrameTouchStart(e:TouchEvent){
  const point=e.changedTouches[0];
  if(!point)return;
  lastFrameTouchAt=Date.now();frameTouchStart={x:point.clientX,y:point.clientY};frameTouchAt=Date.now();
}
function onFrameTouchEnd(e:TouchEvent){
  const start=frameTouchStart;frameTouchStart=null;
  const point=e.changedTouches[0];
  if(!start||!point)return;
  lastFrameTouchAt=Date.now();
  const end={x:point.clientX,y:point.clientY};
  if(e.view?.getSelection()?.toString())return;
  if(isTap(start,end,Date.now()-frameTouchAt))emit('interaction',{kind:'tap',x:frameClientX(e.view?.document,point.clientX)});
}
function onFrameKeyDown(e:KeyboardEvent){
  if(isInteractiveTarget(e.target))return;
  if(['ArrowLeft','ArrowRight','PageUp','PageDown',' ','Escape'].includes(e.key)){
    e.preventDefault();
    emit('interaction',{kind:'key',key:e.key});
  }
}
function bindFrameInteractions(doc:Document){
  doc.addEventListener('click',onFrameClick,true);doc.addEventListener('pointermove',onFramePointer,{passive:true});doc.addEventListener('wheel',onFrameWheel,{passive:false});
  doc.addEventListener('touchstart',onFrameTouchStart,{passive:true});
  doc.addEventListener('touchend',onFrameTouchEnd,{passive:true});
  doc.addEventListener('keydown',onFrameKeyDown);
}
async function openEPUB(){
  epub=document.createElement('foliate-view') as any;
  root.value?.append(epub);
  epub.addEventListener('relocate',(e:any)=>{
    const detail=e.detail??{};
    sectionIndex=detail.section?.current??sectionIndex;publishDocumentInfo();
    if(!busy.value)void updateSpeechAvailability();
    emit('progress',{locator:detail.cfi?'e:'+detail.cfi:'',percent:detail.fraction??0,chapter_idx:detail.section?.current??0});
  });
  epub.addEventListener('load',(e:any)=>{
    sectionIndex=e.detail?.index??0;
    applyEpubSettings();
    const doc=e.detail?.doc;
    if(doc)bindFrameInteractions(doc);
    doc?.addEventListener('mouseup',()=>{
      const selection=doc.getSelection();
      if(!selection?.toString().trim())return;
      let locator=props.locator;
      try{locator='e:'+epub.getCFI(sectionIndex,selection.getRangeAt(0))}catch{/* fall back to the current location */ }
      emit('selection',{quote:selection.toString(),start_locator:locator,end_locator:locator});
    });
  });
  await epub.open(new File([props.file],'book.epub',{type:'application/epub+zip'}));
  coverSections=declaredCoverSections(epub.book);const bodyLandmark=epub.book?.landmarks?.find((entry:any)=>entry.type?.includes('bodymatter')||entry.type?.includes('text'));const resolved=bodyLandmark?epub.book.resolveHref(bodyLandmark.href):null;bodySection=resolved?.index>=0?resolved.index:Math.max(0,epub.book.sections.findIndex((section:any,index:number)=>section.linear!=='no'&&!coverSections.includes(index)));publishDocumentInfo();
  emit('toc',epub.book?.toc??[]);
  await epub.init({showTextStart:true});
  const raw=(props.locator||'').startsWith('e:')?props.locator.slice(2):props.locator;
  if(raw&&/^epubcfi\(/.test(raw))await epub.goTo(raw);
  applyEpubSettings();
}

/* ---------- exposed controls ---------- */

async function next(){
  if(props.format==='pdf'){await showPage(pdfTurnPage(page.value,pages.value,pdfColumns.value,1));return}
  await epub?.next();
}
async function prev(){
  if(props.format==='pdf'){await showPage(pdfTurnPage(page.value,pages.value,pdfColumns.value,-1));return}
  await epub?.prev();
}
async function goTo(locator:string){
  if(!locator)return;
  if(props.format==='pdf'){await showPage(Number(/^p:(\d+)/.exec(locator)?.[1])||1);return}
  const raw=locator.startsWith('e:')?locator.slice(2):locator;
  await epub?.goTo(raw);
}
async function search(query:string){
  if(props.format==='epub'&&epub){
    const hits:any[]=[];
    for await(const item of epub.search({query})){
      if(item.subitems){for(const sub of item.subitems)hits.push({title:item.label,excerpt:sub.excerpt,locator:'e:'+sub.cfi})}
      else if(item.cfi)hits.push({title:item.label,excerpt:item.excerpt,locator:'e:'+item.cfi});
      if(hits.length>=200)break;
    }
    return hits;
  }
  const hits:any[]=[];
  for(let n=1;n<=pages.value;n++){
    const text=(await(await pdf.getPage(n)).getTextContent()).items.map((x:any)=>x.str??'').join(' ');
    if(text.includes(query))hits.push({title:'第 '+n+' 页',excerpt:text.slice(Math.max(0,text.indexOf(query)-25),text.indexOf(query)+80),locator:'p:'+n});
    if(hits.length>=200)break;
  }
  return hits;
}
/** Public foliate renderer contents provide the real document and section index.
 * Read from its current range; an image-only cover is skipped by section, never by
 * disabling all EPUB speech. PDF image-only pages remain explicitly unsupported. */
async function readSpeechParts(fromCurrent=true):Promise<DocumentSpeechPart[]>{
 if(props.format==='pdf'){
  const n=page.value;
  if(!pdf)return [];
  if(!pdfTexts.value[n])pdfTexts.value[n]=sentences(pdfSpeechText((await(await pdf.getPage(n)).getTextContent()).items));
  speechSection=n;
  const parts=pdfParts.get(n);return parts?.length?parts:pdfTexts.value[n]!.filter(text=>text.trim()).map((text,i)=>({text,locator:`p:${n}:s:${i}`}));
 }
 const contents=epub?.renderer?.getContents?.()??[];
 const item=contents.find((x:any)=>x.index===sectionIndex)??contents[0];
 if(!item?.doc)return [];
 speechSection=item.index;
 return epubSpeechParts(item.doc,item.index,(i,r)=>epub.getCFI(i,r),fromCurrent?epub.lastLocation?.range:undefined);
}
async function updateSpeechAvailability(){
 const revision=++speechRevision;
 try{
  const parts=await readSpeechParts(false);
  if(closed||revision!==speechRevision)return;
  // Covers may have no text: the start action searches later EPUB sections.
  emit('speechReady',{busy:busy.value,available:props.format==='epub'||parts.length>0,reason:parts.length?'':props.format==='pdf'?'本页为纯图片或没有文本层，暂不能朗读；请切换到有文字的页面。':''});
 }catch{if(!closed&&revision===speechRevision)emit('speechReady',{busy:busy.value,available:false,reason:'无法提取这一页的文字'})}
}
async function prepareSpeech(){
 speechParts=await readSpeechParts(true);
 if(props.format==='epub'){
  const count=epub?.book?.sections?.length??0;
  for(let tries=0;!speechParts.length&&tries<count;tries++){
   const current=speechSection;
   if(current+1>=count)break;
   await epub.goTo(current+1);
   speechParts=await readSpeechParts(false);
   if(speechSection===current)break;
  }
 }
 return speechParts;
}
async function continueSpeech(){
 clearSpeechHighlight();
 if(props.format==='pdf'){
  if(page.value>=pages.value)return [];
  await showPage(page.value+1);
  speechParts=await readSpeechParts(false);
 }else{
  const nextSection=speechSection+1;
  if(nextSection>=(epub?.book?.sections?.length??0))return [];
  await epub.goTo(nextSection);
  speechParts=await prepareSpeech();
 }
 return speechParts;
}
async function highlightSpeech(index:number){
 clearSpeechHighlight();activeSpeech.value=index;
 const part=speechParts[index];if(!part)return;
 if(props.format==='pdf'){
  await nextTick();
  if(part.range){setRangeHighlight(part.range);if(!bookPagination.value)part.range.startContainer.parentElement?.scrollIntoView({block:'nearest'})}
  emitProgress();
 }else if(part.range){
  setRangeHighlight(part.range);
  await epub.renderer.scrollToAnchor(part.range,true);
  emit('progress',{locator:part.locator,percent:epub.lastLocation?.fraction??0,chapter_idx:speechSection});
 }
}
function setRangeHighlight(range:Range){
 const doc=range.startContainer.ownerDocument!,win=doc.defaultView as any;
 if(win?.CSS?.highlights&&win.Highlight){
  if(!doc.getElementById('nasreader-speech-style')){const style=doc.createElement('style');style.id='nasreader-speech-style';style.textContent='::highlight(nasreader-speech){background:#ebd67f;color:#222}';doc.head.append(style)}
  win.CSS.highlights.set('nasreader-speech',new win.Highlight(range));
 }else{const selection=doc.getSelection();selection?.removeAllRanges();selection?.addRange(range)}
}
function clearSpeechHighlight(){
 (window as any).CSS?.highlights?.delete('nasreader-speech');
 activeSpeech.value=-1;
 for(const item of epub?.renderer?.getContents?.()??[]){const win=item.doc?.defaultView as any;win?.CSS?.highlights?.delete('nasreader-speech');item.doc?.getSelection()?.removeAllRanges()}
}
async function goToSection(index:number){if(props.format!=='pdf'&&Number.isSafeInteger(index)&&index>=0&&index<(epub?.book?.sections?.length??0))await epub.goTo(index)}
async function startText(){await goToSection(bodySection)}
defineExpose({next,prev,goTo,goToSection,startText,search,prepareSpeech,continueSpeech,highlightSpeech,clearSpeechHighlight});

/* ---------- lifecycle ---------- */

watch(()=>[props.theme,props.size,props.lineHeight,props.font],()=>scheduleEpubSettings());
watch(()=>[props.mode,props.pdfLayout],async()=>{
  resetPDFToolsActivity();
  scheduleEpubSettings();
  if(props.format==='pdf'){
    pdfScrollTarget=props.mode==='scroll'?page.value:undefined;
    observer?.disconnect();observer=undefined;
    schedulePDFLayout();await nextTick();
    if(props.mode==='scroll'){watchSheets();alignPDFScrollTarget()}
  }
});
watch(()=>props.showTools,()=>{if(!props.showTools)resetPDFToolsActivity()});
watch(()=>props.file,async()=>{
 if(props.format!=='pdf'||closed)return;
 const file=props.file,revision=++pdfOpenRevision;++pdfNavigation;cancelAnimationFrame(pdfViewFrame);invalidatePDF();resetPDFView();pdfRotations.value={};pdfPreserveScroll=undefined;pdfScrollTarget=undefined;
 const task=pdfLoadingTask;pdfLoadingTask=undefined;pdf=undefined;pages.value=0;busy.value=true;speechParts=[];speechSection=-1;clearSpeechHighlight();
 try{await task?.destroy();if(closed||revision!==pdfOpenRevision||file!==props.file)return;await openPDF();if(!closed&&file===props.file){busy.value=false;await updateSpeechAvailability()}}
 catch(e:any){if(!closed&&file===props.file)emit('error','PDF 打开失败：'+(e?.message??e))}
});
onMounted(async()=>{
  const file=props.file;
  try{
    if(props.format==='pdf'){
      fineMedia=window.matchMedia('(pointer:fine)');finePointer.value=fineMedia.matches;
      fineMedia.addEventListener('change',onFinePointerChange);
      measurePDF();pdfResize=new ResizeObserver(()=>{if(pdfSizingKey()!==pdfSizingSignature)schedulePDFLayout()});if(root.value)pdfResize.observe(root.value);
      // Fit controls change the parent's class without changing this root's box.
      // Observe only external root attributes, and compare actual constraints;
      // canvas/text style commits cannot trigger a self-invalidating loop.
      pdfSizingObserver=new MutationObserver(()=>{if(!closed&&pdfSizingKey()!==pdfSizingSignature)schedulePDFLayout()});
      if(root.value)pdfSizingObserver.observe(root.value,{attributes:true,attributeFilter:['class','style']});
      window.addEventListener('resize',schedulePDFLayout);
      await openPDF();
    }
    else await openEPUB();
  }catch(e:any){if(!closed&&file===props.file)emit('error',(props.format==='pdf'?'PDF':'EPUB')+' 打开失败：'+(e?.message??e))}
  finally{if(!closed&&file===props.file){busy.value=false;await updateSpeechAvailability()}}
});
onBeforeUnmount(()=>{
  resetPDFToolsActivity();closed=true;++pdfNavigation;++pdfOpenRevision;invalidatePDF();clearTimeout(epubStyleTimer);observer?.disconnect();pdfResize?.disconnect();pdfSizingObserver?.disconnect();cancelAnimationFrame(pdfResizeFrame);cancelAnimationFrame(pdfViewFrame);pdfPointers.clear();
  fineMedia?.removeEventListener('change',onFinePointerChange);window.removeEventListener('resize',schedulePDFLayout);
  try{epub?.close?.()}catch{/* already closed */ }
  try{epub?.remove?.()}catch{/* not attached */ }
  try{void pdfLoadingTask?.destroy()}catch{/* already destroyed */ }
});
function onFinePointerChange(){finePointer.value=fineMedia?.matches??false;schedulePDFLayout()}
</script>
<template>
<div ref="root" class="document-reader" :class="{'pdf-night':format==='pdf'&&theme==='night','pdf-book':bookPDF,'pdf-book-pagination':format==='pdf'&&bookPagination,'pdf-view-narrow':pdfWidth<800,'pdf-view-zoomed':bookPDF&&pdfZoom>1,scrolled:mode==='scroll'}" :style="bookPDF?{'--pdf-tools-height':pdfToolsHeight+'px'}:{}" :data-pdf-zoom="bookPDF?pdfZoom:undefined" :data-pdf-pan="bookPDF?`${pdfPan.x},${pdfPan.y}`:undefined" role="region" aria-label="文档内容" @scroll.passive="onScroll" @wheel="onPDFWheel" @touchstart.passive="releasePDFScrollTarget" @mousedown="stopPDFGesture" @click="stopPDFGesture" @keydown="releasePDFScrollTarget" @mouseup="onPDFMouseUp" @touchend="stopPDFGesture($event);format==='pdf'&&selectPDFText()">
<template v-if="format==='pdf'">
<div ref="pdfViewport" class="pdf-view-window" @scroll.passive="onScroll" @pointerdown="onPDFPointerDown" @pointermove="onPDFPointerMove" @pointerup="onPDFPointerUp" @pointercancel="onPDFPointerUp">
<div class="pdf-spread" :style="pdfSpreadStyle">
<div v-for="n in mountedPDFPages" :key="n" v-show="mode==='scroll'||n>=pdfRange.start&&n<=pdfRange.end" class="pdf-sheet" :style="pdfPaperStyle" :data-page="n" :data-user-rotation="bookPDF?(pdfRotations[n]||0):undefined" :aria-current="n===page?'page':undefined" :ref="el=>setSheet(n,el)" @pointerdown="onPDFSheetPointer(n,$event)">
<div class="pdf-content" :style="bookPDF?pdfContentStyles[n]:{}">
<canvas :ref="el=>setCanvas(n,el)" :style="{filter:pdfCanvasFilter(settings().theme)}" :aria-label="'第 '+n+' 页'"></canvas>
<div class="textLayer" :ref="el=>setTextLayer(n,el)" aria-label="页面文字" :data-speech-active="activeSpeech>=0&&n===page"></div>
</div>
<p class="pdf-page" role="status">第 {{n}} 页</p>
</div>
<div v-if="bookPagination&&pdfColumns===2&&pdfRange.start===pdfRange.end" class="pdf-blank" :style="pdfPaperStyle" aria-hidden="true"></div>
</div>
</div>
<div v-if="bookPDF" ref="pdfTools" class="pdf-tools-space">
<div v-if="showTools" class="pdf-tools" role="toolbar" aria-label="PDF 查看工具" @pointerenter="hoverPDFTools(true)" @pointerleave="hoverPDFTools(false)" @focusin="focusPDFTools" @focusout="focusPDFTools" @pointerdown.stop @pointerup.stop @mousedown.stop @mouseup.stop @click.stop @touchstart.stop @touchend.stop @keydown="onPDFToolsKey">
<div class="pdf-zoom-tools"><button type="button" aria-label="缩小 PDF" :disabled="pdfZoom<=1" @click="zoomPDF(pdfZoom/1.25)">−</button><output aria-label="PDF 缩放比例">{{Math.round(pdfZoom*100)}}%</output><button type="button" aria-label="放大 PDF" :disabled="pdfZoom>=4" @click="zoomPDF(pdfZoom*1.25)">+</button><button type="button" aria-label="适配 PDF" @click="fitPDF">适配</button></div>
<div v-for="n in pdfToolPages" :key="n" class="pdf-rotate-tools"><span>第 {{n}} 页</span><button type="button" :aria-label="'旋转第 '+n+' 页'" @click="rotatePDF(n)">↻</button><button type="button" :aria-label="'复原第 '+n+' 页'" :disabled="!pdfRotations[n]" @click="rotatePDF(n,true)">复原</button></div>
</div>
</div>
</template>
<p v-if="busy" class="reading-loading" role="status">{{format==='pdf'?'正在打开 PDF…':'正在打开 EPUB…'}}</p>
</div>
</template>

<style scoped>
.document-reader.pdf-book{width:auto;min-width:0}
.document-reader.pdf-book{overflow:hidden}
.pdf-view-window{display:contents}
.pdf-book .pdf-view-window{display:block;position:absolute;inset:0 0 var(--pdf-tools-height) 0;overflow:hidden;overscroll-behavior:contain;touch-action:none}
.pdf-book.scrolled .pdf-view-window{overflow-y:auto;touch-action:pan-y}
.pdf-book.scrolled.pdf-view-zoomed .pdf-view-window{touch-action:none}
.pdf-book.pdf-view-zoomed .pdf-view-window{cursor:grab}
.pdf-book.pdf-view-zoomed .pdf-view-window:active{cursor:grabbing}
.pdf-tools-space{position:absolute;left:0;right:0;bottom:0;height:var(--pdf-tools-height);font:13px/1.2 system-ui}
.pdf-tools{height:100%;display:flex;justify-content:center;align-items:center;gap:16px}
.pdf-zoom-tools,.pdf-rotate-tools{display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
.pdf-tools button{min-height:44px;min-width:44px;padding:6px 10px;font:14px/1 system-ui}
.pdf-zoom-tools output{min-width:42px;font-variant-numeric:tabular-nums}
.pdf-view-narrow .pdf-tools{flex-wrap:wrap;align-content:center;gap:2px 8px}
.pdf-view-narrow .pdf-zoom-tools{width:100%}
.pdf-book.scrolled .pdf-spread{box-sizing:border-box}
.pdf-book.scrolled .pdf-sheet{margin:0 auto 12px;flex:none;max-width:none;background:#fff;box-shadow:0 1px 5px #0002}
.pdf-content{display:contents}.pdf-sheet{position:relative}
.pdf-book-pagination{overflow:hidden}
.pdf-book-pagination .pdf-spread{position:absolute;left:50%;top:50%;display:flex;align-items:center;justify-content:center;box-sizing:border-box;will-change:transform}
.pdf-book-pagination .pdf-sheet,.pdf-book-pagination .pdf-blank{box-sizing:border-box;flex:none;margin:0;max-width:none;background:#fff;box-shadow:0 1px 5px #0002;position:relative}
.pdf-book .pdf-content{display:block;position:absolute}
.pdf-book .pdf-sheet canvas{display:block;margin:0;max-width:none}
.pdf-book .pdf-sheet canvas:not([data-rendered="true"]){visibility:hidden}
.pdf-book .pdf-page{position:absolute;left:0;right:0;bottom:3px;margin:0;font:12px/20px system-ui;color:#68736b}
.pdf-book-pagination.pdf-night .pdf-sheet,.pdf-book-pagination.pdf-night .pdf-blank{background:#202220}
.pdf-book-pagination.pdf-night .pdf-page{color:#aaa}
.textLayer{letter-spacing:normal;word-spacing:normal;text-size-adjust:none;position:absolute;inset:0;overflow:hidden;line-height:1;text-align:initial;transform-origin:0 0;color:transparent}
.textLayer :deep(.pdf-text-contents){--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size));position:absolute;left:0;top:0;transform-origin:0 0}
.textLayer :deep(.pdf-text-contents[data-main-rotation="90"]){transform:rotate(90deg) translateY(-100%)}
.textLayer :deep(.pdf-text-contents[data-main-rotation="180"]){transform:rotate(180deg) translate(-100%,-100%)}
.textLayer :deep(.pdf-text-contents[data-main-rotation="270"]){transform:rotate(270deg) translateX(-100%)}
.textLayer :deep(span),.textLayer :deep(br){position:absolute;white-space:pre;cursor:text;transform-origin:0 0}
.textLayer :deep(span){font-size:calc(var(--text-scale-factor) * var(--font-height));transform:rotate(var(--rotate,0deg)) scaleX(var(--scale-x,1)) scale(var(--min-font-size-inv));}
.textLayer ::selection{background:#ebd67f;color:#222}
</style>
