import path from 'node:path';
import { readJSON } from './curation.mjs';
import { familiarSearchPlan,discoveryQueryKey,matchingFamiliarTopics } from './familiar-policy.mjs';
import { isFreshEntry,comparisonProfile } from './product-comparison.mjs';
import { isUsableRecord,exclusionsFor } from './source-operations.mjs';
import { kstDate } from './procurement-api.mjs';

export const SEARCH_PLAN_EXHAUSTED_MESSAGE='검색 목록 추가가 필요합니다. 등록한 검색 조건을 모두 확인했고, 저장 자료에도 추가할 새 후보가 없습니다. 새로운 물건 종류나 검색어를 검색 목록에 추가해 주세요.';

export function candidateTopicIds(plan,candidate) {
  const ids=new Set(matchingFamiliarTopics(plan.topics,candidate).map(topic=>topic.id));
  // Preserve the original kind even if a later scope rule no longer matches it.
  if(candidate.discoveryTopicId && plan.topics.some(topic=>topic.id===candidate.discoveryTopicId))ids.add(candidate.discoveryTopicId);
  return ids;
}
export function seenDiscoveryTopics(plan,catalog) {
  const seen=new Set();
  // Discovery means a kind the user has never seen. Exclusion does not reopen
  // that kind for automatic replacement by a different manufacturer/model.
  for(const candidate of catalog.candidates)
    for(const id of candidateTopicIds(plan,candidate))seen.add(id);
  return seen;
}
// Keep the previous export for callers using the older name.
export const occupiedTopics=seenDiscoveryTopics;

export function reintroducedCandidates(plan,catalog,review) {
  const excluded=new Map();
  for(const candidate of catalog.candidates)if(review.decisions[candidate.id]?.status==='excluded')
    for(const topicId of candidateTopicIds(plan,candidate))if(!excluded.has(topicId))excluded.set(topicId,candidate.id);
  return catalog.candidates.filter(candidate=>review.decisions[candidate.id]?.status==='unreviewed'&&candidate.discoverySource!=='human-comparison-choice')
    .flatMap(candidate=>{
      const topicId=[...candidateTopicIds(plan,candidate)].find(id=>excluded.has(id));
      return topicId?[{id:candidate.id,previousId:excluded.get(topicId),topicId}]:[];
    });
}
export function pendingDiscoveryJobs(plan,cache,occupied,{searches,now=Date.now()}={}) {
  const sources=searches?searches.map(([id,term,operation='getMASCntrctPrdctInfoList'])=>({id,term,operation,key:discoveryQueryKey(operation,term),phase:0})):familiarSearchPlan(plan);
  const fresh=entry=>entry&&isFreshEntry(entry,now);
  const attemptedTopics=new Set(sources.filter(source=>cache.queries[source.key]).map(source=>source.id));
  const jobs=[];let cacheHits=0;
  for(const source of sources) {
    if(occupied.has(source.id))continue;
    const first=cache.queries[source.key];
    if(!fresh(first)){jobs.push({...source,page:1});continue;}
    cacheHits++;
    const pageSize=first.pageSize || first.parameters?.numOfRows || 100;
    const lastPage=Math.min(3,Math.ceil(first.totalCount/pageSize));
    for(let page=2;page<=lastPage;page++) {
      const key=discoveryQueryKey(source.operation,source.term,page);
      if(!fresh(cache.queries[key])){jobs.push({...source,key,page,phase:4});break;}
      cacheHits++;
    }
  }
  // Do not burn another whole batch on an endpoint that recently returned
  // almost nothing. After enough evidence, try alternate official names first.
  // A first zero result still gets the other main contract type as a fallback.
  const lowYield=new Set();
  for(const operation of new Set(sources.map(source=>source.operation))) {
    const recent=(cache.runs||[]).filter(run=>run.operation===operation&&run.status==='complete').slice(-30);
    if(recent.length>=20&&recent.filter(run=>run.returned>0).length/recent.length<=.1)lowYield.add(operation);
  }
  const priority=job=>job.page>1?1.5:job.phase+(job.phase!==2&&lowYield.has(job.operation)?2:0);
  jobs.sort((a,b)=>priority(a)-priority(b)||Number(attemptedTopics.has(a.id))-Number(attemptedTopics.has(b.id)));
  return {jobs,cacheHits};
}
export async function getDiscoveryStatus(root,catalog,review) {
  const plan=await readJSON(path.join(root,'content/familiar-item-topics.json'));
  let cache;try{cache=await readJSON(path.join(root,'.artifacts/familiar-source-cache.json'));}catch(error){if(error.code!=='ENOENT')throw error;cache={queries:{},runs:[]};}
  const occupied=seenDiscoveryTopics(plan,catalog),{jobs}=pendingDiscoveryJobs(plan,cache,occupied);
  const known=new Set([...catalog.candidates.map(c=>c.productId),...Object.keys(exclusionsFor(catalog,review))]);
  const imageUrls=new Set(catalog.candidates.map(c=>c.image.sourceUrl));
  const cachedTopics=new Set(),day=kstDate();
  const consider=(row,checkedAt)=>{
    if(!isFreshEntry({checkedAt})||known.has(row.prdctIdntNo)||imageUrls.has(row.prdctImgUrl)||/image_non\.svg/.test(row.prdctImgUrl||'')||!isUsableRecord(row,day))return;
    const matching=matchingFamiliarTopics(plan.topics,row);
    if(matching.length===1&&!occupied.has(matching[0].id)&&comparisonProfile(matching[0],row))cachedTopics.add(matching[0].id);
  };
  for(const entry of Object.values(cache.queries))for(const row of entry.items || [])consider(row,entry.checkedAt);
  try{const state=await readJSON(path.join(root,'.artifacts/source-state.json'));for(const source of Object.values(state.sources || {}))for(const entry of source.buffer || [])consider(entry.row,entry.checkedAt);}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const exhausted=!jobs.length&&!cachedTopics.size;
  return {totalTopics:plan.topics.length,coveredTopics:occupied.size,seenTopics:occupied.size,unseenTopics:plan.topics.length-occupied.size,unresolvedTopics:plan.topics.length-occupied.size,
    remainingQueries:jobs.length,cachedNewTopics:cachedTopics.size,canCollect:Boolean(jobs.length||cachedTopics.size),
    exhausted,actionRequired:exhausted?'expand_search_plan':null,message:exhausted?SEARCH_PLAN_EXHAUSTED_MESSAGE:null,
    recordedApiRequests:cache.runs.length};
}
