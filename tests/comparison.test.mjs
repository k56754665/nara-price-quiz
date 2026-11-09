import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { projectRoot,readJSON,writeJSON,loadCatalog,updateDecision } from '../scripts/curation.mjs';
import { buildProductComparison, candidateEntry, comparisonContext, makerKey } from '../scripts/product-comparison.mjs';
import { chooseComparisonCandidate } from '../scripts/comparison-choice.mjs';
import { createFamiliarSourceOperations } from '../scripts/familiar-collection.mjs';
import { createLocalServer } from '../scripts/local-server.mjs';
import { sha256 } from '../scripts/procurement-api.mjs';
import { normalizeRecord } from '../scripts/source-operations.mjs';
const catalog=await readJSON(path.join(projectRoot,'content/candidates.json'));
const plan=await readJSON(path.join(projectRoot,'content/familiar-item-topics.json'));
const topic=plan.topics.find(t=>t.id==='F028');
const original=catalog.candidates.find(c=>c.id==='P26178725');
const checkedAt=new Date().toISOString();
function entry(id,maker,price,changes={}) {
  return {operation:'getMASCntrctPrdctInfoList',checkedAt,row:{prdctIdntNo:id,prdctClsfcNoNm:'시소',prdctSpecNm:`시소, ${maker}, MODEL, 2000×390×820mm, 2인용`,prdctMakrNm:maker,cntrctCorpNm:maker,
    cntrctPrceAmt:String(price),prdctUnit:'대',prdctDlvryCndtnNm:'현장설치도',vatAplDivNm:'부가가치세포함',
    shopngCntrctNo:'TEST',shopngCntrctSno:id,cntrctBgnDate:'2020-01-01',cntrctEndDate:'2035-12-31',prdctImgUrl:`https://shop.g2b.go.kr/static/${id}.jpg`,...changes}};
}
const imageBytes=await readFile(path.join(projectRoot,'content/images',path.basename(original.image.src)));
async function fixture(t,{outlier=false}={}) {
  const parent=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(parent,'nara-comparison-'));
  t.after(()=>{if(path.dirname(path.resolve(root))!==parent||!path.basename(root).startsWith('nara-comparison-'))throw Error('Unsafe fixture');return rm(root,{recursive:true,force:true});});
  await mkdir(path.join(root,'content/images'),{recursive:true});await mkdir(path.join(root,'dist'),{recursive:true});
  const current={...original,answer:outlier?8000000:original.answer,checkedAt};
  const preserved=catalog.candidates.find(c=>c.id==='C01'),held=catalog.candidates.find(c=>c.id==='C24');
  await writeJSON(path.join(root,'content/candidates.json'),{...catalog,candidates:[preserved,held,current]});
  await writeJSON(path.join(root,'content/review.json'),{schemaVersion:1,revision:5,decisions:{C01:{status:'approved',note:'승인 유지'},C24:{status:'held',note:'보류 유지'},[current.id]:{status:'unreviewed',note:''}},excludedProducts:{'88000009':{note:'제외 유지'}}});
  await copyFile(path.join(projectRoot,'content/familiar-item-topics.json'),path.join(root,'content/familiar-item-topics.json'));
  await copyFile(path.join(projectRoot,'dist/data.json'),path.join(root,'dist/data.json'));
  await copyFile(path.join(projectRoot,'content/images',path.basename(original.image.src)),path.join(root,'content/images',path.basename(original.image.src)));
  const entries=[candidateEntry(current),entry('88000001','회사B',1800000),entry('88000002','회사C',2000000),entry('88000003','회사D',2200000,{prdctSpecNm:'시소, 회사D, MODEL, 2490×440×850mm, 2인용'}),entry('88000004','회사E',2800000),entry('88000005','더긴규격회사',2100000,{prdctSpecNm:'시소, 더긴규격회사, MODEL, 3000×440×850mm, 2인용'}),entry('88000009','제외회사',1000000)];
  await writeJSON(path.join(root,'.artifacts/familiar-source-cache.json'),{queries:{test:{operation:'getMASCntrctPrdctInfoList',checkedAt,items:entries.map(e=>e.row)}},runs:[]});
  return root;
}
test('비교는 정원·치수·설치·부가세·묶음 단위를 분리하고 제조사 모델 수에 가중되지 않음',()=>{
  const rows=[...Array.from({length:30},(_,i)=>entry(String(87000000+i),i%2?'주식회사 회사A':'(주)회사A',700000)),entry('87000100','회사B',2000000),entry('87000200','회사C',3000000),
    entry('87000300','4인용',100000,{prdctSpecNm:'시소, 회사, M, 2000×390×820mm, 4인용'}),
    entry('87000301','대형',100000,{prdctSpecNm:'시소, 회사, M, 6000×2000×1800mm, 2인용'}),
    entry('87000302','하차도',100000,{prdctDlvryCndtnNm:'납품장소 하차도'}),
    entry('87000303','세금별도',100000,{vatAplDivNm:'부가가치세별도'}),
    entry('87000304','두대묶음',100000,{prdctUnit:'조'})];
  const result=buildProductComparison(topic,rows,{anchor:original});
  assert.equal(result.manufacturerCount,3);assert.equal(result.medianPrice,2000000);assert.equal(result.recommendedProductId,'87000100');
  assert.equal(new Set(result.options.map(o=>makerKey(o.manufacturer))).size,3);
  assert.ok(result.options.every(o=>o.price===Number(o.entry.row.cntrctPrceAmt)));
  assert.ok(result.options.every(o=>!o.productId.startsWith('870003')));
  const sparse=buildProductComparison(topic,rows,{anchor:original,excluded:{'87000100':{note:'제외'}}});
  assert.equal(sparse.manufacturerCount,2);assert.equal(sparse.medianPrice,null);assert.equal(sparse.recommendedProductId,null);
});

test('대표 교체는 API 조회 없이 미검토로 저장하고 기존 승인·보류·메모·게임을 보존',async t=>{
  const root=await fixture(t),before=await loadCatalog(root),gameBefore=await readFile(path.join(root,'dist/data.json'),'utf8');
  before.review.decisions[original.id].note='기존 검토 메모';await writeJSON(path.join(root,'content/review.json'),before.review);
  let pictures=0;
  const context=await comparisonContext(root,before.catalog,before.review),comparison=context.forCandidate(before.catalog.candidates.at(-1));
  assert.equal(comparison.options.length,5);
  await assert.rejects(chooseComparisonCandidate(root,{id:original.id,productId:'88000003',revision:4}),/바뀌었습니다/);
  await assert.rejects(chooseComparisonCandidate(root,{id:original.id,productId:'88000009',revision:5}),/비교 후보/);
  const result=await chooseComparisonCandidate(root,{id:original.id,productId:'88000003',revision:5},{imageReader:async()=>{pictures++;return {bytes:imageBytes,sha256:sha256(imageBytes),extension:'.png'};}});
  assert.equal(pictures,1);assert.equal(result.apiRequests,0);
  const after=await loadCatalog(root);
  assert.equal(after.review.decisions[original.id].status,'held');assert.equal(after.review.decisions[original.id].note,'기존 검토 메모');
  assert.equal(after.review.decisions[result.id].status,'unreviewed');assert.equal(after.catalog.candidates.find(c=>c.id===result.id).answer,2200000);
  const next=after.catalog.candidates.find(c=>c.id===result.id),nextComparison=(await comparisonContext(root,after.catalog,after.review)).forCandidate(next);
  assert.equal(nextComparison.manufacturerCount,comparison.manufacturerCount,'대표 교체 후에도 비교 치수의 기준을 유지');
  const refreshed=normalizeRecord(candidateEntry(next).row,{operation:next.endpoint,category:next.category,checkedAt,old:next,image:next.image});
  assert.equal(refreshed.discoveryTopicId,next.discoveryTopicId);assert.deepEqual(refreshed.comparisonBaseline,next.comparisonBaseline);
  for(const id of ['C01','C24'])assert.deepEqual(after.review.decisions[id],before.review.decisions[id]);
  assert.deepEqual(after.review.excludedProducts,before.review.excludedProducts);
  assert.equal(await readFile(path.join(root,'dist/data.json'),'utf8'),gameBefore);
  const approved=updateDecision(after.review,after.catalog,{id:result.id,status:'approved',note:'사진 확인',revision:after.review.revision});
  assert.throws(()=>updateDecision(approved,after.catalog,{id:original.id,status:'approved',note:'',revision:approved.revision}),/승인 대표/);
  assert.equal(updateDecision(after.review,after.catalog,{id:result.id,status:'unreviewed',note:'승인 전 메모',revision:after.review.revision}).decisions[result.id].note,'승인 전 메모');
});

test('새 수집은 첫 행 대신 제조사별 중앙값에 가까운 실제 모델을 선택',async t=>{
  const root=await fixture(t),state=await loadCatalog(root);
  state.catalog.candidates=state.catalog.candidates.filter(c=>c.id!=='P26178725');delete state.review.decisions.P26178725;
  await writeJSON(path.join(root,'content/candidates.json'),state.catalog);await writeJSON(path.join(root,'content/review.json'),state.review);
  await writeJSON(path.join(root,'.artifacts/familiar-source-cache.json'),{queries:{},runs:[]});
  let queries=0;
  const ops=createFamiliarSourceOperations({maxRequests:1,searches:[['F028','시소']],apiFactory:()=>({query:async()=>{queries++;const items=[entry('89000001','회사A',500000).row,entry('89000002','회사B',2000000).row,entry('89000003','회사C',3000000).row];return {items,totalCount:3,checkedAt};},image:async()=>({bytes:imageBytes,sha256:sha256(imageBytes),extension:'.png'})})});
  const result=await ops.collect(root);assert.equal(queries,1);assert.equal(result.added,1);assert.equal(result.items[0].id,'P89000002');assert.equal(result.items[0].price,2000000);
});

test('로컬 API는 비교 근거를 제공하고 비싼 후보에 승인 메모를 요구',async t=>{
  const root=await fixture(t,{outlier:true});
  const server=createLocalServer({root,admin:true,sourceOperations:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`;
  const model=await (await fetch(url+'/api/catalog')).json(),comparison=model.comparisons[original.id];
  assert.ok(comparison.outlier);assert.equal(comparison.options.length,5);assert.ok(!JSON.stringify(comparison).includes('"entry"'));
  const post=(body,token=model.csrf)=>fetch(url+'/api/review',{method:'POST',headers:{'Content-Type':'application/json','X-Curation-Token':token},body:JSON.stringify(body)});
  const missing=await post({id:original.id,status:'approved',note:'',revision:model.review.revision});assert.equal(missing.status,400);assert.match((await missing.json()).message,/메모/);
  const denied=await post({id:original.id,status:'approved',note:'고급 재질 확인',revision:model.review.revision},'wrong');assert.equal(denied.status,403);
  const approved=await post({id:original.id,status:'approved',note:'고급 재질 확인',revision:model.review.revision});assert.equal(approved.status,200);
  const blocked=await fetch(url+'/api/comparison-choice',{method:'POST',headers:{'Content-Type':'application/json','X-Curation-Token':model.csrf},body:JSON.stringify({id:original.id,productId:'88000003',revision:(await approved.json()).revision})});
  assert.equal(blocked.status,400);assert.match((await blocked.json()).message,/미검토 후보/);
});

test('일괄 승인 중 가격 경고가 있으면 앞선 정상 항목도 저장하지 않음',async t=>{
  const root=await fixture(t,{outlier:true}),state=await loadCatalog(root);
  const safe={...catalog.candidates.find(c=>c.id==='C29'),checkedAt};
  state.catalog.candidates.push(safe);state.review.decisions[safe.id]={status:'unreviewed',note:''};
  await writeJSON(path.join(root,'content/candidates.json'),state.catalog);
  await writeJSON(path.join(root,'content/review.json'),state.review);
  const before=await readFile(path.join(root,'content/review.json'),'utf8');
  const server=createLocalServer({root,admin:true,sourceOperations:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`,model=await (await fetch(url+'/api/catalog')).json();
  const response=await fetch(url+'/api/review-batch',{method:'POST',headers:{'Content-Type':'application/json','X-Curation-Token':model.csrf},body:JSON.stringify({ids:[safe.id,original.id],status:'approved',revision:model.review.revision})});
  assert.equal(response.status,400);assert.match((await response.json()).message,/메모/);
  assert.equal(await readFile(path.join(root,'content/review.json'),'utf8'),before);
});
