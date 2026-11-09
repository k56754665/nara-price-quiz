import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,copyFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {projectRoot,readJSON,writeJSON} from '../scripts/curation.mjs';
import {createLocalServer} from '../scripts/local-server.mjs';
import {candidateEntry,buildProductComparison} from '../scripts/product-comparison.mjs';
import {matchesFamiliarTopic,matchingFamiliarTopics} from '../scripts/familiar-policy.mjs';
import {candidateQuality} from '../scripts/candidate-quality.mjs';
import {pendingDiscoveryJobs,seenDiscoveryTopics,reintroducedCandidates} from '../scripts/discovery-status.mjs';

const catalog=await readJSON(path.join(projectRoot,'content/candidates.json'));
const plan=await readJSON(path.join(projectRoot,'content/familiar-item-topics.json'));
const checkedAt=new Date().toISOString();

test('제외 이력은 규칙이 바뀌어도 유지하며 같은 공식 품명의 다른 용도는 새 종류로 구분',()=>{
  const plan={topics:[{id:'A',families:['로봇'],requiredAny:['안내용']},{id:'B',families:['로봇'],requiredAny:['청소용']}]};
  const excluded={id:'old',discoveryTopicId:'A',specification:'로봇, 회사A, 모델1, 예전용도'};
  const automatic={id:'auto',discoveryTopicId:'A',specification:'로봇, 회사B, 모델2, 안내용',discoverySource:'fresh-local-cache'};
  const manual={...automatic,id:'manual',discoverySource:'human-comparison-choice'};
  const catalog={candidates:[excluded,automatic,manual]},review={decisions:{old:{status:'excluded'},auto:{status:'unreviewed'},manual:{status:'unreviewed'}}};
  const seen=seenDiscoveryTopics(plan,catalog,review);
  assert.deepEqual([...seen],['A']);assert.equal(seen.has('B'),false);
  assert.deepEqual(reintroducedCandidates(plan,catalog,review),[{id:'auto',previousId:'old',topicId:'A'}]);
});

test('최근 빈 응답이 반복된 계약 유형보다 아직 안 찾은 다른 물품명을 먼저 탐색',()=>{
  const mas='getMASCntrctPrdctInfoList',third='getThptyUcntrctPrdctInfoList';
  const plan={topics:[{id:'T',families:['공식물품명'],keywords:['일상표현','공식물품명']}]};
  const cache={queries:{[mas+':일상표현']:{checkedAt,totalCount:0,items:[]}},runs:Array.from({length:30},()=>({operation:third,status:'complete',returned:0}))};
  const jobs=pendingDiscoveryJobs(plan,cache,new Set()).jobs;
  assert.equal(jobs[0].operation,mas);assert.equal(jobs[0].term,'공식물품명');
  assert.ok(jobs.some(j=>j.operation===third),'느린 계약 유형도 영구 차단하지 않음');
});

test('유도등의 80W 고가 군집을 일반 피난구용 후보와 분리하고 원본 가격은 보존',async()=>{
  const current=catalog.candidates.find(c=>c.productId==='26346195');
  const topic=plan.topics.find(t=>t.id==='F226');
  // Fixture is self-contained: local research caches and network are not used.
  const source=candidateEntry(current);
  const rows=[['88000001','업체A',54000,'피난구용, 2W'],['88000002','업체B',58000,'피난구용, 4W'],['88000003','업체C',75000,'피난구용, 3.14W'],['88000004','특수업체',2200000,'피난구용, 80W'],['88000005','통로업체',35000,'계단통로용, 2W']].map(([id,maker,price,spec])=>({checkedAt,operation:source.operation,row:{...source.row,prdctIdntNo:id,prdctMakrNm:maker,prdctSpecNm:`유도등, ${maker}, MODEL, ${spec}`,cntrctPrceAmt:String(price)}}));
  assert.equal(matchesFamiliarTopic(topic,current),false);
  const comparison=buildProductComparison(topic,rows,{anchor:current,baselineEntry:current.comparisonBaseline});
  assert.equal(comparison.scopeMismatch,true);assert.equal(comparison.manufacturerCount,3);
  assert.equal(comparison.medianPrice,58000);
  assert.ok(comparison.options.every(o=>o.price<100000));
  assert.equal(current.answer,2110000);
  assert.equal(candidateQuality(current,comparison).ready,false);
  assert.equal(candidateQuality(current,comparison).requiresNote,true);
  assert.ok(candidateQuality(current,comparison).reasons.some(r=>r.includes('출제 범위')));
});

test('색인 매칭은 모든 후보에 대해 전체 검색과 같은 종류 판정을 반환',()=>{
  for(const c of catalog.candidates)assert.deepEqual(matchingFamiliarTopics(plan.topics,c).map(t=>t.id).sort(),plan.topics.filter(t=>matchesFamiliarTopic(t,c)).map(t=>t.id).sort());
});

test('서로 비싼 두 모델뿐인 세부 군집도 전체 종류와 가격 차이를 표시',()=>{
  const topic={id:'T',name:'테스트',families:['기구']};
  const base=candidateEntry(catalog.candidates[0]);
  const entries=[['88000001','A',50000,'보통'],['88000002','B',60000,'보통'],['88000003','C',55000,'보통'],['88000004','D',2000000,'특수'],['88000005','E',2100000,'특수']].map(([id,maker,price,feature])=>({checkedAt,operation:base.operation,row:{...base.row,prdctIdntNo:id,prdctMakrNm:maker,prdctSpecNm:`기구, ${maker}, MODEL, ${feature}`,cntrctPrceAmt:String(price)}}));
  const anchor={...catalog.candidates[0],productId:'88000004',title:'기구',specification:entries[3].row.prdctSpecNm,answer:2000000};
  const comparison=buildProductComparison(topic,entries,{anchor});
  assert.equal(comparison.manufacturerCount,2);assert.equal(comparison.insufficient,true);
  assert.equal(comparison.topicMedianPrice,60000);assert.equal(comparison.topicPriceConcern,true);
  assert.equal(candidateQuality(anchor,comparison).requiresNote,true);
});

test('일괄 승인·제외는 전체 검증 후 저장하고 충돌·실패 때 부분 승인하지 않음',async t=>{
  const parent=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(parent,'nara-review-flow-'));
  t.after(()=>{if(path.dirname(path.resolve(root))!==parent||!path.basename(root).startsWith('nara-review-flow-'))throw Error('Unsafe fixture');return rm(root,{recursive:true,force:true});});
  await mkdir(path.join(root,'content'),{recursive:true});await mkdir(path.join(root,'dist'),{recursive:true});
  const candidates=catalog.candidates.slice(0,4).map(c=>({...c,checkedAt,discoveryTopicId:undefined}));
  await writeJSON(path.join(root,'content/candidates.json'),{...catalog,candidates});
  const initialReview={revision:7,decisions:Object.fromEntries(candidates.map(c=>[c.id,{status:'unreviewed',note:`메모 ${c.id}`}]))};
  await writeJSON(path.join(root,'content/review.json'),initialReview);
  await copyFile(path.join(projectRoot,'content/familiar-item-topics.json'),path.join(root,'content/familiar-item-topics.json'));
  await copyFile(path.join(projectRoot,'dist/data.json'),path.join(root,'dist/data.json'));
  const game=await readFile(path.join(root,'dist/data.json'),'utf8');
  const server=createLocalServer({root,admin:true,sourceOperations:{}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}`,model=await (await fetch(url+'/api/catalog')).json();
  const post=body=>fetch(url+'/api/review-batch',{method:'POST',headers:{'Content-Type':'application/json','X-Curation-Token':model.csrf},body:JSON.stringify(body)});
  const bad=await post({ids:[candidates[0].id,'unknown'],status:'approved',revision:7});assert.equal(bad.status,400);
  assert.deepEqual(await readJSON(path.join(root,'content/review.json')),initialReview);
  const ids=candidates.slice(0,2).map(c=>c.id);
  const response=await post({ids,status:'approved',revision:7});assert.equal(response.status,200);
  const approved=await response.json();
  for(const id of ids){assert.equal(approved.decisions[id].status,'approved');assert.equal(approved.decisions[id].note,`메모 ${id}`);}
  assert.equal((await post({ids:[candidates[2].id],status:'excluded',revision:7})).status,400);
  const excluded=await post({ids:[candidates[2].id,candidates[3].id],status:'excluded',revision:approved.revision});assert.equal(excluded.status,200);
  const review=await excluded.json();assert.ok(review.excludedProducts[candidates[2].productId]);
  assert.equal(review.decisions[candidates[0].id].status,'approved');
  assert.equal(await readFile(path.join(root,'dist/data.json'),'utf8'),game);
});
