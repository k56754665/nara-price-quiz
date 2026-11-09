import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readJSON, writeJSON, loadCatalog } from './curation.mjs';
import { createProcurementApi, loadServiceKey, kstDate, sha256 } from './procurement-api.mjs';
import { createSourceOperations, isUsableRecord, normalizeRecord, exclusionsFor } from './source-operations.mjs';
import { matchingFamiliarTopics } from './familiar-policy.mjs';
import { buildProductComparison } from './product-comparison.mjs';
import { seenDiscoveryTopics,pendingDiscoveryJobs } from './discovery-status.mjs';
import { collectionPreset,validateRequestLimit } from './collection-presets.mjs';

const TTL = 24 * 60 * 60 * 1000;
export function familiarCandidate(entry,topic,category,image,sourceLabel) {
  const candidate=normalizeRecord(entry.row,{operation:entry.operation,category,checkedAt:entry.checkedAt,image});
  return {...candidate,title:topic.name,prompt:`이 ${topic.name} ${candidate.quantity}의 등록 계약단가는 얼마일까요?`,
    interestReason:topic.hook,scope:`${candidate.scope} 출제 범위 검토: ${topic.scope}`,
    manufacturer:entry.row.prdctMakrNm || entry.row.prdctSpecNm.split(',')[1]?.trim(),
    discoveryTopicId:topic.id,discoveryScore:topic.priority===1?100:50,discoverySource:sourceLabel};
}
export function createFamiliarSourceOperations({ apiFactory, maxRequests=collectionPreset().maxRequests, searches } = {}) {
  validateRequestLimit(maxRequests);
  return {
    ...createSourceOperations({apiFactory}),
    async collect(root, progress=()=>{}, target=20, {maxRequests:requestLimit=maxRequests}={}) {
      if (!Number.isInteger(target) || target < 1 || target > 100) throw Error('후보 수를 확인해 주세요.');
      validateRequestLimit(requestLimit);
      const before = await loadCatalog(root), plan = await readJSON(path.join(root,'content/familiar-item-topics.json'));
      const day=kstDate(), cacheFile=path.join(root,'.artifacts/familiar-source-cache.json');
      let cache;try { cache=await readJSON(cacheFile); } catch (error) { if(error.code!=='ENOENT')throw error;cache={schemaVersion:1,queries:{},runs:[]}; }
      const exclusions=exclusionsFor(before.catalog,before.review);
      const known=new Set([...before.catalog.candidates.map(c=>c.productId),...Object.keys(exclusions)]);
      const occupied=seenDiscoveryTopics(plan,before.catalog);
      const imageUrls=new Set(before.catalog.candidates.map(c=>c.image.sourceUrl));
      const imageHashes=new Set(before.catalog.candidates.map(c=>c.image.sha256));
      let api, requests=0, scanned=0, cacheHits=0, imageRequests=0, imageFailures=0, duplicateFamilies=0, duplicateImages=0, warning=null,receivedRows=0;
      const filtered={knownProducts:0,invalidRecords:0,unmatchedRows:0,ambiguousRows:0,comparisonUnavailable:0};
      const getApi=async()=>api ||= apiFactory ? await apiFactory(root) : createProcurementApi({serviceKey:await loadServiceKey(root),maxAttempts:1});
      const added=[], queryLog=[];
      const saveCache=()=>writeJSON(cacheFile,cache);
      const fresh=entry=>{const age=Date.now()-Date.parse(entry?.checkedAt);return entry && Number.isFinite(age) && age>=-60000 && age<=TTL && kstDate(entry.checkedAt)===day;};
      const groupName=topic=>plan.groups.find(group=>group.id===topic.group)?.name || topic.group;
      const persist=async()=>{
        if(!added.length)return [];
        // Re-read so a concurrent browser decision is preserved. Abort if another
        // collector has added a conflicting product while this one was running.
        const current=await loadCatalog(root);
        const currentKnown=new Set([...current.catalog.candidates.map(c=>c.productId),...Object.keys(exclusionsFor(current.catalog,current.review))]);
        const currentSeen=seenDiscoveryTopics(plan,current.catalog);
        const candidates=added.filter(c=>{
          if(currentKnown.has(c.productId)||currentSeen.has(c.discoveryTopicId))return false;
          currentKnown.add(c.productId);currentSeen.add(c.discoveryTopicId);return true;
        });
        if(!candidates.length)return [];
        await writeJSON(path.join(root,'.artifacts/source-backups',`familiar-${Date.now()}.json`),{catalog:current.catalog,review:current.review});
        const decisions={...current.review.decisions};for(const c of candidates)decisions[c.id]={status:'unreviewed',note:''};
        await writeJSON(path.join(root,'content/review.json'),{...current.review,decisions,revision:current.review.revision+1});
        await writeJSON(path.join(root,'content/candidates.json'),{...current.catalog,candidates:[...current.catalog.candidates,...candidates],lastCollectedAt:new Date().toISOString()});
        return candidates;
      };
      const comparisonPool=[];
      const considerBatch=async(entries,sourceLabel)=>{
        comparisonPool.push(...entries);
        const topics=new Set();
        for(const {row} of entries) {
          scanned++;
          if(known.has(row.prdctIdntNo)){filtered.knownProducts++;continue;}
          if(!isUsableRecord(row,day)){filtered.invalidRecords++;continue;}
          const matching=matchingFamiliarTopics(plan.topics,row);
          if(!matching.length){filtered.unmatchedRows++;continue;}
          if(matching.length!==1){filtered.ambiguousRows++;continue;}
          if(occupied.has(matching[0].id)){duplicateFamilies++;continue;}
          topics.add(matching[0]);
        }
        const ranked=[...topics].map(topic=>({topic,comparison:buildProductComparison(topic,comparisonPool,{excluded:exclusions})}));
        const priority=item=>(item.comparison?.insufficient?0:100)-(item.comparison?.wideSpread?50:0)+(item.topic.priority===1?10:0);
        ranked.sort((a,b)=>priority(b)-priority(a));
        for(const {topic,comparison} of ranked) {
          if(added.length>=target)break;
          // Read all saved rows before choosing, instead of accepting the API's
          // first model. Manufacturer model counts do not weight the median.
          if(!comparison){filtered.comparisonUnavailable++;continue;}
          const options=[...comparison.options].sort((a,b)=>Number(b.isRecommended)-Number(a.isRecommended));
          for(const option of options) {
            const {row,checkedAt,operation:sourceOperation}=option.entry;
            if(known.has(row.prdctIdntNo))continue;
            if(imageUrls.has(row.prdctImgUrl)){duplicateImages++;continue;}
            try {
              imageRequests++;const imageResult=await (await getApi()).image(row.prdctImgUrl);
              if(imageHashes.has(imageResult.sha256)){duplicateImages++;continue;}
              const filename=`P${row.prdctIdntNo}-${imageResult.sha256.slice(0,12)}${imageResult.extension}`;
              await mkdir(path.join(root,'content/images'),{recursive:true});
              await writeFile(path.join(root,'content/images',filename),imageResult.bytes);
              const image={src:`./assets/products/${filename}`,alt:`${topic.name} — ${row.prdctSpecNm}`,sourceUrl:row.prdctImgUrl,sourceLabel:'나라장터 등록 상품 이미지',kind:'catalog-image',retrievedAt:new Date().toISOString(),sha256:imageResult.sha256};
              const candidate=familiarCandidate({row,checkedAt,operation:sourceOperation},topic,groupName(topic),image,sourceLabel);
              candidate.comparisonBaseline=comparison.baselineEntry;
              known.add(candidate.productId);occupied.add(topic.id);imageUrls.add(row.prdctImgUrl);imageHashes.add(image.sha256);added.push(candidate);
              progress({message:`${topic.name}: 제조사 ${comparison.manufacturerCount}곳 비교 후 실제 상품을 골랐어요.`,added:added.length,target,requests,requestLimit,scanned,imageRequests,cacheHits});
              break;
            } catch { imageFailures++; }
          }
        }
      };
      // Reuse only fresh rows already downloaded; old research remains useful for
      // planning but never gains a new verification timestamp without a query.
      const cachedRows=[];
      try {const state=await readJSON(path.join(root,'.artifacts/source-state.json'));for(const [key,value] of Object.entries(state.sources || {}))for(const item of value.buffer || [])if(fresh(item))cachedRows.push({...item,operation:key.split(':')[0]});}
      catch(error){if(error.code!=='ENOENT')throw error;}
      for(const [key,entry] of Object.entries(cache.queries))if(fresh(entry))for(const row of entry.items || [])cachedRows.push({row,checkedAt:entry.checkedAt,operation:entry.operation,key});
      await considerBatch(cachedRows,'fresh-local-cache');

      // Every configured topic is represented. A cache hit eliminates just that
      // request; it must not stop discovery of other words or contract types.
      const pendingJobs=(countHits=false)=>{
        const pending=pendingDiscoveryJobs(plan,cache,occupied,{searches});
        if(countHits)cacheHits=pending.cacheHits;
        return pending.jobs;
      };
      // Deliver cached new kinds immediately instead of holding them behind
      // another full batch of empty API searches.
      const pending=pendingJobs(true),jobs=added.length?[]:pending;
      progress({message:`저장 응답을 확인했어요. 미탐색 검색 ${jobs.length}개에서 이어갑니다.`,added:added.length,target,requests,requestLimit,scanned,cacheHits,remainingSearches:jobs.length});
      for(const job of jobs) {
        if(added.length>=target)break;
        if(occupied.has(job.id))continue;
        if(requests>=requestLimit)break;
        const entry={topicId:job.id,operation:job.operation,parameters:{prdctClsfcNoNm:job.term,pageNo:job.page,numOfRows:100},requestedAt:new Date().toISOString(),status:'attempted'};
        cache.runs.push(entry);requests++;await saveCache();
        progress({message:`${plan.topics.find(t=>t.id===job.id)?.name || job.term}: 새 API 조회 ${requests} / ${requestLimit}회 (${job.page}페이지)`,added:added.length,target,requests,requestLimit,scanned,cacheHits});
        try {
          const data=await (await getApi()).query(job.operation,entry.parameters);
          receivedRows+=data.items.length;
          cache.queries[job.key]={...data,operation:job.operation,topicId:job.id,parameters:entry.parameters};
          Object.assign(entry,{status:'complete',returned:data.items.length,totalCount:data.totalCount});
          queryLog.push({term:job.term,operation:job.operation,page:job.page,returned:data.items.length,totalCount:data.totalCount});
          await saveCache();
          // All returned rows are cached. Models of an occupied kind cost no
          // image request and never crowd out another everyday-object topic.
          await considerBatch(data.items.map(row=>({row,checkedAt:data.checkedAt,operation:job.operation})),'targeted-api');
        } catch(error) {entry.status='failed';entry.message=error.message;warning=error.message;await saveCache();break;}
      }
      const saved=await persist();
      const remainingSearches=pendingJobs().length;
      const stopReason=warning?'request_failed':saved.length>=target?'target_reached':saved.length&&requests===0?'cached_candidates_added':requests>=requestLimit&&remainingSearches?'request_limit':!remainingSearches?'searches_exhausted':'no_suitable_candidates';
      const result={added:saved.length,newKinds:saved.length,existingKindModels:0,target,requests,requestLimit,receivedRows,remainingSearches,stopReason,filtered,scanned,cacheHits,imageRequests,imageFailures,duplicateFamilies,duplicateImages,warning,ids:saved.map(c=>c.id),items:saved.map(c=>({id:c.id,title:c.title,topicId:c.discoveryTopicId,price:c.answer})),queries:queryLog};
      await writeJSON(path.join(root,'.artifacts/familiar-last-collection.json'),result);
      progress({message:`처음 보는 물건 ${saved.length}종 수집 완료 · API ${requests}회`,...result});
      if(!saved.length && warning)throw Error(warning);
      return result;
    }
  };
}
