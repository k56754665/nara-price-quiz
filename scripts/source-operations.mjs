import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { API_BASE, createProcurementApi, loadServiceKey, kstDate, safeImageUrl, sha256 } from './procurement-api.mjs';
import { loadCatalog, readJSON, writeJSON, publishBank } from './curation.mjs';
import { NOVELTY_SOURCES, familyOf, familiesFor, interestScore } from './discovery-policy.mjs';

export const DISCOVERY_SOURCES = NOVELTY_SOURCES;
const compact = value => String(value ?? '').replace(/\s/g,'');
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '');

export function exclusionsFor(catalog, review) {
  const result = { ...(review.excludedProducts || {}) };
  for(const c of catalog.candidates) if(review.decisions[c.id]?.status==='excluded') result[c.productId] ||= { note:review.decisions[c.id].note || '',excludedAt:null };
  return result;
}

export function isUsableRecord(row, date = kstDate()) {
  return /^\d{8}$/.test(row.prdctIdntNo || '') && row.shopngCntrctNo && row.shopngCntrctSno
    && Number.isSafeInteger(Number(row.cntrctPrceAmt)) && Number(row.cntrctPrceAmt)>0 && Number(row.cntrctPrceAmt)<=999999999999
    && row.prdctUnit && row.prdctDlvryCndtnNm && row.prdctSpecNm && row.vatAplDivNm && safeImageUrl(row.prdctImgUrl)
    && validDate(row.cntrctBgnDate) && validDate(row.cntrctEndDate) && row.cntrctBgnDate<=date && row.cntrctEndDate>=date;
}

export function sameContract(row, candidate) {
  return row.prdctIdntNo===candidate.productId && row.shopngCntrctNo===candidate.contractNumber
    && row.shopngCntrctSno===candidate.contractLine && compact(row.prdctUnit)===compact(candidate.unit)
    && compact(row.prdctDlvryCndtnNm)===compact(candidate.delivery);
}

export function normalizeRecord(row,{operation,category,checkedAt,old,image}) {
  if(!isUsableRecord(row,kstDate(checkedAt))) throw Error('가격·계약기간·단위·이미지를 확인하지 못했습니다.');
  const id = old?.id || `P${row.prdctIdntNo}`;
  const parts = row.prdctSpecNm.split(',').map(s=>s.trim());
  const title = old?.title || familyOf(row).label.slice(0,100);
  const quantity = `1${row.prdctUnit}`;
  const genericNote = `${row.prdctSpecNm}. ${quantity}, ${row.prdctDlvryCndtnNm} 기준 등록 계약단가입니다.`;
  const changedScope = old && (old.specification!==row.prdctSpecNm || old.delivery!==row.prdctDlvryCndtnNm || old.unit!==row.prdctUnit);
  const changedPrice = old && old.answer!==Number(row.cntrctPrceAmt);
  const q = {
    id,title,category:old?.category || category,prompt:`이 ${title} ${quantity}의 등록 계약단가는 얼마일까요?`,
    specification:row.prdctSpecNm,quantity,unit:row.prdctUnit,delivery:row.prdctDlvryCndtnNm,vat:row.vatAplDivNm,
    answer:Number(row.cntrctPrceAmt),scope:changedScope?genericNote:old?.scope || genericNote,
    supplier:row.cntrctCorpNm || row.prdctMakrNm || '',productId:row.prdctIdntNo,
    contractNumber:row.shopngCntrctNo,contractLine:row.shopngCntrctSno,contractStart:row.cntrctBgnDate,contractEnd:row.cntrctEndDate,
    endpoint:operation,sourceUrl:new URL(operation,API_BASE).href,queryWithoutSecret:{type:'json',pageNo:'1',numOfRows:'100',prdctIdntNo:row.prdctIdntNo},
    checkedAt,triviaId:changedScope||changedPrice?null:old?.triviaId || null,
    revealNote:changedScope?genericNote:old?.revealNote || genericNote,image,
    eligible:true,eligibilityReason:'공식 API에서 계약단가와 현재 유효한 계약 행 확인',
    interestReason:old?.interestReason || `${row.prdctClsfcNoNm || parts[0]}의 규격과 실제 등록 계약단가를 보고 출제 여부를 골라 주세요.`,
    sourceChangedAt:row.chgDt || row.rgstDt || null,
    evidence:{recordSha256:sha256(JSON.stringify(row)),checkedAt},
    classification:{name:row.prdctClsfcNoNm || parts[0],code:row.prdctClsfcNo || null,detailedCode:row.dtilPrdctClsfcNo || null},
    discoveryFamily:familyOf(row),discoveryScore:interestScore(row),
    freshness:{status:'verified',lastAttemptAt:checkedAt,lastVerifiedAt:checkedAt,message:'현재 계약 행 확인 완료'},
  };
  // Refreshing a chosen representative must retain its topic identity so that
  // comparison and the one-approved-representative rule survive price updates.
  if(old?.discoveryTopicId) {
    q.discoveryTopicId=old.discoveryTopicId;
    q.discoverySource=old.discoverySource;
    q.manufacturer=row.prdctMakrNm || old.manufacturer || parts[1];
    if(old.comparisonBaseline && !changedScope)q.comparisonBaseline=old.comparisonBaseline;
    if(old.selectionSupersededBy)q.selectionSupersededBy=old.selectionSupersededBy;
  }
  if(row.dscntAmt) q.pricePolicy={basis:'registered_contract_unit_price',contractPriceVerified:true,discountObserved:true,discountStart:row.dscntBgnDate || null,discountEnd:row.dscntEndDate || null,notice:'정답은 조회일의 등록 계약단가입니다. 함께 조회된 할인 정보는 정답 계산에 반영하지 않아요.'};
  const labels={answer:'등록 계약단가',specification:'규격',delivery:'인도조건',vat:'부가세',contractEnd:'계약 종료일',supplier:'공급업체'};
  const changes = old ? Object.entries(labels).filter(([key])=>old[key]!==q[key]).map(([field,label])=>({field,label,before:old[field],after:q[field]})) : [];
  if(old && old.image.sha256!==image.sha256) changes.push({field:'image',label:'상품 이미지',before:'이전 이미지',after:'갱신된 이미지'});
  q.lastChanges=changes.length?changes:old?.lastChanges || [];
  return q;
}

async function cacheImage(root,api,row,old,rejectHashes) {
  const result = await api.image(row.prdctImgUrl);
  if(rejectHashes?.has(result.sha256))return null;
  const id = old?.id || `P${row.prdctIdntNo}`;
  const filename = old?.image.sha256===result.sha256 ? path.basename(old.image.src) : `${id}-${result.sha256.slice(0,12)}${result.extension}`;
  await mkdir(path.join(root,'content/images'),{recursive:true});
  await writeFile(path.join(root,'content/images',filename),result.bytes);
  return {src:`./assets/products/${filename}`,alt:`${old?.title || row.prdctClsfcNoNm} — ${row.prdctSpecNm}`,sourceUrl:row.prdctImgUrl,sourceLabel:'나라장터 등록 상품 이미지',kind:old?.image.sourceUrl===row.prdctImgUrl?old.image.kind:'catalog-image',retrievedAt:new Date().toISOString(),sha256:result.sha256};
}

async function backup(root,catalog,review) {
  await writeJSON(path.join(root,'.artifacts/source-backups',`${Date.now()}.json`),{catalog,review});
}

export function createSourceOperations({ apiFactory, discoverySources=DISCOVERY_SOURCES, maxRequests=100 } = {}) {
  const getApi = async root => apiFactory ? apiFactory(root) : createProcurementApi({serviceKey:await loadServiceKey(root)});
  return {
    async collect(root,progress=()=>{},target=100) {
      if(!Number.isInteger(target)||target<1||target>100)throw Error('한 번에 가져올 새 후보 수는 1~100개입니다.');
      const api = await getApi(root);
      let {catalog,review} = await loadCatalog(root);
      await backup(root,catalog,review);
      const exclusions=exclusionsFor(catalog,review);
      const seenFamilies=familiesFor(catalog,review);
      const seenImageUrls=new Set(catalog.candidates.map(c=>c.image.sourceUrl));
      const seenImageHashes=new Set(catalog.candidates.map(c=>c.image.sha256));
      review={...review,excludedProducts:exclusions};
      let state; try { state=await readJSON(path.join(root,'.artifacts/source-state.json')); } catch(error) { if(error.code!=='ENOENT')throw error; state={nextSource:0,sources:{}}; }
      if(state.strategy!=='novel-families-v1'){state.strategy='novel-families-v1';state.nextSource=0;}
      const known = new Set([...catalog.candidates.map(c=>c.productId),...Object.keys(exclusions)]);
      const day=kstDate();
      const added=[];
      for(const c of state.pendingCandidates||[]) {
        const family=familyOf(c);
        if(added.length>=target||known.has(c.productId)||seenFamilies[family.key]||seenImageHashes.has(c.image.sha256)||interestScore(c)<0||kstDate(c.checkedAt)!==day)continue;
        added.push(c);known.add(c.productId);seenFamilies[family.key]={label:family.label,exampleProductId:c.productId};seenImageHashes.add(c.image.sha256);seenImageUrls.add(c.image.sourceUrl);
      }
      let requests=0,scanned=0,imageFailures=0,duplicateFamilies=0,duplicateImages=0,warning=null,emptyVisits=0;
      for(let visit=0;visit<discoverySources.length*5 && added.length<target;visit++) {
        const source=discoverySources[state.nextSource++ % discoverySources.length];
        let cursor=state.sources[source.key];
        if(!cursor || cursor.day!==day) cursor=state.sources[source.key]={day,page:1,buffer:[],exhausted:false};
        if(cursor.buffer.length && Date.now()-Date.parse(cursor.buffer[0].checkedAt)>600000) {cursor.page=cursor.bufferPage || Math.max(1,cursor.page-1);cursor.buffer=[];cursor.exhausted=false;}
        progress({message:`${source.term}에서 새로운 종류를 찾고 있어요.`,added:added.length,target,requests,scanned,duplicateFamilies,duplicateImages});
        try {
          if(!cursor.buffer.length && !cursor.exhausted) {
            if(requests>=maxRequests) { warning='한 번의 수집 한도에 도달했습니다. 다시 누르면 다음 위치부터 이어갑니다.'; break; }
            requests++;
            const data=await api.query(source.operation,{prdctClsfcNoNm:source.term,numOfRows:100,pageNo:cursor.page});
            cursor.bufferPage=cursor.page;cursor.exhausted=cursor.page*(data.pageSize||100)>=data.totalCount; cursor.page++;
            cursor.buffer=data.items.map(row=>({row,checkedAt:data.checkedAt}));
          }
          // Prefer unusual uses, then keep only one representative of each kind.
          cursor.buffer.sort((a,b)=>interestScore(b.row)-interestScore(a.row)||sha256(a.row.prdctIdntNo || '').localeCompare(sha256(b.row.prdctIdntNo || '')));
          let picked=0;
          while(cursor.buffer.length && picked<5 && added.length<target) {
            const {row,checkedAt}=cursor.buffer.shift(); scanned++;
            if(known.has(row.prdctIdntNo) || !isUsableRecord(row,day) || !compact(row.prdctClsfcNoNm).includes(compact(source.term)))continue;
            const family=familyOf(row);
            if(!family.label||seenFamilies[family.key]){duplicateFamilies++;continue;}
            if(interestScore(row)<0)continue;
            if(seenImageUrls.has(row.prdctImgUrl)){duplicateImages++;continue;}
            try {
              const image=await cacheImage(root,api,row,undefined,seenImageHashes);
              if(!image){duplicateImages++;continue;}
              const candidate=normalizeRecord(row,{operation:source.operation,category:source.category,checkedAt,image});
              seenFamilies[family.key]={label:family.label,exampleProductId:row.prdctIdntNo};seenImageUrls.add(row.prdctImgUrl);seenImageHashes.add(image.sha256);
              known.add(candidate.productId); added.push(candidate); picked++;
            } catch { imageFailures++; }
          }
          emptyVisits=picked?0:emptyVisits+1;
          if(emptyVisits>=discoverySources.length*2 && Object.values(state.sources).every(s=>s.exhausted&&!s.buffer.length))break;
        } catch(error) { warning=error.message; break; }
        state.pendingCandidates=added;
        await writeJSON(path.join(root,'.artifacts/source-state.json'),state);
      }
      if(!added.length && warning)throw Error(warning);
      for(const c of added) review.decisions[c.id]={status:'unreviewed',note:''};
      review.seenFamilies=seenFamilies;
      review.revision++;
      catalog={...catalog,candidates:[...catalog.candidates,...added],lastCollectedAt:new Date().toISOString()};
      await writeJSON(path.join(root,'content/review.json'),review);
      await writeJSON(path.join(root,'content/candidates.json'),catalog);
      state.pendingCandidates=[];
      await writeJSON(path.join(root,'.artifacts/source-state.json'),state);
      return {added:added.length,target,requests,scanned,imageFailures,duplicateFamilies,duplicateImages,warning,ids:added.map(c=>c.id)};
    },

    async refresh(root,progress=()=>{}) {
      const api = await getApi(root);
      let {catalog,review} = await loadCatalog(root);
      const selected=catalog.candidates.filter(c=>review.decisions[c.id]?.status==='approved');
      if(!selected.length)throw Error('먼저 갱신할 항목을 승인해 주세요.');
      await backup(root,catalog,review);
      const updates=new Map(), failures=[]; let completed=0,changed=0,next=0;
      const worker=async()=>{
        for(;;) {
          const index=next++; if(index>=selected.length)return;
          const c=selected[index];
          progress({message:`${c.title}의 현재 계약을 확인하고 있어요.`,completed,total:selected.length});
          try {
            let data=await api.query(c.endpoint,{prdctIdntNo:c.productId,numOfRows:100,pageNo:1});
            let row=data.items.find(row=>sameContract(row,c));
            for(let page=2;!row&&page<=Math.min(3,Math.ceil(data.totalCount/100));page++) {
              data=await api.query(c.endpoint,{prdctIdntNo:c.productId,numOfRows:100,pageNo:page});
              row=data.items.find(row=>sameContract(row,c));
            }
            if(!row)throw Error('선택한 계약번호·순번·단위·인도조건의 행을 확인하지 못했습니다.');
            if(!isUsableRecord(row,kstDate(data.checkedAt)))throw Error('현재 유효한 계약기간·가격·상품 이미지를 확인하지 못했습니다.');
            const image=await cacheImage(root,api,row,c);
            const updated=normalizeRecord(row,{operation:c.endpoint,category:c.category,checkedAt:data.checkedAt,old:c,image});
            if(['answer','specification','delivery','vat','contractEnd','supplier'].some(key=>c[key]!==updated[key]) || c.image.sha256!==updated.image.sha256)changed++;
            updates.set(c.id,updated);
          } catch(error) {
            failures.push({id:c.id,title:c.title,message:error.message});
            updates.set(c.id,{...c,freshness:{...c.freshness,status:'failed',lastAttemptAt:new Date().toISOString(),message:error.message}});
          }
          completed++; progress({message:`최신 정보 확인 ${completed} / ${selected.length}`,completed,total:selected.length,changed,failed:failures.length});
        }
      };
      await Promise.all(Array.from({length:Math.min(4,selected.length)},worker));
      catalog={...catalog,candidates:catalog.candidates.map(c=>updates.get(c.id)||c),lastRefreshedAt:new Date().toISOString()};
      if(!failures.length)catalog.base={...catalog.base,referenceDate:kstDate()};
      const excludedProducts=exclusionsFor(catalog,review);
      await writeJSON(path.join(root,'content/review.json'),{...review,excludedProducts,seenFamilies:familiesFor(catalog,review),revision:review.revision+1});
      await writeJSON(path.join(root,'content/candidates.json'),catalog);
      return {total:selected.length,verified:selected.length-failures.length,changed,failures,checkedAt:catalog.lastRefreshedAt};
    },

    async apply(root,progress=()=>{}) {
      const refresh=await this.refresh(root,progress);
      if(refresh.failures.length)throw Error(`${refresh.failures.length}개 항목의 최신 정보를 확인하지 못했습니다. 카드의 확인 필요 사유를 검토해 주세요. 기존 게임은 유지됩니다.`);
      progress({message:'검증한 문제와 랭킹 정답을 함께 생성하고 있어요.',completed:refresh.total,total:refresh.total});
      return {...await publishBank(root,{requireFresh:true}),verified:refresh.verified,changed:refresh.changed};
    },
  };
}
