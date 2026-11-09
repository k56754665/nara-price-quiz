import path from 'node:path';
import { readJSON } from './curation.mjs';
import { kstDate } from './procurement-api.mjs';
import { isUsableRecord, exclusionsFor } from './source-operations.mjs';
import { matchesFamiliarTopic,matchingFamiliarTopics } from './familiar-policy.mjs';

const compact=value=>String(value || '').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
export const median=values=>{const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;return n ? n%2 ? sorted[(n-1)/2] : (sorted[n/2-1]+sorted[n/2])/2 : null;};
export const isFreshEntry=(entry,now=Date.now())=>Number.isFinite(Date.parse(entry.checkedAt))
  && now-Date.parse(entry.checkedAt)>=-60000 && now-Date.parse(entry.checkedAt)<=86400000 && kstDate(entry.checkedAt)===kstDate(now);
export function makerKey(value) {
  return compact(value).replace(/주식회사|유한회사|합자회사|\(주\)|\(유\)|\(합\)|㈜|유한책임회사/g,'');
}
export function candidateEntry(c) {
  return {checkedAt:c.checkedAt,operation:c.endpoint,row:{prdctIdntNo:c.productId,prdctSpecNm:c.specification,
    prdctClsfcNoNm:c.classification?.name || c.specification.split(',')[0],prdctUnit:c.unit,
    prdctDlvryCndtnNm:c.delivery,vatAplDivNm:c.vat,cntrctPrceAmt:String(c.answer),
    cntrctCorpNm:c.supplier,prdctMakrNm:c.manufacturer || c.specification.split(',')[1]?.trim(),
    shopngCntrctNo:c.contractNumber,shopngCntrctSno:c.contractLine,cntrctBgnDate:c.contractStart,
    cntrctEndDate:c.contractEnd,prdctImgUrl:c.image.sourceUrl}};
}
function dimensions(text) {
  const match=String(text).normalize('NFKC').match(/(\d+(?:\.\d+)?)\s*[×x*]\s*(\d+(?:\.\d+)?)\s*[×x*]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)(?![a-z])/i);
  if(!match)return null;
  const scale={mm:1,cm:10,m:1000}[match[4].toLowerCase()];
  return match.slice(1,4).map(Number).map(n=>n*scale);
}
export function comparisonProfile(topic,row) {
  const spec=row.prdctSpecNm || '',text=compact(spec),parts=spec.split(',');
  const maker=row.prdctMakrNm || parts[1]?.trim();
  if(!maker || !row.prdctUnit || !row.vatAplDivNm || !row.prdctDlvryCndtnNm)return null;
  const unit=compact(row.prdctUnit),whole=['F028','F029','F043','F058'].includes(topic.id)&&['개','대','기'].includes(unit);
  const size=dimensions(spec),capacity=text.match(/(\d+)인용/)?.[1] || '';
  let feature='',label='';
  if(topic.id==='F028') {
    if(!capacity || !size)return null;
    feature=`${capacity}인용|${/회전/.test(text)?'회전':'회전표기없음'}|${/스프링/.test(text)?'스프링':'스프링표기없음'}`;
    label=`${capacity}인용 시소 · 기준 상품 치수 ±35%`;
  } else if(topic.id==='F029') {
    if(!size)return null;
    feature=`${capacity || '정원미기재'}|${/전동|전기구동/.test(text)?'전동':'전동표기없음'}`;
    label='흔들놀이기구 · 기준 상품 치수 ±35% · 정원 표기 일치';
  } else if(topic.id==='F043') {
    const mounting=['천장조하식','천장','벽부착식','고정식','이동식'].find(word=>text.includes(word));
    if(!mounting)return null;
    feature=`${mounting}|${/2면|양면/.test(text)?'양면':'양면표기없음'}`;
    label=`농구대 ${mounting} · 양면 표기 구분 (보드 크기·재질은 별도 검토)`;
  } else if(topic.id==='F058') {
    if(!/자동차단기|차량번호인식/.test(text))return null;
    feature=['차량번호인식','전광판일체형','양방향','단방향','led'].filter(word=>text.includes(word)).join('|') || '자동차단기';
    label=feature==='자동차단기'?'자동차단기 · 번호인식·전광판·LED 추가 기능 표기 없음':`차량차단기 · ${feature}`;
  } else if(topic.id==='F062') {
    const description=compact(parts.slice(3).join(','));
    const weight=description.match(/(\d+(?:\.\d+)?)kg/)?.[1],rating=/(?:^|[^a-z])abc(?=$|[^a-z])/.test(description)?'abc':'';
    if(!weight)return null;
    feature=`${Number(weight)}kg|${rating || '등급미기재'}`;label=`수동식 소화기 · 약제중량 ${Number(weight)}kg · ${rating?.toUpperCase() || '등급미기재'}`;
  } else if(topic.id==='F226') {
    feature='피난구용표시등';label='피난구용 · 이번 출제 범위 10W 이하 (크기·배터리는 별도 확인)';
  } else {
    const description=compact(parts.slice(3).join(',')).replace(/\d+(?:\.\d+)?[×x*]\d+(?:\.\d+)?[×x*]\d+(?:\.\d+)?(?:mm|cm|m)/g,'').replace(/[,/]/g,'');
    if(!description && !size)return null;
    feature=description;label=description?`세부 용도·기능 표기 일치: ${parts.slice(3).join(', ')}`:'기준 상품 치수 ±35%';
  }
  return {key:[whole?'완제품1개':unit,compact(row.prdctDlvryCndtnNm),compact(row.vatAplDivNm),feature].join('::'),maker,makerKey:makerKey(maker),size,label,unitLabel:whole?'완제품 1개/대/기 (묶음·세트 제외)':row.prdctUnit};
}
function compatible(a,b,topic) {
  if(!a || !b || a.key!==b.key)return false;
  if(a.size && b.size)return a.size.every((dimension,i)=>b.size[i]>=dimension*.65 && b.size[i]<=dimension*1.35);
  // Physical dimensions are mandatory for the playground comparisons.
  return !['F028','F029'].includes(topic.id);
}
function latestProducts(entries) {
  const byId=new Map();
  for(const entry of entries) {
    const id=entry.row.prdctIdntNo,old=byId.get(id);
    if(!old || Date.parse(entry.checkedAt)>Date.parse(old.checkedAt))byId.set(id,entry);
  }
  return [...byId.values()];
}
const nearest=(entries,price)=>[...entries].sort((a,b)=>Math.abs(Number(a.row.cntrctPrceAmt)-price)-Math.abs(Number(b.row.cntrctPrceAmt)-price)||a.row.prdctIdntNo.localeCompare(b.row.prdctIdntNo))[0];

export function buildProductComparison(topic,entries,{anchor,baselineEntry,excluded={},now=Date.now()}={}) {
  const pool=latestProducts(entries).filter(entry=>!excluded[entry.row.prdctIdntNo] && matchesFamiliarTopic(topic,entry.row) && isUsableRecord(entry.row,kstDate(now)))
    .map(entry=>({...entry,profile:comparisonProfile(topic,entry.row)})).filter(entry=>entry.profile);
  const scopeMismatch=Boolean(anchor && !matchesFamiliarTopic(topic,anchor));
  const reference=[baselineEntry,anchor && candidateEntry(anchor)].find(entry=>entry && matchesFamiliarTopic(topic,entry.row));
  let baseline=reference && {...reference,profile:comparisonProfile(topic,reference.row)};
  if(!baseline?.profile) {
    // Choose a common, describable specification group, independent of price.
    baseline=pool.map(item=>({item,count:new Set(pool.filter(e=>compatible(item.profile,e.profile,topic)).map(e=>e.profile.makerKey)).size}))
      .sort((a,b)=>b.count-a.count||a.item.row.prdctIdntNo.localeCompare(b.item.row.prdctIdntNo))[0]?.item;
  }
  if(!baseline)return null;
  const comparable=pool.filter(entry=>compatible(baseline.profile,entry.profile,topic));
  const byMaker=new Map();for(const entry of comparable){const key=entry.profile.makerKey;const rows=byMaker.get(key)||[];rows.push(entry);byMaker.set(key,rows);}
  // Each manufacturer contributes one real model, regardless of how many
  // near-identical models it has registered in the saved response.
  const representatives=[...byMaker.values()].map(rows=>rows.find(e=>e.row.prdctIdntNo===anchor?.productId)
    || nearest(rows,median(rows.map(e=>Number(e.row.cntrctPrceAmt))))).sort((a,b)=>Number(a.row.cntrctPrceAmt)-Number(b.row.cntrctPrceAmt));
  if(!representatives.length)return null;
  const enough=representatives.length>=3;
  // A narrow feature group can consist entirely of expensive special models.
  // Keep a separate, explicitly broader signal so two such models cannot
  // validate each other's price just because their feature strings match.
  const broadMakers=new Map();
  for(const entry of pool)if(entry.profile.key.split('::').slice(0,3).join('::')===baseline.profile.key.split('::').slice(0,3).join('::')) {
    const prices=broadMakers.get(entry.profile.makerKey)||[];prices.push(Number(entry.row.cntrctPrceAmt));broadMakers.set(entry.profile.makerKey,prices);
  }
  const topicMedianPrice=broadMakers.size>=3?median([...broadMakers.values()].map(median)):null;
  const topicPriceConcern=Boolean(!scopeMismatch && topicMedianPrice && anchor && (anchor.answer>topicMedianPrice*4 || anchor.answer<topicMedianPrice/4));
  const medianPrice=enough?median(representatives.map(e=>Number(e.row.cntrctPrceAmt))):null;
  const recommended=enough?nearest(representatives,medianPrice):null;
  const options=[];
  const add=entry=>{if(entry && options.length<5 && !options.some(e=>e.profile.makerKey===entry.profile.makerKey))options.push(entry);};
  add(representatives.find(e=>e.row.prdctIdntNo===anchor?.productId));add(recommended);
  add(representatives[0]);add(representatives.at(-1));
  for(const fraction of [.5,.25,.75])add(representatives[Math.round((representatives.length-1)*fraction)]);
  for(const entry of representatives)add(entry);
  options.sort((a,b)=>Number(a.row.cntrctPrceAmt)-Number(b.row.cntrctPrceAmt));
  return {topicId:topic.id,topicName:topic.name,currentProductId:anchor?.productId || null,
    comparableCount:comparable.length,manufacturerCount:representatives.length,medianPrice,
    recommendedProductId:recommended?.row.prdctIdntNo || null,insufficient:!enough,scopeMismatch,
    outlier:!scopeMismatch && enough && anchor?.answer>=medianPrice*1.75,
    lowOutlier:!scopeMismatch && enough && anchor?.answer<medianPrice/1.75,
    priceRange:[Number(representatives[0].row.cntrctPrceAmt),Number(representatives.at(-1).row.cntrctPrceAmt)],
    wideSpread:enough && Number(representatives.at(-1).row.cntrctPrceAmt)>Number(representatives[0].row.cntrctPrceAmt)*3,
    topicPriceConcern,topicMedianPrice,topicManufacturerCount:broadMakers.size,
    conditions:[baseline.profile.label,baseline.profile.unitLabel,baseline.row.prdctDlvryCndtnNm,baseline.row.vatAplDivNm],
    caveat:'저장된 응답 일부를 같은 용도·인도조건·유사 규격으로 비교했습니다. 전체 시장의 중앙값이 아니며, 중앙값은 추천에만 사용하고 정답은 선택한 상품의 실제 계약단가입니다.',
    baselineEntry:{row:baseline.row,checkedAt:baseline.checkedAt,operation:baseline.operation},
    options:options.map(entry=>({productId:entry.row.prdctIdntNo,manufacturer:entry.profile.maker,specification:entry.row.prdctSpecNm,
      price:Number(entry.row.cntrctPrceAmt),unit:entry.row.prdctUnit,delivery:entry.row.prdctDlvryCndtnNm,vat:entry.row.vatAplDivNm,
      checkedAt:entry.checkedAt,imageUrl:entry.row.prdctImgUrl,isFresh:isFreshEntry(entry,now),
      isCurrent:entry.row.prdctIdntNo===anchor?.productId,isRecommended:entry.row.prdctIdntNo===recommended?.row.prdctIdntNo,entry}))};
}
export const publicComparison=comparison=>{if(!comparison)return null;const {baselineEntry,...summary}=comparison;return {...summary,options:comparison.options.map(({entry,...option})=>option)};};
export async function readComparisonEntries(root,catalog) {
  const entries=[];
  for(const file of ['.artifacts/source-state.json','.artifacts/familiar-source-cache.json']) {
    let data;try { data=await readJSON(path.join(root,file)); } catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(file.endsWith('source-state.json'))for(const [key,source] of Object.entries(data.sources || {}))for(const item of source.buffer || [])entries.push({...item,operation:key.split(':')[0]});
    else for(const source of Object.values(data.queries || {}))for(const row of source.items || [])entries.push({row,checkedAt:source.checkedAt,operation:source.operation});
  }
  return [...entries,...catalog.candidates.map(candidateEntry)];
}
export async function comparisonContext(root,catalog,review) {
  const [plan,entries]=await Promise.all([readJSON(path.join(root,'content/familiar-item-topics.json')),readComparisonEntries(root,catalog)]);
  const excluded=exclusionsFor(catalog,review);
  const byTopic=new Map();
  for(const entry of entries)for(const topic of matchingFamiliarTopics(plan.topics,entry.row)) {
    const group=byTopic.get(topic.id)||[];group.push(entry);byTopic.set(topic.id,group);
  }
  return {plan,entries,forCandidate(candidate){const topic=plan.topics.find(t=>t.id===candidate.discoveryTopicId);return topic?buildProductComparison(topic,byTopic.get(topic.id)||[],{anchor:candidate,baselineEntry:candidate.comparisonBaseline,excluded}):null;}};
}
