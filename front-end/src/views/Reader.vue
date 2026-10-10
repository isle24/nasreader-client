<script setup lang="ts">
// Unified reader: TXT (CSS-column pagination over rune locators), EPUB (foliate-js)
// and PDF (pdfjs-dist, rendered by DocumentReader).
//
// Progress always uses the frozen locator contract: TXT `c:<global rune offset>`,
// EPUB `e:<CFI>`, PDF `p:<page>`. Page turns derive the locator from the measured
// page table (src/reader/pagination.ts) instead of re-measuring the animated DOM, so
// a save can never write a stale neighbouring page.
import {ref,computed,onMounted,onBeforeUnmount,nextTick,watch} from 'vue';import {useRoute,useRouter} from 'vue-router';
import {api,state} from '../state';
import {cachedBooks,loadBook,queueMutation,pendingMutations,removeMutation} from '../api/cache';
import type {Book,Chapter,Note,Progress} from '../api/client';
import {errorMessage,isOffline,isUnavailable} from '../api/errors';
import {chapterAt,formatRuneLocator,locatorOffset,parseLocator,percentAt,progressTimestamp,readerSettings,runeLength,runeSlice,sliceWindow,type ReaderSettings} from '../reader/core';
import {buildPageTable,buildScrollTable,offsetForPage,pageCount,pageForOffset,scrollOffsetAt,scrollTopForOffset,type PageTable,type ScrollTable,type SpanBox} from '../reader/pagination';
import {formatTextGroups} from '../reader/txtTypesetting';
import {txtSpreadGeometry} from '../reader/txtSpread';
import {createStageRunner,deviceMotionHints,flipPlan,FLIP_LABELS,FLIP_MODES,resolveFlipMode,type FlipKeyframe,type FlipMode,type FlipPlan,type FlipTiming} from '../reader/pageflip';
import {isTap,resolveSwipe,resolveVerticalContinue,resolveWheel,tapZone,type TouchPoint} from '../reader/gestures';
import {surfaceVars,themeSurface} from '../reader/texture';
import {loadReaderSettings,saveReaderSettings,resolveReaderSettings,serverReaderSettings} from '../reader/settings';
import {sliderFill} from '../reader/sliders';
import {audioWatchdogMs,resolveSpeechEngine,serverEngineIssue,speechAdvanced,speechStartTimeoutMs,type ReaderPosition,type SpeechEngine,type TtsEngines} from '../reader/tts';
import {serverSpeechVoice,type DocumentSpeechPart} from '../reader/documentSpeech';
import DocumentReader from '../components/DocumentReader.vue';
import BookCover from '../components/BookCover.vue';
import ReaderPageArrowIcon from '../components/ReaderPageArrowIcon.vue';
import {shouldShowIntroduction,keepPageArrows,type DocumentInteraction,type DocumentInfo} from '../reader/desktop';
import type {LibraryRef} from '../api/libraries';
import ReaderCatalog from '../components/ReaderCatalog.vue';
import {createContentVersionGuard,type ContentVersionGuard,type ContentVersionState} from '../reader/contentVersion';
const props=defineProps<{resumePosition?:{locator:string;chapter_idx:number}}>();
const emit=defineEmits<{'reload-content':[position:{locator:string;chapter_idx:number}]}>();

const window=globalThis.window;
const route=useRoute(),router=useRouter(),id=Number(route.params.id);
const book=ref<Book|null>(null),chapters=ref<Chapter[]>([]),chapter=ref(0),text=ref(''),sliceStart=ref(0),sliceEnd=ref(0),page=ref(0);
const content=ref<HTMLElement|null>(null),viewport=ref<HTMLElement|null>(null),documentReader=ref<any>(null),turnShadow=ref<HTMLElement|null>(null),root=ref<HTMLElement|null>(null);
/** Measured slot width, sampled once per render; the page turn never re-measures. */
const pageWidth=ref(700);
const inkWindow=ref<HTMLElement|null>(null),columnWidth=ref(700),columnGap=ref(0),columnCount=ref(1);
const documentInitialLocator=ref(''),documentOpening=ref(true);
const file=ref<Blob>(),docToc=ref<any[]>([]),busy=ref(true),error=ref(''),status=ref(''),panel=ref('');
/**
 * Immersive reading: the bars start hidden and are overlays in bands the text never
 * occupies, so toggling them can neither reflow the columns nor re-measure the page
 * table (see the geometry note above the styles at the end of this file).
 */
const controls=ref(false);
const desktopMedia=window.matchMedia('(min-width:800px) and (pointer:fine)'),desktop=ref(desktopMedia.matches),firstIntroduction=ref(false),coverIntroduction=ref(false),initialResume=ref(false),libraryName=ref('');
const documentInfo=ref<DocumentInfo>({sections:0,coverSections:[],bodySection:0,currentSection:-1,onCover:false}),lastBodyProgress=ref<Progress|null>(null);
const introduction=computed(()=>shouldShowIntroduction({desktop:desktop.value,firstEntry:firstIntroduction.value,declaredCover:coverIntroduction.value,resuming:initialResume.value}));
const pageArrows=ref(true),arrowHover=ref(false),arrowFocus=ref(false),frameSelection=ref(false);let arrowsTimer:ReturnType<typeof setTimeout>|undefined;
const notes=ref<Note[]>([]),noteText=ref(''),selection=ref<any>(null),query=ref(''),hits=ref<any[]>([]),searched=ref(false);
function chooseCatalogEntry(entry:{index:number;locator?:string}) {if(isTXT.value){void loadChapter(entry.index);panel.value=''}else if(entry.locator){void goTo(entry.locator)}}
const settings=ref<ReaderSettings>(readerSettings()),settingsReady=ref(false),offlineCopy=ref(false);
const pageTable=ref<PageTable>({starts:[0],ends:[0]}),scrollTable=ref<ScrollTable>({tops:[0],offsets:[0]});
const serverProgress=ref<Progress|null>(null),conflict=ref<any>(null);
const pdfPageRange=ref({start:0,end:0,total:0});
const pdfToolsActive=ref(false);
const pdfPosition=computed(()=>book.value?.format==='pdf'&&pdfPageRange.value.total>0?`${pdfPageRange.value.start===pdfPageRange.value.end?pdfPageRange.value.start:pdfPageRange.value.start+'–'+pdfPageRange.value.end} / ${pdfPageRange.value.total}`:`${Math.round(percent.value*100)}%`);
const pdfAtStart=computed(()=>book.value?.format==='pdf'&&pdfPageRange.value.total>0&&pdfPageRange.value.start===1);
const pdfAtEnd=computed(()=>book.value?.format==='pdf'&&pdfPageRange.value.total>0&&pdfPageRange.value.end===pdfPageRange.value.total);
const speechEngineIssue=computed(()=>serverEngineIssue(speechEngine.value,ttsEngines.value));
const speechPaused=ref(false),resumeSpeechIndex=ref(0),edgeVoice=ref('zh-CN-XiaoxiaoNeural');
const speaking=ref(false),speechIndex=ref(-1),speechEngine=ref<SpeechEngine>('browser'),effectiveEngine=ref<SpeechEngine>('browser'),speechRate=ref(1),speechVoice=ref(''),voices=ref<SpeechSynthesisVoice[]>([]),speechVolume=ref(1),timerMinutes=ref(0),highlightColor=ref('#ebd67f');
const ttsEngines=ref<TtsEngines|null>(null),ttsEngineError=ref(''),ttsUnavailable=ref(false);
const versionNoticeLater=ref(false);
const contentVersion=ref<ContentVersionState<Book>>({changed:false,checking:false,latest:null});
let versionGuard:ContentVersionGuard<Book>|undefined,versionTimer:ReturnType<typeof setInterval>|undefined;
const progressRequests=new Set<AbortController>();let versionSavePending=false;

function readLocal(key:string):string|null{try{return localStorage.getItem(key)}catch{return null}}
function writeLocal(key:string,value:string){try{localStorage.setItem(key,value)}catch{/* private mode: keep working without persistence */}}
function randomDevice(){try{return crypto.randomUUID()}catch{return 'device-'+Math.random().toString(36).slice(2)}}
const userId=():number=>state.user?.id??0;
const device=readLocal('nasreader.device')||randomDevice();
writeLocal('nasreader.device',device);

let audio:HTMLAudioElement|undefined,audioURL='',speechTimer:ReturnType<typeof setTimeout>|undefined,audioWatchdog:ReturnType<typeof setTimeout>|undefined,speechStartTimer:ReturnType<typeof setTimeout>|undefined,saveTimer:ReturnType<typeof setTimeout>|undefined,reflowTimer:ReturnType<typeof setTimeout>|undefined,resize:ResizeObserver|undefined;
let speechRequest:AbortController|undefined,speechGeneration=0;
let closed=false,touchStart:TouchPoint|null=null,touchAt=0,lastSpeechNotice='',suppressSettingsSave=false,timestampFloor=0;
/** Auto-hide timer for the overlay bars, and the last real touch (to ignore its mouse echo). */
let controlsTimer:ReturnType<typeof setTimeout>|undefined,lastTouchAt=0;
/** Status is now a floating line above the bottom bar: it must not linger over the text. */
let statusTimer:ReturnType<typeof setTimeout>|undefined;
/** Mouse press state for the desktop tap path; a tap never starts from a bare mouseup. */
let mouseStart:TouchPoint|null=null,mouseAt=0;
/** True while a chapter slice is being fetched/rendered; reflows must not run then. */
let loadingChapter=false,deferredReflow=false,slotWatcher:number|undefined,reflowRunning=false,reflowQueued=false;
/** Authoritative reading position for this slice, or -1 when the reader has moved it. */
const pendingLocator=ref(-1),measuredMode=ref<'paginated'|'scroll'>('paginated');
const scrollPosition=ref(0);
let positionEpoch=0,chapterGeneration=0;
let expectedScrollTop:number|null=null;
let turning=false;
/** True only after the reader has seen an explicit page-turn choice from the user. */
let flipChosen=false;

const isTXT=computed(()=>book.value?.format==='txt');
const chapterIndex=computed(()=>chapters.value.findIndex(x=>x.idx===chapter.value));
const chapterInfo=computed(()=>chapters.value.find(x=>x.idx===chapter.value));
const hasPrevChapter=computed(()=>chapterIndex.value>0);
const hasNextChapter=computed(()=>chapterIndex.value>=0&&chapterIndex.value<chapters.value.length-1);
const totalPages=computed(()=>pageCount(pageTable.value));
/** Paragraph structure keeps the rune offsets of the flat sentence segmentation. */
const groups=computed(()=>formatTextGroups(text.value,settings.value.txtLayout));
/** Same spans as `groups`, flattened, for speech and the sentence index. */
const textSegments=computed(()=>groups.value.flatMap(g=>g.segments));
const documentSpeechParts=ref<DocumentSpeechPart[]>([]),documentSpeechState=ref({busy:true,available:false,reason:''}),speechPreparing=ref(false);
const speechParts=computed(()=>isTXT.value?textSegments.value.map(s=>s.text):documentSpeechParts.value.map(s=>s.text));
const percent=computed(()=>isTXT.value?percentAt(chapters.value,currentGlobalOffset()):(serverProgress.value?.percent??0));
/**
 * Theme tokens + typography. The night theme adds +0.1 line-height and +50 weight
 * (spec §10.2); the surface tokens drive the paper texture, gutter and page edge so a
 * theme change is one style object swap, never a repaint loop.
 */
const style=computed(()=>{
  const s=settings.value,surface=themeSurface(s.theme);
  return {...surfaceVars(s.theme),
    'font-size':s.size+'px',
    'line-height':String(s.lineHeight+(s.theme==='night'?0.1:0)),
    'font-family':s.font==='serif'?'"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif':s.font,
    'font-weight':String(400+surface.fontWeightBonus),
    '--reader-align':s.align,
  };
});
const reduceMotion=()=>{try{return window.matchMedia('(prefers-reduced-motion: reduce)').matches}catch{return false}};
/** The mode a turn actually uses: explicit choice, device class and reduced motion. */
function activeFlip():FlipMode{
  return resolveFlipMode(settings.value.flip,{...deviceMotionHints(navigator),automatic:!flipChosen});
}
/**
 * Page offset applied to the column block. It goes through a CSS variable instead of an
 * inline `transform` so the page-turn animation can own the element's transform without
 * fighting Vue's style binding (and without touching `transform` in the render path).
 */
const pageStep=computed(()=>settings.value.mode==='paginated'?page.value*(pageWidth.value||0):0);
const baseTransform=computed(()=>`translate3d(${-pageStep.value}px,0,0)`);

/* ---------- geometry: measured once per render, never mid-transition ---------- */

function spanBoxes():SpanBox[]{
  const el=content.value;
  if(!el)return [];
  const previous=el.style.transform;
  el.style.transform='none';
  const base=el.getBoundingClientRect(),boxes:SpanBox[]=[];
  for(const span of Array.from(el.querySelectorAll<HTMLElement>('[data-offset]'))){
    const offset=Number(span.dataset.offset)||0,end=offset+runeLength(span.textContent??'');
    for(const rect of Array.from(span.getClientRects())){
      if(!rect.width&&!rect.height)continue;
      boxes.push({offset,end,left:rect.left-base.left,right:rect.right-base.left,top:rect.top-base.top,bottom:rect.bottom-base.top});
    }
  }
  el.style.transform=previous;
  return boxes;
}
async function measure(targetGlobal?:number,toLast=false,epoch=positionEpoch){
  await nextTick();
  if(closed||turning||epoch!==positionEpoch)return false;
  const view=viewport.value;
  if(!view||!content.value)return false;
  if(settings.value.mode==='scroll'){
    scrollTable.value=buildScrollTable(spanBoxes());
    pageTable.value={starts:[0],ends:[0]};
    page.value=0;
    if(targetGlobal!==undefined){view.scrollTop=scrollTopForOffset(scrollTable.value,Math.max(0,targetGlobal-sliceStart.value))+(inkWindow.value?.offsetTop??0);expectedScrollTop=view.scrollTop;}
    else if(toLast){view.scrollTop=view.scrollHeight;expectedScrollTop=view.scrollTop;}
  }else{
    // The slot width is sampled here, once per render, together with the page table:
    // the turn animation reads this value and never measures the DOM mid-flight.
    // clientWidth rounds fractional CSS pixels. Rounding the ink window up by even
    // 1/64px makes column-width + column-count choose one oversized column.
    const geometry=txtSpreadGeometry({width:inkWindow.value?.getBoundingClientRect().width||view.clientWidth,viewportWidth:window.innerWidth,fontSize:settings.value.size,paginated:true,finePointer:window.matchMedia('(pointer:fine)').matches});
    columnWidth.value=geometry.columnWidth;columnGap.value=geometry.gap;columnCount.value=geometry.columns;pageWidth.value=geometry.stride;
    await nextTick();
    if(closed||turning||epoch!==positionEpoch)return false;
    pageTable.value=buildPageTable(spanBoxes(),pageWidth.value);
    // An explicit target wins; otherwise the last authoritative locator is re-resolved
    // (which is a no-op when the table did not move, and repairs the page number when it
    // did). `toLast` is a real request to jump to the end and overrides both.
    const target=toLast?undefined:targetGlobal!==undefined?targetGlobal:(pendingLocator.value>=0?pendingLocator.value:undefined);
    page.value=toLast?totalPages.value-1:target!==undefined?pageForOffset(pageTable.value,Math.max(0,target-sliceStart.value)):Math.min(page.value,totalPages.value-1);
  }
  page.value=Math.max(0,Math.min(page.value,totalPages.value-1));
  measuredMode.value=settings.value.mode;
  return true;
}
/**
 * Measure and, if the layout was not final yet, measure again.
 *
 * The e2e reader test caught this: the first measurement after a fresh render saw a
 * 2px-taller column box than the settled layout (a pending re-layout while the large
 * span tree is created), so the page table it produced assigned different runes to the
 * same page numbers. The reading position was still saved correctly - it is a rune
 * offset - but restoring it landed on the previous page, which breaks the "forward,
 * back, forward, reload" contract. Measuring until the table stops changing makes the
 * page table independent of when the first sample happened.
 */
async function measureStable(targetGlobal?:number,toLast=false,force=false){
  const epoch=positionEpoch;
  await nextTick();
  // Both signals must stop changing before the table is trusted: the slide's rendered
  // geometry and the table itself.
  const geometry=()=>`${viewport.value?.clientHeight??0}:${content.value?.scrollWidth??0}`;
  let previous='';
  for(let pass=0;pass<12;pass++){
    if(!await measure(targetGlobal,toLast,epoch))return;
    const sample=`${geometry()}:${pageTable.value.starts.join(',')}`;
    if(!force&&pass>0&&sample===previous)return;
    previous=sample;
    await nextFrame();
    await new Promise<void>(resolve=>setTimeout(resolve,0));
  }
}
/**
 * Settle the slot layout after a chapter or a resize.
 *
 * The reader mounts from an async route guard, so the browser's own `load` event has
 * already fired by the time the first page table is measured - and on this page the slot
 * kept growing for a moment afterwards (540px -> 584px -> 582px). The table built from
 * the short slot resolved a restored locator to the *previous* page, which failed the
 * e2e "position survives a reload" assertion. The saved locator was never wrong; only
 * the page number it resolved to was.
 *
 * The rule that makes this robust: while the slot geometry is still moving, the reading
 * position - a rune offset, which is what the contract is about - is authoritative, and
 * page numbers are re-derived from it on every pass. Once the geometry has been
 * identical twice in a row, the page number is left alone so nothing the reader did in
 * between (a page turn, a jump to a note) can be undone.
 *
 * A watch is ignored while this runs, and no pass may run while one is in flight.
 */
let settling=false,settleArmedAt=0;
function releaseSettle(){
  settling=false;slotWatcher=undefined;
  if(deferredReflow&&!closed&&!turning&&!loadingChapter){deferredReflow=false;void scheduleReflow()}
}
function scheduleSettle(){
  if(closed||!isTXT.value||settings.value.mode!=='paginated')return;
  settleArmedAt=Date.now();
  if(settling||slotWatcher!==undefined)return;
  settling=true;
  const started=Date.now();
  let previous='';
  let stable=0;
  const step=()=>{
    if(closed||turning||loadingChapter||Date.now()-started>4000){releaseSettle();return}
    const geometry=`${viewport.value?.clientHeight??0}x${content.value?.scrollWidth??0}`;
    if(geometry===previous){
      stable++;
      // Two identical frames plus a settled moment: stop owning the page number.
      if(stable>=2&&Date.now()-settleArmedAt>700){releaseSettle();return}
      slotWatcher=window.requestAnimationFrame(step);
      return;
    }
    previous=geometry;
    stable=0;
    // Keep the reading position and let the page number follow the new table. The
    // authoritative locator is preferred: reading it off the page table here is what
    // walked the restored position backwards.
    const anchor=pendingLocator.value>=0?pendingLocator.value:locatorOffset(locatorNow());
    void measureStable(anchor,false,true).then(()=>{if(!closed)void saveProgress()});
    slotWatcher=window.requestAnimationFrame(step);
  };
  slotWatcher=window.requestAnimationFrame(step);
}
async function reflow(){
  if(loadingChapter||turning){deferredReflow=true;return}
  // A watch owns the page table while the slot is still settling; re-entering it from a
  // resize or a settings change would fight it.
  if(settling){deferredReflow=true;return}
  const anchor=pendingLocator.value>=0?pendingLocator.value:locatorOffset(locatorNow());
  pendingLocator.value=anchor;
  await nextTick();
  await measureStable(anchor);
}

/* ---------- page turn: the flagship animation ----------
   Contract: the visible page may only change through `page`, which the pagination table
   maps to a locator. The animation therefore never measures, never waits for a
   transition to read the position, and only ever touches transform / opacity.

   Geometry note (measured in Chromium at 1280x800): the page block is several slots
   wide, so rotating IT in 3D magnified the column entering at the spine into a visible
   bulge, and a separate one-slot 3D sheet (tried next) had no text of its own and made
   every turn look like a grey flash. The turn is therefore the page travelling a full
   slot under a passing spine shadow - see the notes in src/reader/pageflip.ts. */

/** Snapshots the CSS variables a turn temporarily overrides, so they can be restored. */
function captureTransitions(){
  const view=viewport.value;
  const previous={
    transform:view?.style.getPropertyValue('--reader-page-transform')??'',
    origin:view?.style.getPropertyValue('--flip-origin')??'',
  };
  return ()=>{
    if(!view)return;
    view.style.setProperty('--reader-page-transform',previous.transform);
    view.style.setProperty('--flip-origin',previous.origin);
  };
}
function runTrack(el:HTMLElement|null,keyframes:FlipKeyframe[],timing:FlipTiming):Animation|undefined{
  if(!el||typeof el.animate!=='function')return undefined;
  try{return el.animate(keyframes as Keyframe[],{duration:timing.duration,easing:timing.easing,fill:timing.fill})}catch{return undefined}
}
/** Resolves after the browser has painted the next frame. */
function nextFrame(){
  return new Promise<void>(resolve=>{window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>resolve()))});
}
/**
 * Drop the finished animation. Uses two `cancel()` passes with a paint in between and no
 * `finish()`: the last keyframe of a turn holds the OLD page offset, so the animation may
 * not be removed before the browser has applied the new one - otherwise the page snaps
 * back to where the turn started.
 */
async function releaseTrack(animation:Animation|undefined){
  if(!animation)return;
  try{animation.cancel()}catch{/* detached mid-turn */}
  await nextFrame();
  try{animation.cancel()}catch{/* already gone */}
}
/**
 * Animate one page turn and resolve once the animation has finished AND the browser has
 * painted the settled frame.
 *
 * The reading offset only ever moves through `swap()`, which is guarded by a stage
 * runner: the turn schedules the swap at the plan's `swap` stage and also calls it after
 * the animation, and applying it twice advanced two pages for one tap. The travel track
 * is built so that its first half is the sheet lifting (the page does not move yet) and
 * its second half is the incoming page sliding in after the swap, so the two are never
 * fighting over the same pixels.
 */
async function runTimeline(plan:FlipPlan,swap:()=>void):Promise<void>{
  const nextStage=createStageRunner();
  const swapNow=()=>{if(nextStage(plan,'swap'))swap()};
  const contentTrack=runTrack(content.value,plan.content.keyframes,plan.content.timing);
  const shadowTrack=runTrack(turnShadow.value,plan.shadow.keyframes,plan.shadow.timing);
  const swapStage=plan.stages.find(stage=>stage.action==='swap');
  const timer=swapStage?setTimeout(swapNow,swapStage.at):undefined;
  if(!swapStage)swapNow();
  try{
    await Promise.all([contentTrack?.finished.catch(()=>{}),shadowTrack?.finished.catch(()=>{})]);
  }catch{/* detached mid-turn */}
  if(timer)clearTimeout(timer);
  swapNow();            // idempotent: the stage runner has already consumed the swap
  await nextTick();     // the new page offset is in the DOM (as the CSS variable) ...
  await releaseTrack(contentTrack);   // ... before the animation holding the old one goes
  await releaseTrack(shadowTrack);
}
async function turnBy(delta:number){
  if(turning||!delta)return;
  if(settings.value.mode!=='paginated'||!isTXT.value)return;
  positionEpoch++;
  pendingLocator.value=-1;   // a real turn invalidates the old source anchor
  const plan=flipPlan(activeFlip(),delta>0?'forward':'back',pageWidth.value);
  turning=true;
  const restore=captureTransitions();
  const swap=()=>{page.value=Math.max(0,Math.min(totalPages.value-1,page.value+delta))};
  try{
    if(viewport.value&&plan.mode==='simulation'){
      // The page pivots on its leading edge: the right edge when it comes in from the
      // right, the left edge when it goes back out to the left.
      viewport.value.style.setProperty('--flip-origin',delta>0?'right center':'left center');
    }
  if(plan.content.timing.duration>0)await runTimeline(plan,swap);
    else{swap();await nextTick()}
    restore();
    scheduleSave();
  }finally{
    turning=false;
    if(deferredReflow&&!loadingChapter&&!settling){deferredReflow=false;void scheduleReflow()}
  }
}

/* ---------- locator and progress ---------- */

function currentGlobalOffset():number{
  if(!isTXT.value)return locatorOffset(serverProgress.value?.locator??'');
  if(measuredMode.value==='scroll'){
    void scrollPosition.value; // reactive signal; read actual DOM top for immediate mode changes
    return sliceStart.value+scrollOffsetAt(scrollTable.value,Math.max(0,(viewport.value?.scrollTop??0)-(inkWindow.value?.offsetTop??0)));
  }
  if(pendingLocator.value>=sliceStart.value&&pendingLocator.value<=sliceEnd.value)return pendingLocator.value;
  return sliceStart.value+offsetForPage(pageTable.value,page.value);
}
function locatorNow():string{
  return isTXT.value?formatRuneLocator(currentGlobalOffset()):(serverProgress.value?.locator??'');
}
function position():ReaderPosition{
  return {chapter_idx:chapter.value,page:page.value,sliceStart:sliceStart.value,sliceEnd:sliceEnd.value,locator:locatorNow()};
}
function progressBody(overrideTimestamp?:number){
  const offset=currentGlobalOffset();
  return {chapter_idx:isTXT.value?chapterAt(chapters.value,offset):(serverProgress.value?.chapter_idx??0),locator:locatorNow(),percent:isTXT.value?percentAt(chapters.value,offset):(serverProgress.value?.percent??0),device_id:device,updated_at:progressTimestamp(Date.now(),timestampFloor,overrideTimestamp)};
}
async function saveProgress(overrideTimestamp?:number){
  if(!book.value||closed||!settingsReady.value||introduction.value||!isTXT.value&&documentOpening.value)return;
  if(versionGuard&&!versionGuard.canWrite()){versionSavePending=contentVersion.value.checking&&!contentVersion.value.changed;return}
  const body=progressBody(overrideTimestamp);
  if(!body.locator){status.value='尚未取得阅读位置，暂不保存';return}
  const requestAbort=new AbortController();progressRequests.add(requestAbort);
  try{
    if(!navigator.onLine)throw new TypeError('offline');
    const saved=await api.request<Progress>('/progress/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:requestAbort.signal});
    if(closed||requestAbort.signal.aborted||versionGuard&&!versionGuard.canWrite())return;
    serverProgress.value=saved??({...body,book_id:id} as Progress);
    status.value='进度已保存';
  }catch(e:any){
    if(requestAbort.signal.aborted||closed)return;
    if(e?.status===409){conflict.value=e.body?.current??e.body;status.value='存在较新的服务器进度，请选择要保留的位置'}
    else if(isOffline(e)){await queueMutation(state.server,userId(),'/progress/'+id,'PUT',body);status.value='离线进度已保存在此设备'}
    else status.value=errorMessage(e);
  }finally{progressRequests.delete(requestAbort)}
}
function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>void saveProgress(),700)}
function onTextScroll(){
  if(settings.value.mode!=='scroll')return;
  const top=viewport.value?.scrollTop??0;
  scrollPosition.value=top;
  if(expectedScrollTop!==null&&Math.abs(top-expectedScrollTop)<1){expectedScrollTop=null;scheduleSave();return}
  if(!loadingChapter){
    expectedScrollTop=null;
    // A user scroll supersedes an in-flight mode/font reflow. Programmatic anchor
    // restoration above is recognized by its actual (possibly clamped) scrollTop.
    positionEpoch++;pendingLocator.value=-1;
    if(measuredMode.value!=='scroll'){scrollTable.value=buildScrollTable(spanBoxes());measuredMode.value='scroll';}
  }
  scheduleSave();
}
async function dropQueuedProgress(){for(const item of await pendingMutations(state.server,userId()))if(item.path==='/progress/'+id)await removeMutation(item.id)}
async function chooseServerProgress(){
  if(versionGuard&&!versionGuard.canWrite()){status.value='请先刷新书籍内容，再处理进度';return}
  const target=conflict.value;conflict.value=null;
  // Adopting the server position must also stop this device from re-conflicting with
  // it: later saves may not be older than the record we just accepted.
  timestampFloor=progressTimestamp(timestampFloor,Number(target?.updated_at||0)+1);
  await dropQueuedProgress();
  if(target?.locator)await goTo(target.locator,target.chapter_idx??0);
  status.value='已采用服务器位置';
}
async function keepLocalProgress(){
  if(versionGuard&&!versionGuard.canWrite()){status.value='请先刷新书籍内容，再处理进度';return}
  const target=conflict.value;conflict.value=null;
  status.value='正在用本机位置覆盖服务器记录…';
  await saveProgress(Math.max(Date.now(),Number(target?.updated_at||0)+1));
  if(!conflict.value)await dropQueuedProgress();
}

/* ---------- navigation ---------- */

async function readCachedSlice(idx:number,window:{start:number;end:number}){
  const snapshot=await loadBook(state.server,userId(),id,book.value!.hash);
  const full=snapshot?.texts[idx];
  if(full===undefined)throw new Error('本章尚未下载，联网后可继续阅读');
  return {text:runeSlice(full,window.start,window.end),slice_start:window.start,slice_end:window.end};
}
async function readSlice(idx:number,window:{start:number;end:number}){
  offlineCopy.value=false;
  if(state.offline||!navigator.onLine){offlineCopy.value=true;return readCachedSlice(idx,window)}
  try{return await api.get<{text:string;slice_start:number;slice_end:number}>(`/books/${id}/chapters/${idx}?start=${window.start}&end=${window.end}`)}
  catch(e:any){if(!isOffline(e))throw e;offlineCopy.value=true;return readCachedSlice(idx,window)}
}
async function loadChapter(idx:number,globalOffset?:number,toLast=false,fromSpeech=false){
  if(!fromSpeech)stopSpeech();
  const target=chapters.value.find(x=>x.idx===idx);
  if(!target){error.value='找不到这一章';return}
  const run=++chapterGeneration;positionEpoch++;
  busy.value=true;error.value='';hits.value=[];searched.value=false;
  loadingChapter=true;deferredReflow=false;
  try{
    chapter.value=idx;
    const wanted=globalOffset??(toLast?Math.max(target.start,target.end-1):target.start),window=sliceWindow(target.start,target.end,wanted);
    const data=await readSlice(idx,window);
    if(closed||run!==chapterGeneration)return;
    text.value=data.text??'';
    sliceStart.value=target.start+(data.slice_start??window.start);
    sliceEnd.value=target.start+(data.slice_end??window.end);
    page.value=0;
    // The locator this slice was opened at is authoritative until the reader moves; every
    // later re-measure resolves the page number from it. Without this the settle pass
    // re-anchored from a page table built while the slot was still short, and the restored
    // position silently walked back one page (the failure the e2e reload test caught).
    // `sliceStart` is already updated above, so this is the absolute rune offset.
    pendingLocator.value=sliceStart.value+Math.max(0,wanted-sliceStart.value);
    await measureStable(wanted,toLast);
    if(offlineCopy.value)status.value='正在阅读本机下载的内容';
    scheduleSettle();
    scheduleSave();
  }catch(e:any){if(!closed&&run===chapterGeneration)error.value=errorMessage(e)}
  finally{
    if(run!==chapterGeneration)return;
    busy.value=false;
    loadingChapter=false;
    // A resize/settings reflow that arrived mid-load is honoured now that the new slice
    // has a measured page table, instead of being applied against the stale one.
    if(deferredReflow&&!settling){deferredReflow=false;await nextTick();await measureStable(locatorOffset(locatorNow()),false,true)}
  }
}
async function next(fromSpeech=false){
  if(introduction.value){await beginReading();return}
  const automatic=fromSpeech===true;
  if(!automatic)stopSpeech();
  if(!isTXT.value){if(pdfAtEnd.value){status.value='你已经读到最后一页';return};await documentReader.value?.next();return}
  if(settings.value.mode==='scroll'){
    const view=viewport.value;
    if(view&&view.scrollTop+view.clientHeight<view.scrollHeight-4){view.scrollBy({top:Math.round(view.clientHeight*0.9),behavior:reduceMotion()?'auto':'smooth'});scheduleSave();return}
    if(sliceEnd.value<(chapterInfo.value?.end??0))return void loadChapter(chapter.value,sliceEnd.value,false,automatic);
    if(hasNextChapter.value)return void loadChapter(chapters.value[chapterIndex.value+1]!.idx,undefined,false,automatic);
    status.value='你已经读到最后一页';return;
  }
  if(page.value>=totalPages.value-1){
    if(sliceEnd.value<(chapterInfo.value?.end??0))return void loadChapter(chapter.value,sliceEnd.value,false,automatic);
    if(hasNextChapter.value)return void loadChapter(chapters.value[chapterIndex.value+1]!.idx,undefined,false,automatic);
    status.value='你已经读到最后一页';return;
  }
  await turnBy(1);
}
/** Touch/keyboard-independent page turn driven by the gesture resolver. */
function applyIntent(intent:{kind:'next'|'prev'|'none'}){
  if(intent.kind==='next')void next();
  else if(intent.kind==='prev')void prev();
}

/* ---------- immersive chrome: tap to reveal, tap outside to hide ----------
   The bars are overlays inside bands the text never occupies, so nothing here may
   measure or reflow the columns. `controls` only flips visibility. */

/** How long the bars stay on screen after the last interaction, in ms. */
const CONTROLS_AUTO_HIDE_MS=4000;

function clearAutoHide(){clearTimeout(controlsTimer);controlsTimer=undefined}
/** Arm (or re-arm) the auto-hide timer; never while a panel is open or text is selected. */
function armAutoHide(){
  clearAutoHide();
  if(!controls.value||panel.value||selection.value||pdfToolsActive.value)return;
  controlsTimer=setTimeout(()=>{if(!panel.value&&!selection.value&&!pdfToolsActive.value)controls.value=false},CONTROLS_AUTO_HIDE_MS);
}
function onPDFToolsActive(active:boolean){pdfToolsActive.value=active;active?clearAutoHide():armAutoHide();showPageArrows()}
function showControls(){controls.value=true;armAutoHide()}
function hideControls(){controls.value=false;clearAutoHide()}
function toggleControls(){controls.value?hideControls():showControls()}
/** Every press/key on the reader keeps the bars alive while they are visible. */
function bumpAutoHide(){if(controls.value)armAutoHide()}
/** Events from the bars, the panels or any interactive control are never a text tap. */
function fromChrome(target:EventTarget|null):boolean{
  const el=target as HTMLElement|null;
  return Boolean(el?.closest?.('.reader-chrome,.reader-modal,button,a,input,select,textarea,label'));
}
/**
 * Apply a tap on the reading surface: left 30% previous, right 30% next, middle 40%
 * toggles the bars. In the continuous mode a tap only ever toggles, so a vertical drag
 * keeps belonging to the scroller.
 */
function applyTap(clientX:number){
  const rect=root.value?.getBoundingClientRect();
  if(settings.value.mode==='scroll'||!rect?.width){toggleControls();return}
  const zone=tapZone(clientX-rect.left,rect.width);
  if(zone==='prev'){hideControls();void prev()}
  else if(zone==='next'){hideControls();void next()}
  else toggleControls();
}
/**
 * Finish one press: the swipe/continue resolver runs first (a page turn must never also
 * read as a tap), then the tap classifier decides whether the bars toggle. A selection
 * suppresses the tap entirely - selecting text is not a request for chrome.
 */
function endPress(start:TouchPoint,end:TouchPoint,elapsed:number){
  const scrolling=settings.value.mode==='scroll';
  const intent=scrolling
    ? resolveVerticalContinue(start,end,elapsed,{atTop:(viewport.value?.scrollTop??0)<=2,atBottom:isAtScrollEnd()})
    : resolveSwipe(start,end,elapsed,false);
  if(intent.kind!=='none'){hideControls();applyIntent(intent);return}
  if(window.getSelection()?.toString())return;
  if(isTap(start,end,elapsed))applyTap(end.x);
}
function onTouchStart(event:TouchEvent){
  const point=event.changedTouches[0];
  if(!point)return;
  lastTouchAt=Date.now();
  touchStart={x:point.clientX,y:point.clientY};
  touchAt=Date.now();
}
function onTouchEnd(event:TouchEvent){
  captureSelection();
  const point=event.changedTouches[0];
  if(!point||!touchStart)return;
  lastTouchAt=Date.now();
  const start=touchStart;touchStart=null;
  endPress(start,{x:point.clientX,y:point.clientY},Date.now()-touchAt);
}
/**
 * Mouse/trackpad tap. A mouse drag is a text selection, never a page turn (the wheel,
 * the keyboard and the bars already cover the mouse), so only the tap classifier runs
 * here. Touch taps also produce compatibility mouse events, so a mouse press that
 * arrives right after a real touch is ignored instead of toggling twice.
 */
function onMouseDown(event:MouseEvent){
  if(event.button!==0||fromChrome(event.target))return;
  if(Date.now()-lastTouchAt<700)return;
  mouseStart={x:event.clientX,y:event.clientY};mouseAt=Date.now();
}
function onMouseUp(event:MouseEvent){
  const start=mouseStart;mouseStart=null;
  if(!start||fromChrome(event.target))return;
  if(Date.now()-lastTouchAt<700)return;
  const end={x:event.clientX,y:event.clientY};
  if(window.getSelection()?.toString())return;
  if(isTap(start,end,Date.now()-mouseAt))applyTap(end.x);
}
function onWheel(event:WheelEvent){
  if(settings.value.mode==='scroll'||event.ctrlKey)return;
  const intent=resolveWheel(event.deltaX,event.deltaY);
  if(intent.kind==='none')return;
  event.preventDefault();
  hideControls();
  applyIntent(intent);
}
function onDocumentInteraction(event:DocumentInteraction){if(event.kind==='pointer'){frameSelection.value=!!event.selection;showPageArrows();return}if(event.kind==='tap'){applyTap(event.x??0);return}if(event.kind==='key'&&event.key){showPageArrows();keyboard(new KeyboardEvent('keydown',{key:event.key}))}}
/** True when the continuous view is already at the end of its scroll range. */
function isAtScrollEnd(){
  const view=viewport.value;
  if(!view)return false;
  return view.scrollTop+view.clientHeight>=view.scrollHeight-4;
}

async function prev(){
  if(introduction.value)return;
  stopSpeech();
  if(!isTXT.value){if(pdfAtStart.value){status.value='已经是第一页';return};await documentReader.value?.prev();return}
  if(settings.value.mode==='scroll'){
    const view=viewport.value;
    if(view&&view.scrollTop>4){view.scrollBy({top:-Math.round(view.clientHeight*0.9),behavior:reduceMotion()?'auto':'smooth'});scheduleSave();return}
    if(sliceStart.value>(chapterInfo.value?.start??0))return void loadChapter(chapter.value,Math.max(chapterInfo.value!.start,sliceStart.value-1),true);
    if(hasPrevChapter.value){const previous=chapters.value[chapterIndex.value-1]!;return void loadChapter(previous.idx,Math.max(previous.start,previous.end-1),true)}
    status.value='已经是第一页';return;
  }
  if(page.value>0){await turnBy(-1);return}
  if(sliceStart.value>(chapterInfo.value?.start??0))return void loadChapter(chapter.value,Math.max(chapterInfo.value!.start,sliceStart.value-1),true);
  if(hasPrevChapter.value){const previous=chapters.value[chapterIndex.value-1]!;return void loadChapter(previous.idx,Math.max(previous.start,previous.end-1),true)}
  status.value='已经是第一页';
}
async function goTo(locator:string,idx=chapter.value){
  if(!locator)return;
  stopSpeech();
  if(isTXT.value){
    const global=locatorOffset(locator);
    const chapterIdx=chapters.value.some(x=>x.idx===idx)?idx:chapterAt(chapters.value,global);
    await loadChapter(chapterIdx,global);
  }else await documentReader.value?.goTo(locator);
  panel.value='';
}
/** Bottom overlay: jump straight to the neighbouring chapter (same path as 目录). */
function stepChapter(delta:number){
  const next=chapterIndex.value+delta;
  if(next<0||next>=chapters.value.length)return;
  hideControls();
  void loadChapter(chapters.value[next]!.idx);
}
function keyboard(e:KeyboardEvent){
  showPageArrows();
  const target=e.target as HTMLElement|null;
  // Escape closes the topmost layer first and reaches the bars even when focus sits on
  // one of their buttons, which is where a click on the bar leaves it.
  if(e.key==='Escape'){
    if(panel.value){panel.value='';return}
    if(controls.value){e.preventDefault();hideControls()}
    return;
  }
  if(target?.closest('input,textarea,select,button,a'))return;
  if(['ArrowRight','PageDown',' '].includes(e.key)){e.preventDefault();hideControls();void next()}
  else if(['ArrowLeft','PageUp'].includes(e.key)){e.preventDefault();hideControls();void prev()}
  else if(e.key==='Home'){e.preventDefault();if(chapters.value.length)void loadChapter(chapters.value[0]!.idx)}
  else if(e.key==='End'){e.preventDefault();if(chapters.value.length)void loadChapter(chapters.value[chapters.value.length-1]!.idx,undefined,true)}
}

/* ---------- selection, notes and bookmarks ---------- */

function offsetInContent(node:Node,offset:number):number{
  const element=node.nodeType===Node.TEXT_NODE?node.parentElement:(node as HTMLElement|null);
  const span=element?.closest?.('[data-offset]') as HTMLElement|null;
  if(!span||!content.value?.contains(span))return -1;
  const range=document.createRange();
  range.selectNodeContents(span);
  try{range.setEnd(node,offset)}catch{return -1}
  return sliceStart.value+Number(span.dataset.offset||0)+runeLength(range.toString());
}
function captureSelection(){
  const selected=window.getSelection();
  if(!selected||!selected.rangeCount||!selected.toString().trim()||!content.value)return;
  const range=selected.getRangeAt(0);
  const start=offsetInContent(range.startContainer,range.startOffset);
  if(start<0)return;
  const quote=selected.toString();
  const end=offsetInContent(range.endContainer,range.endOffset);
  if(end<start)return;
  selection.value={quote,start_locator:formatRuneLocator(start),end_locator:formatRuneLocator(end)};
  noteText.value='';panel.value='annotation';
}
async function createNote(kind:string,keepPanel=false){
  const anchor=selection.value?.start_locator??locatorNow();
  if(!anchor){status.value='尚未取得位置，无法标记';return}
  const body={book_id:id,chapter_idx:chapter.value,start_locator:anchor,end_locator:selection.value?.end_locator??anchor,quote:selection.value?.quote??'',note:noteText.value,color:highlightColor.value,kind};
  try{
    if(!navigator.onLine)throw new TypeError('offline');
    notes.value.push(await api.post<Note>('/notes',body));
    status.value=kind==='bookmark'?'书签已保存':'笔记已保存';
  }catch(e:any){
    if(isOffline(e)){await queueMutation(state.server,userId(),'/notes','POST',body);notes.value.push({...body,id:-Date.now(),created_at:Date.now(),updated_at:Date.now()} as Note);status.value='已保存在本机，联网后自动同步'}
    else status.value=errorMessage(e);
  }
  if(!keepPanel)panel.value='';
  selection.value=null;noteText.value='';window.getSelection()?.removeAllRanges();
}
async function deleteNote(note:Note){
  try{
    if(note.id<0){status.value='这条离线笔记尚未同步，请联网后再管理';return}
    await api.delete('/notes/'+note.id);
    notes.value=notes.value.filter(x=>x.id!==note.id);status.value='已删除';
  }catch(e:any){status.value=errorMessage(e)}
}
function marked(start:number,end:number){
  return notes.value.some(n=>n.chapter_idx===chapter.value&&n.kind!=='bookmark'&&parseLocator(n.start_locator).kind==='rune'&&locatorOffset(n.start_locator)<sliceStart.value+end&&locatorOffset(n.end_locator)>sliceStart.value+start);
}
async function exportNotes(){
  try{
    const kindName=(kind:string)=>kind==='bookmark'?'书签':kind==='highlight'?'高亮':'笔记';
    const markdown=notes.value.map(n=>`## ${kindName(n.kind)}\n\n> ${n.quote}\n\n${n.note}\n\n位置 ${n.start_locator}`).join('\n\n');
    const url=URL.createObjectURL(new Blob([`# ${book.value?.title??'读书笔记'}\n\n${markdown}`],{type:'text/markdown;charset=utf-8'}));
    const link=document.createElement('a');
    link.href=url;link.download=`${book.value?.title??'book'}-笔记.md`;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    status.value='笔记已导出';
  }catch(e:any){status.value=errorMessage(e)}
}

/* ---------- in-book search ---------- */

async function search(){
  if(!query.value.trim()){status.value='请输入关键词';return}
  try{
    if(isTXT.value&&(state.offline||!navigator.onLine||offlineCopy.value)){
      const snapshot=await loadBook(state.server,userId(),id,book.value!.hash);
      hits.value=[];
      for(const ch of chapters.value){
        const full=snapshot?.texts[ch.idx];
        if(full===undefined)continue;
        let from=0,at=full.indexOf(query.value,from),guard=0;
        while(at>=0&&guard<50){
          hits.value.push({idx:ch.idx,title:ch.title,locator:formatRuneLocator(ch.start+runeLength(full.slice(0,at))),excerpt:full.slice(Math.max(0,at-30),at+80)});
          from=at+query.value.length;at=full.indexOf(query.value,from);guard++;
        }
      }
      if(!hits.value.length)status.value='本机下载内容里没有找到“'+query.value+'”';
    }else if(isTXT.value){
      const data=await api.get<{items:any[]}>(`/books/${id}/search?q=${encodeURIComponent(query.value)}`);
      hits.value=(data.items??[]).map((h:any)=>({idx:h.idx,title:h.title,locator:formatRuneLocator((h.start??0)+(h.offset??0)),excerpt:h.excerpt}));
    }else{
      const found=await documentReader.value?.search(query.value);
      hits.value=Array.isArray(found)?found:[];
    }
  }catch(e:any){hits.value=[];status.value=isUnavailable(e)?'书内搜索暂不可用：'+errorMessage(e):errorMessage(e)}
  finally{searched.value=true}
}

/* ---------- text to speech ---------- */

function releaseAudio(){if(audioURL){URL.revokeObjectURL(audioURL);audioURL=''}audio=undefined}
function stopSpeech(){
  speechGeneration++;speechRequest?.abort();speechRequest=undefined;
  speaking.value=false;speechPaused.value=false;speechIndex.value=-1;documentReader.value?.clearSpeechHighlight();
  clearTimeout(speechTimer);clearTimeout(audioWatchdog);clearTimeout(speechStartTimer);
  try{window.speechSynthesis?.cancel()}catch{/* unsupported */ }
  audio?.pause();releaseAudio();
}
async function loadTtsEngines(){
  if(!navigator.onLine){ttsEngines.value=null;ttsUnavailable.value=false;return}
  try{ttsEngines.value=await api.get<TtsEngines>('/tts/engines');ttsEngineError.value='';ttsUnavailable.value=false}
  catch(e:any){ttsEngines.value=null;ttsUnavailable.value=isUnavailable(e);ttsEngineError.value=isUnavailable(e)?'服务器朗读引擎暂不可用：'+errorMessage(e):errorMessage(e)}
}
function speakWithBrowser(sentence:string){
  if(!speaking.value)return;
  const synth=window.speechSynthesis;
  if(!synth){status.value='此设备不支持系统朗读';stopSpeech();return}
  const index=speechIndex.value,generation=speechGeneration;
  const utterance=new SpeechSynthesisUtterance(sentence);
  utterance.lang='zh-CN';utterance.rate=speechRate.value;utterance.volume=speechVolume.value;
  try{utterance.voice=voices.value.find(v=>v.voiceURI===speechVoice.value)??null}catch{/* voice list unavailable */ }
  let started=false;
  utterance.onstart=()=>{started=true;clearTimeout(speechStartTimer)};
  utterance.onend=()=>{clearTimeout(speechStartTimer);if(speaking.value&&generation===speechGeneration)void speakSentence(index+1)};
  utterance.onerror=()=>{if(generation!==speechGeneration)return;clearTimeout(speechStartTimer);status.value='系统朗读被中断或不可用';stopSpeech()};
  speechStartTimer=setTimeout(()=>{if(!started&&speaking.value){status.value='系统语音没有响应，请检查设备的朗读设置';stopSpeech()}},speechStartTimeoutMs);
  synth.speak(utterance);
}
async function speakSentence(index:number){
  if(!speaking.value)return;
  const generation=speechGeneration;
  clearTimeout(audioWatchdog);clearTimeout(speechStartTimer);
  if(index>=speechParts.value.length){await continueSpeech();return}
  speechIndex.value=index;
  if(!isTXT.value)await documentReader.value?.highlightSpeech(index);
  if(!speaking.value||generation!==speechGeneration)return;
  await nextTick();
  if(!speaking.value||generation!==speechGeneration)return;
  const span=content.value?.querySelector<HTMLElement>(`[data-sentence="${index}"]`);
  if(span){
    if(settings.value.mode==='scroll')span.scrollIntoView({block:'center',behavior:reduceMotion()?'auto':'smooth'});
    else{positionEpoch++;pendingLocator.value=sliceStart.value+Number(span.dataset.offset||0);await measureStable(pendingLocator.value);if(!speaking.value||generation!==speechGeneration)return;}
    scheduleSave();
  }
  const sentence=speechParts.value[index]!;
  const decision=resolveSpeechEngine(speechEngine.value,ttsEngines.value);
  effectiveEngine.value=decision.engine;
  if(decision.notice&&decision.notice!==lastSpeechNotice){lastSpeechNotice=decision.notice;status.value=decision.notice}
  if(decision.engine!=='browser'){
    const settled={done:false};
    try{
      speechRequest=new AbortController();
      const blob=await api.request<Blob>('/tts/speak',{method:'POST',signal:speechRequest.signal,headers:{'Content-Type':'application/json',Accept:'application/octet-stream'},body:JSON.stringify({text:sentence,engine:decision.engine,voice:decision.engine==='edge'?serverSpeechVoice(edgeVoice.value):'',rate:speechRate.value})});
      if(!speaking.value||generation!==speechGeneration)return;
      releaseAudio();audioURL=URL.createObjectURL(blob);
      audio=new Audio(audioURL);audio.volume=speechVolume.value;
      audioWatchdog=setTimeout(()=>{
        if(settled.done||!speaking.value||generation!==speechGeneration)return;
        settled.done=true;status.value='服务器朗读超时，已改用系统语音';effectiveEngine.value='browser';releaseAudio();speakWithBrowser(sentence);
      },audioWatchdogMs(sentence,speechRate.value));
      audio.onended=()=>{if(settled.done||generation!==speechGeneration)return;settled.done=true;clearTimeout(audioWatchdog);void speakSentence(index+1)};
      audio.onerror=()=>{if(settled.done||generation!==speechGeneration)return;settled.done=true;clearTimeout(audioWatchdog);status.value='服务器音频无法播放，已改用系统语音';effectiveEngine.value='browser';releaseAudio();speakWithBrowser(sentence)};
      await audio.play();
      return;
    }catch(e:any){
      if(generation!==speechGeneration||!speaking.value)return;
      settled.done=true;clearTimeout(audioWatchdog);releaseAudio();effectiveEngine.value='browser';
      status.value='服务器朗读失败，已改用系统语音：'+errorMessage(e);
    }
  }
  speakWithBrowser(sentence);
}
async function continueSpeech(){
  if(!speaking.value)return;
  if(!isTXT.value){
    const generation=speechGeneration;
    const parts=await documentReader.value?.continueSpeech()??[];
    if(!speaking.value||generation!==speechGeneration)return;
    documentSpeechParts.value=parts;
    if(!parts.length){status.value=book.value?.format==='pdf'?'本页没有文本层，或已到全书结尾':'已朗读到全书结尾';stopSpeech();return}
    await speakSentence(0);return;
  }
  const generation=speechGeneration;
  const before=position();
  await next(true);
  if(!speaking.value||generation!==speechGeneration)return;
  const after=position();
  if(!speechAdvanced(before,after)){status.value='已朗读到全书结尾';stopSpeech();return}
  speaking.value=true;
  await speakSentence(0);
}
function pauseSpeech(){const index=speechIndex.value;stopSpeech();resumeSpeechIndex.value=Math.max(0,index);speechPaused.value=true;status.value='朗读已暂停'}
async function startSpeech(){
  if(introduction.value)await beginReading();
  if(speechPaused.value){speechPaused.value=false;speaking.value=true;if(timerMinutes.value>0)speechTimer=setTimeout(stopSpeech,timerMinutes.value*60000);await speakSentence(resumeSpeechIndex.value);return}
  stopSpeech();
  if(isTXT.value&&!text.value.trim()){status.value='这一页没有可朗读的文字';return}
  const generation=speechGeneration;
  if(!isTXT.value){
    speechPreparing.value=true;
    try{documentSpeechParts.value=await documentReader.value?.prepareSpeech()??[]}
    catch(e:any){status.value='提取朗读文字失败：'+errorMessage(e);return}
    finally{speechPreparing.value=false}
    if(generation!==speechGeneration)return;
    if(!documentSpeechParts.value.length){status.value=documentSpeechState.value.reason||'这本书没有可提取的正文文字';return}
  }
  const decision=resolveSpeechEngine(speechEngine.value,ttsEngines.value);
  effectiveEngine.value=decision.engine;lastSpeechNotice=decision.notice;
  status.value=decision.notice||(decision.engine==='browser'?'使用设备系统语音朗读':'使用服务器朗读引擎');
  if(decision.engine==='browser'&&!window.speechSynthesis){status.value='此设备不支持系统朗读';return}
  speaking.value=true;speechIndex.value=-1;
  if(timerMinutes.value>0)speechTimer=setTimeout(()=>{status.value='定时朗读已结束';stopSpeech()},timerMinutes.value*60000);
  await speakSentence(0);
}
function onDocumentSpeechReady(value:{busy:boolean;available:boolean;reason:string}){documentSpeechState.value=value;if(!value.busy){documentOpening.value=false;coverIntroduction.value=documentInfo.value.onCover&&documentInfo.value.coverSections.length>0;scheduleSave()}}
function onDocumentInfo(info:DocumentInfo){documentInfo.value=info;if(!documentOpening.value)coverIntroduction.value=info.onCover&&info.coverSections.length>0}
function documentProgress(progress:any){
  if(!progress?.locator)return;
  if(book.value?.format==='pdf'&&Number.isInteger(progress.page_start)&&Number.isInteger(progress.page_end)&&Number.isInteger(progress.total_pages)&&progress.page_start>=1&&progress.page_end>=progress.page_start&&progress.total_pages>=progress.page_end)pdfPageRange.value={start:progress.page_start,end:progress.page_end,total:progress.total_pages};
  if(desktop.value&&documentInfo.value.onCover&&documentInfo.value.coverSections.length)return;
  lastBodyProgress.value={locator:progress.locator,chapter_idx:progress.chapter_idx,percent:progress.percent,book_id:id,device_id:device,updated_at:Date.now()};
  serverProgress.value={locator:progress.locator,chapter_idx:progress.chapter_idx,percent:progress.percent,book_id:id,device_id:device,updated_at:Date.now()};
  scheduleSave();
}

/* ---------- settings ---------- */

async function loadSettings(){
  const local=loadReaderSettings(localStorage,state.server,state.user?.id);
  let remote:ReaderSettings|null=null;
  if(navigator.onLine){try{remote=serverReaderSettings(await api.get('/me/settings'))}catch{/* device-local settings are enough */ }}
  suppressSettingsSave=true;
  settings.value=resolveReaderSettings(local,remote);
  // A stored copy that already carries a flip choice means the user picked one, so the
  // low-end fallback must stop overriding it. A fresh profile keeps the fallback.
  flipChosen=Boolean(local);
  saveReaderSettings(localStorage,state.server,state.user?.id,settings.value);
  await nextTick();
  suppressSettingsSave=false;
  settingsReady.value=true;
}
/** The flip select: records the explicit choice and normalizes the stored value. */
function chooseFlip(value:string){
  flipChosen=true;
  settings.value.flip=(FLIP_MODES.includes(value as FlipMode)?value:'simulation') as ReaderSettings['flip'];
}
function applySettings(){
  // Apply, persist and reflow in that order, and never let one pass swallow the next
  // one. Two quick slider moves (theme then font size, as the e2e theme test does) must
  // both land - the previous version dropped the second change while a reflow was still
  // running, so the reader kept showing the old size until the next interaction.
  //
  // The state update happens synchronously here, so the DOM is correct even if a reflow
  // is already in flight; only the re-measure is coalesced.
  const normalized=readerSettings(settings.value);
  if(JSON.stringify(normalized)!==JSON.stringify(settings.value))settings.value=normalized;
  saveReaderSettings(localStorage,state.server,state.user?.id,normalized);
  if(navigator.onLine)void api.put('/me/settings',{reader:normalized}).catch(()=>{/* device-local is enough */});
  void scheduleReflow();
}
/** One reflow at a time; a request that arrives mid-flight queues exactly one more. */
async function scheduleReflow(){
  if(reflowRunning){reflowQueued=true;return}
  reflowRunning=true;
  try{
    do{
      reflowQueued=false;
      await reflow();
    }while(reflowQueued);
  }finally{reflowRunning=false;reflowQueued=false}
}
/* ---------- desktop introduction and page arrows ---------- */
type ArrowPress={pointer:number;x:number;y:number;button:HTMLButtonElement;direction:-1|1;dragged:boolean};
let arrowPress:ArrowPress|null=null,arrowClickHandledAt=0;
function arrowDown(event:PointerEvent,direction:-1|1){
 const button=event.currentTarget as HTMLButtonElement;
 if(!event.isPrimary||event.button!==0||button.disabled)return;
 arrowPress={pointer:event.pointerId,x:event.clientX,y:event.clientY,button,direction,dragged:false};
 try{button.setPointerCapture(event.pointerId)}catch{/* native click remains a fallback */}
}
function arrowMove(event:PointerEvent){if(arrowPress?.pointer===event.pointerId&&Math.hypot(event.clientX-arrowPress.x,event.clientY-arrowPress.y)>6)arrowPress.dragged=true}
function arrowCancel(){arrowPress=null;arrowClickHandledAt=performance.now()}
function arrowUp(event:PointerEvent){
 const press=arrowPress;if(!press||press.pointer!==event.pointerId)return;
 arrowMove(event);arrowPress=null;arrowClickHandledAt=performance.now();
 const rect=press.button.getBoundingClientRect();
 if(closed||press.dragged||press.button.disabled||event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)return;
 // The captured, completed press survives a compositor-backed EPUB iframe.
 void(press.direction>0?next():prev());
}
function arrowClick(event:MouseEvent,direction:-1|1){
 // Enter/Space and accessibility actions have no completed pointer sequence.
 if(event.detail===0||performance.now()-arrowClickHandledAt>1000)void(direction>0?next():prev());
}
function arrowHeld(){return keepPageArrows({hover:arrowHover.value,focus:arrowFocus.value||pdfToolsActive.value,panel:!!panel.value,selection:!!selection.value||frameSelection.value})}
function showPageArrows(){if(closed)return;pageArrows.value=true;clearTimeout(arrowsTimer);if(!arrowHeld())arrowsTimer=setTimeout(()=>{if(arrowHeld())showPageArrows();else pageArrows.value=false},3000)}
function desktopChanged(event:MediaQueryListEvent){desktop.value=event.matches;if(!desktop.value&&book.value)scheduleSave();showPageArrows()}
async function beginReading(){
  if(busy.value||documentOpening.value&&!isTXT.value)return;
  const wasCover=documentInfo.value.onCover;firstIntroduction.value=false;coverIntroduction.value=false;stopSpeech();
  if(!isTXT.value&&wasCover){if(lastBodyProgress.value?.locator)await documentReader.value?.goTo(lastBodyProgress.value.locator);else await documentReader.value?.startText()}
  await nextTick();if(isTXT.value)await measureStable(locatorOffset(locatorNow()));scheduleSave();showPageArrows();
}

/* ---------- opened edition checks ---------- */
async function checkContentVersion(manual=false){
  if(closed||busy.value||loadingChapter||!versionGuard)return;
  const result=await versionGuard.check();
  if(closed)return;
  if(manual&&result==='changed')versionNoticeLater.value=false;
  else if(manual&&result==='unchanged')status.value='当前内容已是最新版本';
  else if(manual&&result==='failed')status.value='暂时无法检查书籍更新，请稍后重试';
}
function onVersionFocus(){const pending=contentVersion.value.checking;void checkContentVersion().then(()=>{if(pending&&!closed)void checkContentVersion()})}
function onVersionVisibility(){if(document.visibilityState==='visible')onVersionFocus()}
function watchContentVersion(){
  if(!book.value)return;
  const openedUser=userId();
  versionGuard=createContentVersionGuard(book.value,{
    fetch:signal=>api.request<Book>(`/books/${id}`,{signal}),
    eligible:()=>!closed&&!state.offline&&navigator.onLine&&document.visibilityState==='visible'&&!!state.user&&userId()===openedUser,
    onState:value=>{const previous=contentVersion.value.latest?.hash;contentVersion.value=value;if(value.changed){if(value.latest?.hash!==previous)versionNoticeLater.value=false;versionSavePending=false;clearTimeout(saveTimer);for(const request of progressRequests)request.abort()}else if(!value.checking&&versionSavePending){versionSavePending=false;scheduleSave()}},
  });
  versionTimer=setInterval(()=>void checkContentVersion(),30000);
}
function refreshOpenedContent(){
  if(!contentVersion.value.changed||busy.value||loadingChapter||turning||speechPreparing.value||(!isTXT.value&&documentSpeechState.value.busy)||state.offline||!navigator.onLine)return;
  const anchor={locator:locatorNow(),chapter_idx:chapter.value};
  if(!anchor.locator){status.value='尚未取得阅读位置，请稍后刷新';return}
  stopSpeech();clearTimeout(saveTimer);
  emit('reload-content',anchor);
}

/* ---------- lifecycle ---------- */

onMounted(async()=>{
  if(!state.user){await router.replace('/login');return}
  window.addEventListener('keydown',keyboard);desktopMedia.addEventListener('change',desktopChanged);showPageArrows();
  window.addEventListener('focus',onVersionFocus);document.addEventListener('visibilitychange',onVersionVisibility);window.addEventListener('online',onVersionFocus);
  window.addEventListener('pointerdown',bumpAutoHide);
  window.addEventListener('keydown',bumpAutoHide);
  try{
    await loadSettings();
    let cached;
    try{
      book.value=await api.get<Book>(`/books/${id}`);
      cached=await loadBook(state.server,userId(),id,book.value.hash);
    }catch(e:any){
      if(!isOffline(e))throw e;
      cached=(await cachedBooks(state.server,userId())).find(x=>x.book.id===id);
      if(!cached)throw e;
      book.value=cached.book;offlineCopy.value=true;status.value='正在阅读本机下载的内容';
    }
    watchContentVersion();
    if(book.value?.status==='missing'){error.value='这本书的源文件已不在书库中，请管理员重新扫描或导入';return}
    if(navigator.onLine){
      const [progress,noteList]=await Promise.all([
        api.get<Progress|null>(`/progress/${id}`).catch(()=>null),
        api.get<{items:Note[]}>(`/notes?book_id=${id}`).catch(()=>({items:[] as Note[]})),
      ]);
      serverProgress.value=progress;notes.value=noteList.items??[];
    }else{
      serverProgress.value=cached?.progress??null;notes.value=cached?.notes??[];
      for(const item of await pendingMutations(state.server,userId())){
        if(item.path==='/progress/'+id)serverProgress.value={...item.body,book_id:id} as Progress;
        if(item.path==='/notes'&&item.body?.book_id===id)notes.value.push({...item.body,id:-item.id} as Note);
      }
    }
    initialResume.value=!!props.resumePosition?.locator||!!serverProgress.value?.locator&&Number(serverProgress.value.updated_at)>0;firstIntroduction.value=!initialResume.value;
    if(book.value.library_id){try{libraryName.value=(await api.get<LibraryRef>('/libraries/'+book.value.library_id)).name}catch{/* book access already checked */}}
    if(props.resumePosition?.locator)serverProgress.value={...(serverProgress.value??{book_id:id,percent:0,updated_at:0}),locator:props.resumePosition.locator,chapter_idx:props.resumePosition.chapter_idx} as Progress;
    if(isTXT.value){
      chapters.value=navigator.onLine?(await api.get<{items:Chapter[]}>(`/books/${id}/chapters`)).items:(cached?.chapters??[]);
      if(!chapters.value.length)throw new Error('这本书还没有可阅读的章节');
      await loadChapter(props.resumePosition?chapterAt(chapters.value,locatorOffset(props.resumePosition.locator)):(serverProgress.value?.chapter_idx??chapters.value[0]!.idx),locatorOffset(serverProgress.value?.locator??''));
    }else{
      documentInitialLocator.value=serverProgress.value?.locator??'';documentOpening.value=true;
      file.value=cached?.file??await api.blob(`/books/${id}/file`);
    }
    const key='nasreader.recent:'+state.server+':'+userId();
    const ids:number[]=JSON.parse(readLocal(key)??'[]');
    writeLocal(key,JSON.stringify([id,...ids.filter(x=>x!==id)].slice(0,20)));
    if(viewport.value){resize=new ResizeObserver(()=>{clearTimeout(reflowTimer);reflowTimer=setTimeout(()=>void reflow(),150)});resize.observe(viewport.value)}
    voices.value=window.speechSynthesis?.getVoices()??[];
    if(window.speechSynthesis)window.speechSynthesis.onvoiceschanged=()=>{voices.value=window.speechSynthesis.getVoices()};
    void loadTtsEngines();
    void document.fonts?.ready.then(()=>{if(!closed)void reflow()});
    // Web fonts and the async route guard mean "the DOM is painted" is not "the slot has
    // its final height"; the settle pass watches for the rest.
    if(document.readyState!=='complete')window.addEventListener('load',()=>{if(!closed)scheduleSettle()},{once:true});
    scheduleSettle();
  }catch(e:any){error.value=errorMessage(e)}
  finally{busy.value=false}
});
watch(settings,()=>{if(suppressSettingsSave)return;const anchor=currentGlobalOffset();positionEpoch++;pendingLocator.value=anchor;applySettings()},{deep:true,flush:'sync'});
// A panel (目录/排版/笔记/搜索/朗读/批注) or an active selection freezes the auto-hide:
// hiding the bars while the reader is inside a panel would strand it there.
watch(panel,()=>{panel.value?clearAutoHide():armAutoHide();showPageArrows()});
watch(selection,()=>{selection.value?clearAutoHide():armAutoHide();showPageArrows()});watch([arrowHover,arrowFocus],showPageArrows);
// The status line floats over the text while the bars are hidden, so it fades on its
// own instead of staying on the page (every page turn writes a progress message).
watch(status,()=>{
  clearTimeout(statusTimer);
  if(status.value)statusTimer=setTimeout(()=>{status.value=''},5000);
});
onBeforeUnmount(()=>{
  void saveProgress();
  closed=true;arrowCancel();clearTimeout(arrowsTimer);desktopMedia.removeEventListener('change',desktopChanged);versionGuard?.dispose();clearInterval(versionTimer);window.removeEventListener('focus',onVersionFocus);document.removeEventListener('visibilitychange',onVersionVisibility);window.removeEventListener('online',onVersionFocus);clearTimeout(saveTimer);clearTimeout(reflowTimer);clearAutoHide();clearTimeout(statusTimer);
  stopSpeech();resize?.disconnect();window.removeEventListener('keydown',keyboard);
  window.removeEventListener('pointerdown',bumpAutoHide);window.removeEventListener('keydown',bumpAutoHide);
  if(slotWatcher)window.cancelAnimationFrame(slotWatcher);
});
</script>

<template><main ref="root" class="reader" :class="['theme-'+settings.theme,settings.mode,'flip-'+(isTXT?activeFlip():'none')]" :style="style" :data-motion="settings.mode==='scroll'?'scroll':(isTXT?activeFlip():'none')" @mousedown="onMouseDown" @mouseup="onMouseUp" @pointermove="showPageArrows">
<div class="reader-grain" aria-hidden="true"></div>
<section v-if="introduction&&book" class="reader-introduction" role="region" aria-label="书籍介绍" @mousedown.stop @mouseup.stop><header><h1>{{book.title}}</h1><p>{{book.author||'佚名'}}<template v-if="libraryName"> · {{libraryName}}</template></p></header><div class="introduction-body"><BookCover :book="book" eager/><div><p class="book-synopsis">{{book.description||'这本书暂无简介。'}}</p><p>{{book.format.toUpperCase()}}<template v-if="book.word_count"> · {{book.word_count}} 字</template></p><button class="primary" :disabled="busy||!isTXT&&documentOpening" @click="beginReading">{{initialResume||!firstIntroduction&&lastBodyProgress?.locator?'继续阅读':'开始阅读'}}</button></div></div></section>
<Teleport to="body"><div v-if="desktop" class="reader-floating-navigation"><button class="desktop-page-arrow previous" :style="surfaceVars(settings.theme)" :class="{shown:pageArrows}" aria-label="向前翻页" :disabled="introduction||pdfAtStart" @mouseenter="arrowHover=true" @mouseleave="arrowHover=false" @focus="arrowFocus=true" @blur="arrowFocus=false" @pointerdown.stop="arrowDown($event,-1)" @pointermove.stop="arrowMove" @pointerup.stop="arrowUp" @pointercancel.stop="arrowCancel" @mousedown.prevent.stop @mouseup.stop @click.stop="arrowClick($event,-1)"><ReaderPageArrowIcon direction="previous"/></button><button class="desktop-page-arrow next" :style="surfaceVars(settings.theme)" :class="{shown:pageArrows}" aria-label="向后翻页" :disabled="!introduction&&pdfAtEnd" @mouseenter="arrowHover=true" @mouseleave="arrowHover=false" @focus="arrowFocus=true" @blur="arrowFocus=false" @pointerdown.stop="arrowDown($event,1)" @pointermove.stop="arrowMove" @pointerup.stop="arrowUp" @pointercancel.stop="arrowCancel" @mousedown.prevent.stop @mouseup.stop @click.stop="arrowClick($event,1)"><ReaderPageArrowIcon direction="next"/></button>
</div></Teleport>
<div v-if="contentVersion.changed&&!versionNoticeLater" class="reader-version-notice" role="status" @mousedown.stop @mouseup.stop><span>书籍已有新内容<small>旧版本进度暂停同步</small></span><button :disabled="busy||speechPreparing||(!isTXT&&documentSpeechState.busy)||state.offline" @click="refreshOpenedContent">刷新并保留位置</button><button @click="versionNoticeLater=true;status='继续阅读旧版本，进度暂停同步'">稍后</button></div>

<!-- Immersive chrome. Both bars are fixed overlays sized to the bands the text
     viewport always leaves free (see --reader-band-* below): showing them can neither
     cover a line of text nor move one, and the page table is never re-measured. -->
<header class="reader-toolbar reader-chrome" :class="{shown:controls}">
<RouterLink to="/" class="button reader-back" aria-label="返回书库">返回书库</RouterLink>
<strong class="reader-book-title">{{book?.title}}</strong>
<button @click="panel=panel==='toc'?'':'toc'" :aria-expanded="panel==='toc'">目录</button>
<button @click="panel=panel==='settings'?'':'settings'" :aria-expanded="panel==='settings'">排版</button>
<button @click="panel=panel==='notes'?'':'notes'" :aria-expanded="panel==='notes'">笔记</button>
<button @click="panel=panel==='search'?'':'search'" :aria-expanded="panel==='search'">搜索</button>
<button @click="panel=panel==='speech'?'':'speech'" :aria-expanded="panel==='speech'">朗读</button>
<progress class="reader-progress" :value="percent" max="1" aria-label="阅读进度"></progress>
</header>
<p v-if="error" role="alert" class="error">{{error}} <button @click="router.go(0)">重新加载</button></p>
<p v-if="busy" class="reading-loading" role="status">正在整理这一页…</p>
<section v-if="isTXT&&!error" :aria-hidden="introduction" ref="viewport" class="text-viewport" :class="{'txt-spread':settings.mode==='paginated'&&columnCount===2,'txt-auto':settings.txtLayout==='auto'}" :data-columns="settings.mode==='paginated'?columnCount:1" tabindex="0" aria-label="正文" :style="{'--reader-page-transform':baseTransform}" @mouseup="captureSelection" @touchstart="onTouchStart" @touchend="onTouchEnd" @touchcancel="touchStart=null" @wheel="onWheel" @scroll="onTextScroll">
<div ref="inkWindow" class="text-page-window">
<div ref="turnShadow" class="turn-shadow" aria-hidden="true"></div>
<div ref="content" class="text-columns" :style="{'--text-base-transform':baseTransform,columnWidth:settings.mode==='paginated'?columnWidth+'px':undefined,columnGap:columnGap+'px',columnCount:settings.mode==='paginated'?columnCount:undefined,'--para-gap':settings.paraGap+'em','--para-indent':settings.indent+'em'}">
<h2 v-if="!(settings.txtLayout==='auto'&&groups[0]?.kind==='heading')">{{chapterInfo?.title}}</h2>
<component :is="g.kind==='heading'?'h3':'p'" v-for="g in groups" :key="'p'+g.start" class="para" :class="'txt-'+g.kind"><span v-for="s in g.segments" :key="'s'+s.start" :data-offset="s.start" :data-sentence="s.index" :class="{'speech-active':speechIndex===s.index,'note-mark':marked(s.start,s.end)}">{{s.text}}</span></component>
</div>
</div>
</section>
<DocumentReader :aria-hidden="introduction" v-else-if="file&&book&&!error" ref="documentReader" :file="file" :format="book.format" pdf-layout="book" :show-tools="controls" @tools-active="onPDFToolsActive" @reveal-tools="showControls" :locator="documentOpening?documentInitialLocator:(serverProgress?.locator??'')" :theme="settings.theme" :size="settings.size" :line-height="settings.lineHeight" :font="settings.font" :mode="settings.mode" @speech-ready="onDocumentSpeechReady" @document-info="onDocumentInfo" @error="error=$event" @toc="docToc=$event" @progress="documentProgress" @selection="selection=$event;panel='annotation'" @interaction="onDocumentInteraction"/>
<footer class="reader-footer reader-chrome" :class="{shown:controls}">
<button v-if="isTXT" @click="stepChapter(-1)" :disabled="!hasPrevChapter" aria-label="上一章">上一章</button>
<button @click="prev" :disabled="pdfAtStart" aria-label="上一页">上一页</button>
<button @click="hideControls()" :aria-pressed="controls" aria-label="显示或隐藏工具栏" class="page-indicator">{{isTXT?`${chapterInfo?.title??''} · ${settings.mode==='paginated'&&columnCount===2?'双页 · ':''}${page+1}/${totalPages}`:pdfPosition}}</button>
<button @click="next()" :disabled="pdfAtEnd" aria-label="下一页">下一页</button>
<button v-if="isTXT" @click="stepChapter(1)" :disabled="!hasNextChapter" aria-label="下一章">下一章</button>
<small role="status" aria-live="polite">{{status}}</small>
</footer>
<div v-if="panel" class="modal-backdrop reader-modal" @click.self="panel=''"><section class="sheet" :class="{'reader-catalog-sheet':['toc','notes'].includes(panel)}" role="dialog" aria-modal="true" :aria-label="panel==='toc'?'目录':panel==='settings'?'阅读排版':panel==='notes'?'笔记与书签':panel==='search'?'书内搜索':panel==='annotation'?'标记这一段':'听这本书'"><button class="close" @click="panel=''" aria-label="关闭面板"><svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
<ReaderCatalog v-if="panel==='toc'||panel==='notes'" :book="book" :chapters="chapters" :document-toc="docToc" :active-index="isTXT?chapter:(serverProgress?.chapter_idx??0)" :position-text="isTXT?`${page+1}/${totalPages} 页`:pdfPosition" :percent="percent" :tab="panel==='notes'?'notes':'toc'" :note-count="notes.length" @tab="panel=$event" @select="chooseCatalogEntry"/>
<template v-if="panel==='settings'"><h2>阅读排版</h2><button :disabled="busy||contentVersion.checking||state.offline" @click="checkContentVersion(true)">{{contentVersion.checking?'正在检查…':'检查书籍更新'}}</button>
<label>主题<select v-model="settings.theme" aria-label="主题"><option value="day">日间</option><option value="night">夜间</option><option value="parchment">羊皮纸</option><option value="green">护眼绿</option></select></label>
<label>字号 {{settings.size}} px<input v-model.number="settings.size" type="range" min="16" max="36" step="1" :style="sliderFill(settings.size,16,36)"></label>
<label>行高 {{settings.lineHeight}}<input v-model.number="settings.lineHeight" type="range" min="1.4" max="2.4" step="0.1" :style="sliderFill(settings.lineHeight,1.4,2.4)"></label>
<label>字体<select v-model="settings.font"><option value="serif">系统宋体</option><option value="sans-serif">系统黑体</option><option value="monospace">等宽字体</option></select></label>
<label>阅读方式<select v-model="settings.mode"><option value="paginated">横滑翻页（左右分页）</option><option value="scroll">上下滑动（连续滚动）</option></select></label>
<label>横滑动效<select :value="settings.flip" :disabled="settings.mode==='scroll'" @change="chooseFlip(($event.target as HTMLSelectElement).value)"><option v-for="m in FLIP_MODES" :key="m" :value="m">{{FLIP_LABELS[m]}}{{m==='simulation'?'（默认）':''}}</option></select></label>
<label>首行缩进 {{settings.indent}} em<input v-model.number="settings.indent" type="range" min="0" max="4" step="0.5" :style="sliderFill(settings.indent,0,4)"></label>
<label>段间距 {{settings.paraGap}} em<input v-model.number="settings.paraGap" type="range" min="0" max="2" step="0.2" :style="sliderFill(settings.paraGap,0,2)"></label>
<label v-if="isTXT">TXT 段落排版<select v-model="settings.txtLayout" aria-label="TXT 段落排版"><option value="auto">自动整理段落与标题</option><option value="original">原始逐行排版</option></select></label>
<label>对齐<select v-model="settings.align"><option value="justify">两端对齐</option><option value="left">左对齐</option></select></label>
<p v-if="!isTXT">EPUB 保留原书排版，PDF 保留原页面；夜间主题会同时适配。</p>
<p v-else-if="settings.mode==='scroll'"><small>上下滚动为连续阅读，翻页方式只在左右分页下生效。</small></p>
<p v-else><small>{{activeFlip()==='none'&&settings.flip!=='none'?'当前设备或系统动效设置让翻页自动降级为无动画。':'仿真翻页让纸页沿书脊抬起并投下阴影，低端设备会自动降级。'}}</small></p>
<p><small>排版按服务器与账户保存在本机，并同步到你的账户。</small></p>
</template>
<template v-if="panel==='annotation'"><h2>标记这一段</h2>
<blockquote>{{selection?.quote}}</blockquote>
<label>批注<textarea v-model="noteText" rows="4" placeholder="记下你的想法"></textarea></label>
<label>颜色<input type="color" v-model="highlightColor" aria-label="标记颜色"></label>
<button class="primary" @click="createNote('note')">保存笔记</button>
<button @click="createNote('highlight')">仅高亮</button>
</template>
<template v-if="panel==='notes'"><div class="catalog-notes-body"><div class="catalog-note-actions">
<button @click="selection=null;createNote('bookmark',true)">在当前页添加书签</button>
<button @click="exportNotes" :disabled="!notes.length">导出 Markdown</button></div>
<div v-if="!notes.length" class="catalog-note-empty"><svg viewBox="0 0 120 100" width="112" height="100" aria-hidden="true"><path d="M15 20q22-10 45 4q23-14 45-4v56q-23-10-45 4q-23-14-45-4z" fill="currentColor" opacity=".12"/><path d="M60 24v56M27 39q12-4 24 3M27 53q12-4 24 3M71 41q10-4 21-3" fill="none" stroke="currentColor" stroke-width="4" opacity=".2" stroke-linecap="round"/></svg><p>在这里查看本书的划线、想法、书签</p><small>长按或选中正文，记下阅读时的想法</small></div>
<article v-for="n in notes" :key="n.id" class="note-item">
<button class="text-button" @click="goTo(n.start_locator,n.chapter_idx)">{{n.kind==='bookmark'?'书签':n.quote}}</button>
<p>{{n.note}}</p><small>{{n.start_locator}}</small>
<button @click="deleteNote(n)">删除</button>
</article>
</div></template>
<template v-if="panel==='search'"><h2>书内搜索</h2>
<form @submit.prevent="search"><label class="sr-only" for="reader-search">书内关键词</label><input id="reader-search" v-model="query" required placeholder="输入关键词"><button>查找</button></form>
<p v-if="searched&&!hits.length" role="status">没有找到匹配的内容。</p>
<article v-for="(h,i) in hits" :key="i" class="note-item"><button @click="goTo(h.locator??h.cfi??'',h.idx??chapter)">{{h.title??h.label??'匹配位置'}}</button><p>{{h.excerpt}}</p></article>
</template>
<template v-if="panel==='speech'"><h2>听这本书</h2>
<label>朗读引擎<select v-model="speechEngine"><option value="browser">浏览器系统语音</option><option value="edge">内置中文朗读</option><option value="custom">服务器 HTTP TTS</option></select></label>
<p v-if="ttsEngineError" role="alert" class="error">{{ttsEngineError}}</p>
<p v-else-if="ttsEngines" class="muted">服务器引擎：内置中文朗读 {{ttsEngines.edge_enabled?'已启用':'未启用'}} · 自定义 HTTP TTS {{ttsEngines.custom_enabled?'已启用':'未启用'}}</p>
<label v-if="speechEngine==='edge'">服务器音色<select v-model="edgeVoice"><option value="zh-CN-XiaoxiaoNeural">晓晓 · 中文女声</option><option value="zh-CN-YunxiNeural">云希 · 中文男声</option><option value="zh-CN-XiaoyiNeural">晓伊 · 中文女声</option><option value="zh-CN-YunjianNeural">云健 · 中文男声</option></select></label>
<label v-if="speechEngine==='browser'">系统音色<select v-model="speechVoice"><option value="">默认中文音色</option><option v-for="v in voices" :key="v.voiceURI" :value="v.voiceURI">{{v.name}} · {{v.lang}}</option></select></label>
<label>语速 {{speechRate}}<input type="range" v-model.number="speechRate" min="0.5" max="2" step="0.1" :style="sliderFill(speechRate,0.5,2)"></label>
<label>音量<input type="range" v-model.number="speechVolume" min="0" max="1" step="0.1" aria-label="音量" :style="sliderFill(speechVolume,0,1)"></label>
<label>定时关闭（分钟，0 不关闭）<input type="number" v-model.number="timerMinutes" min="0" max="180"></label>
<button class="primary" @click="startSpeech" :disabled="speechPreparing||speaking||(!isTXT&&(documentSpeechState.busy||!documentSpeechState.available))">{{speechPreparing?'正在提取文字…':speechPaused?'继续朗读':speaking?'正在朗读':'开始朗读'}}</button>
<button @click="pauseSpeech" :disabled="!speaking">暂停</button>
<button @click="stopSpeech" :disabled="!speaking&&!speechPaused">停止</button>
<p role="status" aria-live="polite">{{speaking?`正在逐句朗读（${effectiveEngine==='browser'?'系统语音':effectiveEngine==='edge'?'内置中文朗读':'服务器 HTTP TTS'}），读完自动续章`:(speechPaused?'朗读已暂停':documentSpeechState.reason&&!isTXT?documentSpeechState.reason:(speechEngineIssue||'系统语音由设备提供；服务器引擎失败会自动回退。'))}}</p>
</template>
</section></div>
<div v-if="conflict" class="modal-backdrop reader-modal"><section class="sheet" role="dialog" aria-modal="true" aria-label="进度冲突"><h2>另一台设备读到了新的位置</h2>
<p>服务器位置：{{conflict.locator}}<template v-if="conflict.chapter_idx!==undefined"> · 第 {{Number(conflict.chapter_idx)+1}} 章</template><template v-if="conflict.updated_at"> · {{new Date(conflict.updated_at).toLocaleString()}}</template></p>
<p>本机位置：{{locatorNow()}}。两边都不会自动覆盖，请选择要继续的位置。</p>
<div class="conflict-actions"><button class="primary" @click="chooseServerProgress">使用服务器位置</button><button @click="keepLocalProgress">保留本机位置并覆盖服务器</button></div>
<p><small>“保留本机位置”会以更新的时间戳写入，服务器会接受这一次覆盖。</small></p>
</section></div>
</main></template>

<!-- Reader surface: paper texture, book geometry, page-turn animation and paragraph
     typography. Deliberately `:global()` instead of `scoped`: the rules must reach the
     turn-shadow layer and the animated column block without extra wrapper elements, and
     they are all namespaced under `.reader` so they cannot leak into other surfaces.
     Everything here is CSS gradients plus one inline SVG grain tile - no image assets. -->
<style>
/* --- paper + book surface ------------------------------------------------- */
.reader-grain{position:fixed;inset:0;z-index:0;pointer-events:none;background-image:var(--paper-grain-image);background-repeat:repeat;opacity:var(--paper-grain-opacity,0)}
.reader>.text-viewport,.reader>.document-reader,.reader>.error,.reader>.reading-loading{position:relative;z-index:1}
/* The spine fold: a hairline where the sheet meets the binding plus a shadow that is
   strongest at the top and bottom of the fold, where a real page curls away. Kept
   narrow (~1.6em) because a wide gutter band visibly greys the first characters of
   every line. The outer edge gets a much softer equivalent. */
.reader .text-viewport{isolation:isolate;contain:paint}
.reader .text-viewport::before{content:'';position:absolute;z-index:2;inset:0 auto 0 0;width:1.6em;pointer-events:none;background:linear-gradient(90deg,var(--reader-fold) 0,transparent 100%),linear-gradient(180deg,var(--reader-gutter) 0,transparent 14%,transparent 86%,var(--reader-gutter) 100%)}
.reader .text-viewport::after{content:'';position:absolute;z-index:2;inset:0 0 0 auto;width:.7em;pointer-events:none;background:linear-gradient(270deg,var(--reader-edge) 0,transparent 100%)}
.reader.reader .text-viewport{width:calc(100% - 64px);max-width:760px;padding:30px clamp(28px,3.4vw,44px) 36px;}
.reader .text-page-window{position:relative;height:100%;width:100%;overflow:hidden;}
.reader .text-columns{width:100%;}
.reader.scroll .text-page-window{height:auto;min-height:100%;overflow:visible;}
.reader .text-viewport.txt-spread::before{left:50%;width:48px;transform:translateX(-50%);background:linear-gradient(90deg,transparent,var(--reader-gutter) 42%,var(--reader-fold) 50%,var(--reader-gutter) 58%,transparent);}
.reader .text-viewport.txt-spread::after{width:100%;background:linear-gradient(90deg,var(--reader-edge),transparent 16px,transparent calc(100% - 16px),var(--reader-edge));}
@media(min-width:1000px) and (pointer:fine){.reader.paginated .text-viewport{width:calc(100% - 112px);max-width:1240px;}}
@media(max-width:650px){.reader.reader .text-viewport{width:calc(100% - 24px);padding:22px 16px 26px;}}
.reader .txt-auto .text-columns .txt-body{padding-block:max(var(--para-gap,0em),.22em);white-space:normal;}
.reader .txt-auto .text-columns .txt-body span{white-space:normal;}
.reader .txt-auto .text-columns .txt-heading{font-size:1.02em;font-weight:600;line-height:1.5;text-indent:0;text-align:left;margin:.8em 0 .6em;break-after:avoid;}
.reader .txt-auto .text-columns .txt-verse,.reader .txt-auto .text-columns .txt-list{text-indent:0;text-align:left;white-space:pre-wrap;padding-block:max(var(--para-gap,0em),.12em);}
.reader .text-columns{transform:var(--text-base-transform,translate3d(0,0,0));transform-origin:var(--flip-origin,right center);will-change:transform;transition:none}
.reader .text-columns h2{font-size:1.25em;font-weight:600;line-height:1.5;letter-spacing:.02em;margin:0 0 .85em;break-after:avoid}
/* --- paragraph typography (spec 9.3) -------------------------------------- */
.reader .text-columns .para{margin:0;padding:0;padding-block:var(--para-gap,0);text-indent:var(--para-indent,0);text-align:var(--reader-align,justify);white-space:pre-wrap;overflow-wrap:break-word;line-height:inherit}
/* The h2 and the first paragraph should not double-space. */
.reader .text-columns h2+.para{padding-block-start:0}
/* --- page turn ------------------------------------------------------------ */
.reader .turn-shadow{position:absolute;z-index:5;inset:0;pointer-events:none;opacity:0;background-image:linear-gradient(100deg,transparent 55%,var(--reader-gutter) 88%,transparent 100%);background-repeat:no-repeat;background-size:100% 100%;background-position:0 0;will-change:transform,opacity}
/* --- page indicator: tabular figures so the counter does not jitter -------- */
.reader .page-indicator{font-variant-numeric:tabular-nums;letter-spacing:.01em}
.reader.scroll .page-indicator{font-variant-numeric:normal}
/* --- immersive chrome: overlay bars inside permanently reserved bands ------
   The bars are fixed overlays and the text viewport keeps a band top and bottom that
   the columns never enter. That is deliberate: with CSS columns, insetting the text
   while the bars are visible would re-flow every line, and NOT insetting it would let
   the bars cover the first and last line. A permanently reserved band is the only
   geometry where "bars visible" and "bars hidden" are pixel-identical for the text, so
   the page table (and therefore the `c:<offset>` locator) is never re-measured by a
   toggle. Each band is exactly its bar's height plus a small breathing gap, so the
   revealed bar lands in empty space instead of on a line. */
.reader.reader{
--reader-chrome-top:50px;--reader-chrome-bottom:52px;
--reader-gap-top:8px;--reader-gap-bottom:10px;
--reader-band-top:calc(var(--reader-chrome-top) + env(safe-area-inset-top,0px) + var(--reader-gap-top));
--reader-band-bottom:calc(var(--reader-chrome-bottom) + env(safe-area-inset-bottom,0px) + var(--reader-gap-bottom));
}
@media(max-width:650px){
.reader.reader{--reader-chrome-top:48px;--reader-chrome-bottom:50px;--reader-gap-top:6px;--reader-gap-bottom:8px}
}
/* Doubled `.reader` class: these must win over style.css whatever order the bundler
   emits the two stylesheets in (style.css is imported after the views in main.ts). */
.reader.reader .text-viewport{margin:var(--reader-band-top) auto var(--reader-band-bottom)}
/* EPUB/PDF get the same reserved bands, so the overlays never sit on top of a rendered
   page either - and the band itself is a tap surface that reveals the bars. */
.reader.reader>.document-reader{margin:var(--reader-band-top) 0 var(--reader-band-bottom)}
.reader.reader>.text-viewport,.reader.reader>.document-reader,.reader.reader>.reading-loading{position:relative;z-index:1}
.reader.reader>.reader-toolbar,.reader.reader>.reader-footer{
position:fixed;left:0;right:0;z-index:20;display:flex;align-items:center;gap:6px;flex-wrap:nowrap;
font:13px/1.4 system-ui;padding:0 8px;background:var(--surface);color:inherit;
opacity:0;visibility:hidden;pointer-events:none;
transition:opacity .18s ease,transform .18s ease,visibility 0s linear .18s;
}
.reader.reader>.reader-toolbar{top:0;height:calc(var(--reader-chrome-top) + env(safe-area-inset-top,0px));padding-top:env(safe-area-inset-top,0px);border-bottom:1px solid var(--border);box-shadow:0 8px 18px -14px #0007;transform:translateY(-8px)}
.reader.reader>.reader-footer{bottom:0;height:calc(var(--reader-chrome-bottom) + env(safe-area-inset-bottom,0px));padding-bottom:env(safe-area-inset-bottom,0px);justify-content:center;border-top:1px solid var(--border);box-shadow:0 -8px 18px -14px #0007;transform:translateY(8px)}
.reader.reader>.reader-toolbar.shown,.reader.reader>.reader-footer.shown{opacity:1;visibility:visible;pointer-events:auto;transform:none;transition-delay:0s}
/* Borderless 44px touch targets: the bar itself is the surface. */
.reader.reader .reader-chrome button,.reader.reader .reader-chrome .button{
min-height:44px;min-width:44px;flex:0 0 auto;padding:6px 10px;font-size:13px;font-weight:400;
border:0;background:transparent;border-radius:8px;color:inherit;white-space:nowrap;
}
@media(hover:hover){
.reader.reader .reader-chrome button:hover,.reader.reader .reader-chrome .button:hover{background:color-mix(in srgb,var(--muted) 16%,transparent)}
}
/* The title gives way first when the bar runs out of room at 375px. */
.reader.reader .reader-toolbar .reader-book-title{flex:1 1 auto;order:0;width:auto;min-width:0;padding:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* Thin progress line along the bottom edge of the top overlay. */
.reader.reader .reader-toolbar .reader-progress{position:absolute;left:0;right:0;bottom:0;width:100%;max-width:none;margin:0;height:2px;border-radius:0;background:transparent}
.reader.reader .reader-footer .page-indicator{flex:1 1 auto;min-width:0;min-height:44px;padding:6px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Status feedback floats above the bottom bar instead of adding a second row, and
   stays legible while the bar itself is hidden: it is feedback, not chrome. */
.reader.reader>.reader-footer small{
position:absolute;left:50%;bottom:calc(100% + 10px);transform:translateX(-50%);
width:auto;min-height:0;max-width:calc(100vw - 24px);padding:6px 12px;border-radius:999px;
border:1px solid var(--border);background:var(--surface);color:var(--muted);
text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
visibility:visible;opacity:0;transition:opacity .18s ease;pointer-events:none
}
.reader.reader>.reader-footer small:not(:empty){opacity:1}
/* An error must not resize the reading box either. */
.reader.reader>.error{position:fixed;top:calc(var(--reader-band-top) + 4px);left:50%;right:auto;transform:translateX(-50%);z-index:30;max-width:min(560px,calc(100vw - 24px));margin:0}
/* 375px: tighter padding, never below the 44px target, so the page counter stays
   readable instead of being ellipsised down to a couple of digits. Declared after the
   base rules on purpose: they have the same specificity. */
@media(max-width:650px){
.reader.reader>.reader-toolbar,.reader.reader>.reader-footer{gap:4px}
.reader.reader .reader-toolbar button,.reader.reader .reader-toolbar .button{padding:6px 8px;font-size:12px}
.reader.reader .reader-footer button{padding:6px 4px;font-size:12px}
.reader.reader .reader-footer .page-indicator{padding:6px 6px;font-size:12px}
.reader.reader .reader-toolbar .reader-book-title{font-size:12px}
}
/* --- book surface only where there is room for margins (no overflow at 375px) */
@media(min-width:900px){
.reader.paginated .text-viewport{background:var(--reader-paper);border-radius:3px 8px 8px 3px;box-shadow:0 1px 0 var(--reader-edge),0 18px 40px -22px var(--reader-page-shadow),0 2px 6px -2px var(--reader-edge)}
}
/* --- reduced motion: the page swap stays instant and no turn runs ---------- */
@media(prefers-reduced-motion:reduce){
.reader .text-columns{transition:none!important;will-change:auto}
.reader .turn-shadow{display:none}
.reader.reader>.reader-toolbar,.reader.reader>.reader-footer,.reader.reader>.reader-footer small{transition:none}
}

/* Catalog layout follows the supplied Huawei reader references: floating paper
   card, book identity, two-way segments and a separate current-position row. */
.reader-modal:has(.reader-catalog-sheet){align-items:flex-start;padding:5.5dvh 16px 0;background:#443b2e38;backdrop-filter:blur(7px)}
.reader-modal .reader-catalog-sheet{display:flex;flex-direction:column;width:100%;max-width:540px;height:min(82dvh,760px);max-height:82dvh;padding:20px 23px 18px;border-radius:25px;background:var(--reader-card,var(--surface));box-shadow:0 18px 55px #332b1c24;overflow:hidden;--catalog-selected:#fffdf7;--catalog-accent:#ba942d}
.reader.theme-parchment .reader-catalog-sheet{--reader-card:#fdf9ef;--catalog-selected:#fffdf8;--catalog-accent:#c19a33}
.reader.theme-night .reader-catalog-sheet{--catalog-selected:#363b37;--catalog-accent:#d5b55c}
.reader-modal .reader-catalog-sheet>.close{top:12px;right:12px;padding:9px;min-width:43px;min-height:43px;border:0;border-radius:50%;background:color-mix(in srgb,currentColor 4%,transparent);color:inherit}
.catalog-notes-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}.catalog-note-actions{display:flex;gap:8px;padding:16px 0 8px}.catalog-note-actions button{font:12px/1.5 system-ui;padding:7px 10px;min-height:38px;margin:0;border-color:var(--border);background:transparent}
.catalog-note-empty{flex:1;min-height:170px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted);font:14px/1.6 system-ui;text-align:center}.catalog-note-empty svg{margin:25px 0 6px}.catalog-note-empty p{margin:6px 0}.catalog-note-empty small{font-size:12px}
@media(max-width:650px){.reader-modal:has(.reader-catalog-sheet){align-items:flex-start}.reader-modal .reader-catalog-sheet{height:82dvh;max-height:82dvh;border-radius:25px;padding:17px 22px 16px}}

</style>

<style>
.reader-version-notice{position:fixed;z-index:35;top:calc(env(safe-area-inset-top,0px) + 2px);left:50%;transform:translateX(-50%);display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:640px;width:calc(100% - 16px);box-sizing:border-box;padding:2px 8px;background:var(--reader-paper,var(--surface));color:var(--reader-ink,var(--text));border:1px solid var(--border);border-radius:10px;font:13px/1.4 system-ui;box-shadow:0 4px 16px #0002}.reader-version-notice small{display:block;font-size:11px;color:var(--reader-muted,var(--muted))}.reader-version-notice button{min-height:44px;margin:0;flex:none;font-size:12px;padding:6px 10px}
</style>

<style>
.reader-introduction{position:fixed;z-index:5;inset:var(--reader-band-top) max(72px,calc((100vw - 1080px)/2)) var(--reader-band-bottom);background:var(--reader-paper);color:var(--reader-ink);overflow:auto;padding:32px 36px;box-sizing:border-box}.reader-introduction h1{font-size:30px;margin:0 0 8px;overflow-wrap:anywhere}.reader-introduction header>p{color:var(--reader-muted);font-size:15px}.introduction-body{display:grid;grid-template-columns:260px minmax(0,1fr);gap:44px;align-items:start;margin-top:32px}.introduction-body .book-cover{height:auto;width:260px;aspect-ratio:3/4;max-height:420px}.book-synopsis{white-space:pre-line;line-height:1.9;font-size:16px;overflow-wrap:anywhere}.desktop-page-arrow{position:fixed;top:50%;transform:translateY(-50%);z-index:22;border-radius:50%;width:46px;height:46px;padding:0;gap:0;line-height:0;display:flex;align-items:center;justify-content:center;border:1px solid var(--reader-edge);background:var(--reader-paper);color:var(--reader-ink);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s,visibility .2s}.desktop-page-arrow.previous{left:14px}.desktop-page-arrow.next{right:14px}.desktop-page-arrow.shown{opacity:.85;visibility:visible;pointer-events:auto}.desktop-page-arrow:hover,.desktop-page-arrow:focus{opacity:1}.desktop-page-arrow:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.desktop-page-arrow:disabled{opacity:.3}@media(prefers-reduced-motion:reduce){.desktop-page-arrow{transition:none}}@media(max-width:1000px){.reader-introduction{padding:24px}.introduction-body{grid-template-columns:210px minmax(0,1fr);gap:24px}.introduction-body .book-cover{width:210px}}
</style>
<style>
/* Reserve real iframe gutters so compositor hit testing cannot capture arrow clicks. */
@media(min-width:800px) and (pointer:fine){.reader.reader>.document-reader{margin-left:72px;margin-right:72px;min-width:0}.reader.reader>.desktop-page-arrow{z-index:40}}
</style>

<style>.reader-floating-navigation{position:fixed;inset:0;z-index:45;pointer-events:none}.reader-floating-navigation .desktop-page-arrow{z-index:45}.reader-floating-navigation .desktop-page-arrow:hover,.reader-floating-navigation .desktop-page-arrow:focus,.reader-floating-navigation .desktop-page-arrow:active{transform:translateY(-50%);background:var(--reader-paper);border-color:var(--reader-edge)}</style>
