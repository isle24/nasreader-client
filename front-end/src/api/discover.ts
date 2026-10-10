// Online-source discovery (「在线书源」): search every configured adapter at once,
// pick many candidates, download+import them in chunks, or paste a title list.
//
// Everything that decides *what happens* (merging per-source answers, matching a
// pasted line against candidates, chunking an import, aggregating the outcome) is a
// pure function in this module so it can be tested without a DOM. The HTTP calls are
// built from an injected client; the view passes the app's shared `api`.
//
// Sources are administrator configured, including opt-in public platform adapters
// and personal SoNovel/reader services. Search requires an explicit user action.
import {errorMessage,integrationError,isUnavailable} from './errors';

/** Present only in administrator responses; tokens are never returned. */
export interface PlatformSafeConfig {mode:'web'|'api'|'reader';api_base_url?:string;has_api_token?:boolean;reader_adapter_id?:number;source_key?:string}
export interface AdapterRef {id:number;name:string;kind:string;base_url?:string;enabled?:boolean;has_secret?:boolean;supported?:boolean;capabilities?:string[];issues?:string[];version?:number|string;subscription_id?:number;engine?:string;platform_config?:PlatformSafeConfig}
export interface Candidate {id:string;title:string;author:string;url:string;filename?:string;format?:string;origin?:string;source_name?:string;local_book_id?:number|null;cover_url?:string;can_update?:boolean}
export interface ImportJob {id:number;status?:string;book_id?:number|null;error?:string;result_kind?:'added'|'updated'|'unchanged'|'conflict';result_book_id?:number|null}
export interface ImportSummary {total:number;running:number;pending:number;completed:number;failed:number;processed:number;books_added:number}
export interface ImportBatchResponse {jobs?:ImportJob[];total?:number;skipped?:{candidate_id?:string;reason?:string}[]}

/** The subset of ApiClient this module needs; injecting it keeps tests DOM-free. */
export interface DiscoverClient {get<T=any>(path:string):Promise<T>;post<T=any>(path:string,body?:unknown):Promise<T>}

export interface DiscoverApi {
  listAdapters():Promise<AdapterRef[]>;
  searchAdapter(id:number,q:string,libraryId?:number):Promise<Candidate[]>;
  cachedCandidates(id:number,q:string,limit?:number,libraryId?:number):Promise<Candidate[]>;
  importBatch(id:number,candidateIds:string[],libraryId?:number):Promise<ImportBatchResponse>;
  importsSummary(ids:number[]):Promise<ImportSummary>;
  importsByIds(ids:number[]):Promise<ImportJob[]>;
}

let requestSequence=0;
/** getRandomValues also works on the HTTP origins commonly used by home NASes. */
export function importRequestKey():string{
  const random=globalThis.crypto?.getRandomValues(new Uint32Array(4));
  return `import-${Date.now().toString(36)}-${++requestSequence}-${random?Array.from(random,n=>n.toString(36)).join('-'):Math.random().toString(36).slice(2)}`;
}
export function createDiscoverApi(client:DiscoverClient):DiscoverApi{
  const list=<T>(value:any):T[]=>Array.isArray(value)?value:(Array.isArray(value?.items)?value.items:[]);
  return {
    async listAdapters(){return list<AdapterRef>(await client.get('/adapters'))},
    async searchAdapter(id,q,libraryId){return list<Candidate>(await client.post(`/adapters/${id}/search`,{q,remote:true,...(libraryId?{library_id:libraryId}:{})}))},
    async cachedCandidates(id,q,limit=200,libraryId){return list<Candidate>(await client.get(`/adapters/${id}/candidates?q=${encodeURIComponent(q)}&limit=${limit}${libraryId?'&library_id='+libraryId:''}`))},
    async importBatch(id,candidateIds,libraryId){return await client.post<ImportBatchResponse>(`/adapters/${id}/import-batch`,{candidate_ids:candidateIds,request_key:importRequestKey(),...(libraryId?{library_id:libraryId}:{})})},
    async importsSummary(ids){return await client.get<ImportSummary>(`/imports/summary?ids=${ids.join(',')}`)},
    async importsByIds(ids){return list<ImportJob>(await client.get(`/imports?ids=${ids.join(',')}`))},
  };
}

/** Only enabled adapters are searched; a disabled one is a configuration state, not an error. */
export function enabledAdapters(adapters:AdapterRef[]):AdapterRef[]{
  return (adapters??[]).filter(a=>a.enabled!==false&&a.supported!==false);
}

/* ---------------------------------------------------------------- searching */

export interface SourceOutcome {adapter_id:number;adapter_name:string;status:'pending'|'searching'|'ok'|'error'|'unavailable';candidates:Candidate[];error:string}

/** Placeholder rows so each source can show its own 「搜索中」 progress. */
export function pendingOutcomes(adapters:AdapterRef[]):SourceOutcome[]{
  return (adapters??[]).map(adapter=>({adapter_id:adapter.id,adapter_name:adapter.name,status:'pending',candidates:[],error:''}));
}

/**
 * Queries every adapter concurrently. Each source resolves on its own: one dead
 * source yields a row with its own error while the others still deliver results.
 * A missing route (404/405/501) is reported as 「暂不可用」 rather than as an empty
 * source, so an unimplemented server surface never looks like "no matches".
 */
export async function searchAllSources(adapters:AdapterRef[],q:string,search:(adapter:AdapterRef,q:string)=>Promise<Candidate[]>,onOutcome?:(outcome:SourceOutcome)=>void):Promise<SourceOutcome[]>{
  const completed:SourceOutcome[]=[];
  await Promise.all((adapters??[]).map(async adapter=>{
    const base={adapter_id:adapter.id,adapter_name:adapter.name};
    let outcome:SourceOutcome;
    try{
      const rows=(await search(adapter,q))??[];
      outcome={...base,status:'ok',candidates:dedupeCandidates(adapter,rows),error:''};
    }catch(e){
      outcome={...base,status:isUnavailable(e)?'unavailable':'error',candidates:[],error:isUnavailable(e)?integrationError('搜索',e):errorMessage(e)};
    }
    completed.push(outcome);
    onOutcome?.(outcome);
    return outcome;
  }));
  return completed;
}

/** Fills in the source name/id and drops rows the server repeated within one source. */
export function dedupeCandidates(adapter:AdapterRef,rows:Candidate[]):Candidate[]{
  const seen=new Set<string>(),out:Candidate[]=[];
  for(const raw of rows??[]){
    if(!raw||typeof raw!=='object')continue;
    const title=typeof raw.title==='string'?raw.title:'';
    const author=typeof raw.author==='string'?raw.author:'';
    const url=typeof raw.url==='string'?raw.url:'';
    const id=String(raw.id||url||`${title}|${author}`);
    if(seen.has(id))continue;
    seen.add(id);
    out.push({...raw,id,title,author,url,source_name:raw.source_name||adapter.name});
  }
  return out;
}

export interface DiscoverRow extends Candidate {key:string;adapter_id:number;adapter_name:string;local:boolean;local_book_id:number|null}

/** Flattens per-source outcomes into table rows; rows keep their source identity. */
export function mergeRows(outcomes:SourceOutcome[]):DiscoverRow[]{
  const rows:DiscoverRow[]=[],seen=new Set<string>();
  for(const outcome of outcomes??[]){
    for(const candidate of outcome.candidates??[]){
      const key=`${outcome.adapter_id}:${candidate.id}`;
      if(seen.has(key))continue;
      seen.add(key);
      const localId=Number(candidate.local_book_id??0)||0;
      rows.push({...candidate,source_name:candidate.source_name||outcome.adapter_name,key:`${outcome.adapter_id}:${candidate.id}`,adapter_id:outcome.adapter_id,adapter_name:outcome.adapter_name,local:localId>0,local_book_id:localId||null});
    }
  }
  return rows;
}

export function isLocal(candidate:Candidate):boolean{return Number(candidate?.local_book_id??0)>0}

/** Local rows require an explicit server grant backed by their source binding. */
export function canImport(candidate:Candidate):boolean{return !isLocal(candidate)||candidate.can_update===true}
export function selectableKeys(rows:DiscoverRow[]):string[]{return (rows??[]).filter(canImport).map(r=>r.key)}

/* ------------------------------------------------------- title-list matching */

export function normalizeText(value:string):string{
  return String(value??'').toLowerCase().replace(/[\s《》〈〉【】\[\]（）()「」『』'"“”·、,，.。:：;；!！?？/\\|_\-—~～]+/g,'');
}

export interface TitleQuery {title:string;author:string}

/** One line of the pasted list: `书名` or `书名,作者` (full-width comma and tab too). */
export function parseTitleLine(line:string):TitleQuery|null{
  const trimmed=String(line??'').trim();
  if(!trimmed||trimmed.startsWith('#'))return null;
  const parts=trimmed.split(/[,，\t]/).map(part=>part.trim()).filter(Boolean);
  if(!parts.length)return null;
  return {title:parts[0],author:parts[1]??''};
}

export type MatchKind='exact'|'exact-author'|'title-author'|'ambiguous'|'none'|'local';
export interface MatchResult<T extends Candidate=Candidate> {kind:MatchKind;query:TitleQuery;candidate:T|null;matches:T[];reason:string}

/**
 * Best match for one title-list line. Confident (`exact` / `exact-author` /
 * unique `title-author`) results are downloaded automatically; anything with more
 * than one plausible hit goes to the review list instead of guessing.
 */
export function pickBestMatch<T extends Candidate>(query:TitleQuery,candidates:T[]):MatchResult<T>{
  const title=normalizeText(query.title),author=normalizeText(query.author);
  const all=(candidates??[]).filter(Boolean) as T[];
  const selectable=all.filter(canImport);
  const exactAll=all.filter(c=>normalizeText(c.title)===title&&title.length>0);
  if(exactAll.length){
    if(author&&exactAll.every(c=>!authorMatches(author,c.author)))return {kind:'ambiguous',query,candidate:null,matches:exactAll,reason:'书名一致但作者不同，请人工确认'};
    const exact=exactAll.filter(canImport);
    if(!exact.length)return {kind:'local',query,candidate:null,matches:exactAll,reason:'这本书已经在本机书库里'};
    if(author){
      const sameAuthor=exact.filter(c=>authorMatches(author,c.author));
      if(sameAuthor.length===1)return {kind:'exact-author',query,candidate:sameAuthor[0],matches:sameAuthor,reason:'书名与作者完全一致'};
      if(sameAuthor.length>1)return {kind:'ambiguous',query,candidate:null,matches:sameAuthor,reason:`有 ${sameAuthor.length} 条同名同作者的候选`};
      return {kind:'ambiguous',query,candidate:null,matches:exact,reason:'书名一致但作者不同，请人工确认'};
    }
    if(exact.length===1)return {kind:'exact',query,candidate:exact[0],matches:exact,reason:'书名完全一致'};
    return {kind:'ambiguous',query,candidate:null,matches:exact,reason:`有 ${exact.length} 条同名候选`};
  }
  // No exact title hit. The second tier is title+author together; a title-only
  // near-miss is never downloaded automatically.
  const loose=selectable.filter(c=>titleLooseMatch(c.title,query.title)&&(!author||authorMatches(author,c.author)));
  if(!author&&loose.length)return {kind:'ambiguous',query,candidate:null,matches:loose,reason:'只有近似书名，且清单未提供作者'};
  if(loose.length===1)return {kind:'title-author',query,candidate:loose[0],matches:loose,reason:'书名近似且作者一致'};
  if(loose.length>1)return {kind:'ambiguous',query,candidate:null,matches:loose,reason:`有 ${loose.length} 条书名近似且作者一致的候选`};
  return {kind:'none',query,candidate:null,matches:[],reason:'没有找到匹配的书'};
}

function titleLooseMatch(candidateTitle:string,queryTitle:string):boolean{
  const left=normalizeText(candidateTitle),right=normalizeText(queryTitle);
  if(left.length<2||right.length<2)return false;
  return left.includes(right)||right.includes(left);
}
function authorMatches(author:string,candidateAuthor:string):boolean{
  const left=normalizeText(candidateAuthor);
  if(!left)return false;
  return left===author||left.includes(author)||author.includes(left);
}

export type LineStatus='pending'|'searching'|'matched'|'review'|'notfound'|'local'|'imported'|'failed'|'cancelled'|'queued'|'updated'|'unchanged'|'conflict';
export interface TitleLine {index:number;raw:string;query:TitleQuery|null;status:LineStatus;candidate:DiscoverRow|null;choices:DiscoverRow[];reason:string}
/** Parses the textarea; blank lines and `#` comments are ignored but line numbers stay. */
export function parseTitleList(text:string):TitleLine[]{
  return String(text??'').split(/\r?\n/).map((raw,index)=>({index,raw,query:parseTitleLine(raw),status:'pending' as LineStatus,candidate:null,choices:[],reason:''})).filter(line=>line.query!==null);
}

/** Re-running the bulk flow only processes lines that have no terminal outcome yet. */
export function unfinishedLines(lines:TitleLine[]):TitleLine[]{
  return (lines??[]).filter(line=>line.status==='pending'||line.status==='searching'||line.status==='matched'||line.status==='failed'||line.status==='cancelled');
}

export interface TitleReport {added:number;review:number;missing:number;local:number;failed:number;pending:number;text:string}
export function titleListReport(lines:TitleLine[],added:number):TitleReport{
  let review=0,missing=0,local=0,failed=0,pending=0;
  for(const line of lines??[]){
    if(line.status==='review'||line.status==='conflict')review++;
    else if(line.status==='notfound')missing++;
    else if(line.status==='local')local++;
    else if(line.status==='failed')failed++;
    else if(line.status==='matched'||line.status==='pending'||line.status==='searching'||line.status==='cancelled'||line.status==='queued')pending++;
  }
  const parts=[`已加入 ${added} 本`,`需人工确认 ${review} 本`,`未找到 ${missing} 本`];
  if(local)parts.push(`已在本机 ${local} 本`);
  if(failed)parts.push(`失败 ${failed} 本`);
  if(pending)parts.push(`待处理 ${pending} 本`);
  return {added,review,missing,local,failed,pending,text:parts.join(' / ')};
}

/* ------------------------------------------------------------ batch importing */

export interface BatchItem {adapter_id:number;candidate_id:string;title?:string}
export interface BatchChunk {adapter_id:number;index:number;size:number;status:'ok'|'error';job_ids:number[];candidate_ids:string[];error:string}
export interface BatchReport {
  requested:number;submitted:number;chunks:BatchChunk[];job_ids:number[];
  skipped:{candidate_id:string;reason:string}[];
  failed_before_queue:{candidate_id:string;reason:string}[];
  summary:ImportSummary|null;summary_error:string;
  success:number;failed:number;skipped_count:number;results?:ImportJob[];
}
export interface BatchOptions {
  chunkSize?:number;
  getSummary?:(jobIds:number[])=>Promise<ImportSummary>;
  getJobs?:(jobIds:number[])=>Promise<ImportJob[]>;
  poll?:{attempts?:number;delayMs?:number};
  onChunk?:(chunk:BatchChunk,done:number,total:number)=>void;
  onPoll?:(summary:ImportSummary)=>void;
}

export function chunk<T>(items:T[],size=50):T[][]{
  if(!(size>0))throw new Error('chunk size must be positive');
  const out:T[][]=[];
  for(let i=0;i<(items??[]).length;i+=size)out.push(items.slice(i,i+size));
  return out;
}

export function importsSettled(summary:ImportSummary|null):boolean{
  return !!summary&&Number(summary.running??0)===0&&Number(summary.pending??0)===0;
}

export async function waitForImports(ids:number[],get:(ids:number[])=>Promise<ImportSummary>,options:{attempts?:number;delayMs?:number;onPoll?:(summary:ImportSummary)=>void}={}):Promise<ImportSummary>{
  const attempts=options.attempts??60,delayMs=options.delayMs??2000;
  let summary=await get(ids);
  options.onPoll?.(summary);
  for(let i=1;i<attempts&&!importsSettled(summary);i++){
    if(delayMs>0)await new Promise(resolve=>setTimeout(resolve,delayMs));
    summary=await get(ids);
    options.onPoll?.(summary);
  }
  return summary;
}

/**
 * Downloads and imports a selection: unique candidates are grouped per adapter and
 * sent in chunks of at most 50 (the server limit). Chunks run sequentially so a huge
 * selection cannot flood the queue; a failed chunk is recorded and the rest still run.
 * Afterwards the job ids are polled through `imports/summary` until they settle.
 */
export async function runBatchImport(items:BatchItem[],importOne:(adapterId:number,candidateIds:string[])=>Promise<ImportBatchResponse>,options:BatchOptions={}):Promise<BatchReport>{
  const unique:BatchItem[]=[];
  const seen=new Set<string>();
  for(const item of items??[]){
    const key=`${item.adapter_id}:${item.candidate_id}`;
    if(seen.has(key))continue;
    seen.add(key);unique.push(item);
  }
  const groups=new Map<number,BatchItem[]>();
  for(const item of unique){
    const group=groups.get(item.adapter_id);
    if(group)group.push(item);else groups.set(item.adapter_id,[item]);
  }
  const jobs:number[]=[],skipped:BatchReport['skipped']=[],failures:BatchReport['failed_before_queue']=[],chunks:BatchChunk[]=[];
  let submitted=0;
  for(const [adapterId,group] of groups){
    const batches=chunk(group,options.chunkSize??50);
    for(let index=0;index<batches.length;index++){
      const ids=batches[index].map(item=>item.candidate_id);
      try{
        const response=(await importOne(adapterId,ids))??{};
        for(const job of response.jobs??[])if(job&&job.id!=null)jobs.push(Number(job.id));
        for(const row of response.skipped??[])skipped.push({candidate_id:String(row?.candidate_id??''),reason:String(row?.reason??'')||'未说明原因'});
        submitted+=ids.length;
        chunks.push({adapter_id:adapterId,index,size:ids.length,status:'ok',job_ids:(response.jobs??[]).map(j=>Number(j?.id)).filter(id=>Number.isFinite(id)),candidate_ids:ids,error:''});
      }catch(e){
        const reason=isUnavailable(e)?integrationError('批量导入',e):errorMessage(e);
        for(const id of ids)failures.push({candidate_id:id,reason});
        chunks.push({adapter_id:adapterId,index,size:ids.length,status:'error',job_ids:[],candidate_ids:ids,error:reason});
      }
      options.onChunk?.(chunks[chunks.length-1],chunks.length,batches.length);
    }
  }
  let summary:ImportSummary|null=null,summaryError='';
  if(jobs.length&&options.getSummary){
    try{summary=await waitForImports(jobs,options.getSummary,{...options.poll,onPoll:options.onPoll})}
    catch(e){summaryError=isUnavailable(e)?integrationError('导入进度',e):errorMessage(e)}
  }
  let results:ImportJob[]|undefined;
  if(jobs.length&&options.getJobs){try{results=await options.getJobs(jobs)}catch(e){summaryError=summaryError||integrationError('导入结果',e)}}
  const success=summary?Number(summary.books_added??0):0;
  const failed=(summary?Number(summary.failed??0):0)+failures.length;
  return {requested:unique.length,submitted,chunks,job_ids:jobs,skipped,failed_before_queue:failures,summary,summary_error:summaryError,success,failed,skipped_count:skipped.length,results};
}

/** The final line the page shows: 成功 N 本 / 失败 M 本 / 跳过 K 项. */
export function formatBatchReport(report:BatchReport):string{
  if(report.results?.some(job=>job.result_kind)){
    const count=(kind:string)=>report.results!.filter(job=>job.result_kind===kind).length;
    const pending=report.results.filter(job=>job.status==='pending'||job.status==='running').length;
    return `新增 ${count('added')} 本 / 更新 ${count('updated')} 本 / 无变化 ${count('unchanged')} 本 / 冲突 ${count('conflict')} 本 / 失败 ${report.failed} 本${pending?` / 待处理 ${pending} 项`:''}`;
  }
  if(report.summary)return `成功 ${report.success} 本 / 失败 ${report.failed} 本 / 跳过 ${report.skipped_count} 项`;
  if(report.job_ids.length)return `已提交 ${report.submitted} 项，导入进度暂不可用 / 失败 ${report.failed} 项 / 跳过 ${report.skipped_count} 项`;
  return `提交失败 ${report.failed} 项 / 跳过 ${report.skipped_count} 项`;
}

/** 「已加入书库：N 本」 — the message the library shows once books landed. */
export function libraryNotice(report:BatchReport):string{
  const added=report.summary?report.success:0;
  return added>0?`已加入书库：${added} 本`:'';
}

/* ------------------------------------------------------------- query strings */

/** `/#/discover?q=…` link used by the library's empty search state. */
export function discoverHash(q:string):string{
  const value=String(q??'').trim();
  return value?`/discover?q=${encodeURIComponent(value)}`:'/discover';
}

/** Reads `q` back out of a route query object, a `?q=…` string or a full hash. */
export function discoverQueryOf(source:{q?:unknown}|string|undefined|null):string{
  if(source&&typeof source==='object')return typeof source.q==='string'?source.q:source.q==null?'':String(source.q);
  const raw=String(source??'');
  const query=raw.includes('?')?raw.slice(raw.indexOf('?')+1):raw;
  const match=/(?:^|&)q=([^&]*)/.exec(query);
  if(!match)return '';
  try{return decodeURIComponent(match[1].replace(/\+/g,' '))}catch{return match[1]}
}

/** A skipped candidate changes job ordering, so only map complete batches. */
export function importCandidateResult(report:BatchReport,adapter:number,candidate:string):ImportJob|undefined{
  const batch=report.chunks.find(chunk=>chunk.adapter_id===adapter&&chunk.candidate_ids.includes(candidate));
  if(!batch||batch.job_ids.length!==batch.candidate_ids.length)return;
  const jobID=batch.job_ids[batch.candidate_ids.indexOf(candidate)];
  return report.results?.find(job=>job.id===jobID);
}
