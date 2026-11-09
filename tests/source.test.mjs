import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,cp,mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { projectRoot,readJSON,writeJSON,loadCatalog,buildBank,publishBank,updateDecision,excludeUnreviewed } from '../scripts/curation.mjs';
import { familyOf, interestScore } from '../scripts/discovery-policy.mjs';
import { createProcurementApi,kstDate,sha256 } from '../scripts/procurement-api.mjs';
import { createSourceOperations,sameContract,isUsableRecord,DISCOVERY_SOURCES } from '../scripts/source-operations.mjs';
import { createSourceJobs } from '../scripts/source-jobs.mjs';
const legacy=await readJSON(new URL('../dist/legacy-data.json',import.meta.url));
const bytes=await readFile(new URL('../dist/assets/products/C01.jpg',import.meta.url));
const image={bytes,extension:'.jpg',sha256:sha256(bytes)};
const rowFor = (q,overrides={}) => ({prdctIdntNo:q.productId,prdctClsfcNoNm:'옥외용벤치',prdctSpecNm:q.specification,cntrctPrceAmt:String(q.answer),prdctUnit:q.unit,prdctDlvryCndtnNm:q.delivery,vatAplDivNm:q.vat,cntrctCorpNm:q.supplier,shopngCntrctNo:q.contractNumber,shopngCntrctSno:q.contractLine,cntrctBgnDate:'2020-01-01',cntrctEndDate:'2035-12-31',prdctImgUrl:q.image.sourceUrl,...overrides});
const apiFor = fn => ({query:async(operation,params)=>({items:await fn(operation,params),totalCount:200,checkedAt:new Date().toISOString()}),image:async url=>{const uniqueBytes=Buffer.concat([bytes,Buffer.from(url)]);return {bytes:uniqueBytes,extension:'.jpg',sha256:sha256(uniqueBytes)};}});
async function fixture(t) {
  const base=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(base,'nara-source-'));
  t.after(()=>{if(path.dirname(path.resolve(root))!==base||!path.basename(root).startsWith('nara-source-'))throw Error('Unsafe temporary path');return rm(root,{recursive:true,force:true});});
  for(const dir of ['content','dist','supabase'])await cp(path.join(projectRoot,dir),path.join(root,dir),{recursive:true});
  const {catalog}=await loadCatalog(root);
  catalog.candidates=catalog.candidates.filter(c=>['C01','C22','C28'].includes(c.id));
  await writeJSON(path.join(root,'content/candidates.json'),catalog);
  await writeJSON(path.join(root,'content/review.json'),{schemaVersion:1,revision:0,decisions:Object.fromEntries(catalog.candidates.map(c=>[c.id,{status:'approved',note:''}]))});
  await publishBank(root);
  return root;
}

test('API 인증키는 요청에서 한 번만 인코딩하고 연락처·개인정보·키를 결과에서 제거',async()=>{
  const secret='secret+/=';let captured;
  const api=createProcurementApi({serviceKey:encodeURIComponent(secret),fetchImpl:async url=>{
    captured=new URL(url);return new Response(JSON.stringify({response:{header:{resultCode:'00'},body:{totalCount:1,items:[{...rowFor(legacy.questions[0]),cntrctOfclEmail:'private@example.test',cntrctOfclNm:'담당자',serviceKey:secret}]}}}));
  }});
  const result=await api.query('getMASCntrctPrdctInfoList',{prdctIdntNo:'25126005'});
  assert.equal(captured.searchParams.get('serviceKey'),secret);
  assert.ok(!JSON.stringify(result).includes('private@example.test'));
  assert.ok(!JSON.stringify(result).includes(secret));
  const bad=createProcurementApi({serviceKey:secret,fetchImpl:async()=>{throw Error('https://bad?serviceKey='+secret);}});
  await assert.rejects(bad.query('getMASCntrctPrdctInfoList'),error=>!error.message.includes(secret));
});

test('계약번호·순번·단위·인도조건을 함께 대조하고 만료·0원·외부 이미지 주소를 거부',()=>{
  const q=legacy.questions[0],row=rowFor(q);
  assert.equal(Boolean(isUsableRecord(row)),true);assert.equal(sameContract(row,q),true);
  for(const overrides of [{shopngCntrctSno:'999'},{prdctUnit:'세트'},{prdctDlvryCndtnNm:'생산공장 상차도'}])assert.equal(sameContract({...row,...overrides},q),false);
  for(const overrides of [{cntrctEndDate:'2020-01-01'},{cntrctPrceAmt:'0'},{prdctImgUrl:'https://example.test/image.jpg'}])assert.equal(Boolean(isUsableRecord({...row,...overrides})),false);
});

test('종류 판정은 제조사·모델·크기·색상을 무시하고 실제 용도 차이는 보존',()=>{
  const a={specification:'옥외용벤치, 회사A, ABC-1, 1500mm, 빨강'};
  const b={specification:'옥외용벤치, 회사B, XYZ-999, 3000mm, 파랑'};
  assert.equal(familyOf(a).key,familyOf(b).key);
  assert.equal(familyOf({specification:'저출력심장충격기, A, 모델'}).key,familyOf({specification:'심장충격기, B, 모델2'}).key);
  assert.equal(familyOf({specification:'경비및감시용로봇, A, 모델'}).key,familyOf({specification:'순찰로봇, B, 모델2'}).key);
  assert.notEqual(familyOf(a).key,familyOf({specification:'클린벤치, 실험회사, 모델'}).key);
  assert.notEqual(familyOf({specification:'장갑, A, 모델, 군전투용'}).key,familyOf({specification:'절연장갑, B, 모델'}).key);
  assert.equal(familyOf({specification:'실체현미경, A, 모델'}).key,familyOf({specification:'멀티미디어영상현미경, B, 모델2'}).key);
  assert.notEqual(familyOf({specification:'전자현미경, A, 모델'}).key,familyOf({specification:'광학현미경, B, 모델2'}).key);
  assert.ok(interestScore({specification:'로봇페인팅서비스, A, 모델'})<0);
  assert.ok(interestScore({specification:'서비스로봇, A, 모델'})>=0);
});

test('미검토 일괄 제외는 승인·보류·메모를 보존하고 상품·종류 이력을 남김',()=>{
  const [a,b,c]=legacy.questions;
  const pending={...c,id:'P81000001',productId:'81000001'};
  const catalog={candidates:[a,b,pending]};
  const review={revision:7,decisions:{[a.id]:{status:'approved',note:'승인 메모'},[b.id]:{status:'held',note:'보류 메모'},[pending.id]:{status:'unreviewed',note:'이미 검토함'}}};
  const result=excludeUnreviewed(review,catalog,7);
  assert.deepEqual(result.ids,[pending.id]);assert.equal(result.review.revision,8);
  assert.deepEqual(result.review.decisions[a.id],review.decisions[a.id]);
  assert.deepEqual(result.review.decisions[b.id],review.decisions[b.id]);
  assert.equal(result.review.decisions[pending.id].status,'excluded');
  assert.equal(result.review.decisions[pending.id].note,'이미 검토함');
  assert.equal(review.decisions[pending.id].status,'unreviewed');
  assert.ok(result.review.excludedProducts[pending.productId]);
  assert.ok(result.review.seenFamilies[familyOf(pending).key]);
  assert.throws(()=>excludeUnreviewed(review,catalog,6),/선택 내용/);
  assert.equal(excludeUnreviewed(result.review,catalog,8).ids.length,0);
});

test('재수집은 제외 물품과 이미 있는 상품을 건너뛰고 다음 위치에서 이어가며 미검토로 추가',async t=>{
  const root=await fixture(t);
  const review=await readJSON(path.join(root,'content/review.json'));
  review.excludedProducts={'10000001':{note:'영구 제외',excludedAt:null}};
  await writeJSON(path.join(root,'content/review.json'),review);
  const q=legacy.questions[0];let calls=0;
  const names=['기체분석기','수중탐사기','천체투영기','동결건조기','인공위성모형','종자선별기','착유기','지진계','전자현미경','수중음향탐지기','시추장비'];
  const rows=[rowFor(q,{prdctClsfcNoNm:'실험장비'}),rowFor(q,{prdctIdntNo:'99999999',prdctClsfcNoNm:'실험장비',prdctSpecNm:'옥외용벤치, 새회사, M999, 9999mm',prdctImgUrl:'https://shop.g2b.go.kr/static/new-bench.jpg'}),rowFor(q,{prdctIdntNo:'10000001',prdctClsfcNoNm:'실험장비'}),...names.flatMap((name,i)=>[0,1].map(model=>rowFor(q,{prdctIdntNo:String(10000002+i*2+model),prdctClsfcNoNm:'실험장비',shopngCntrctNo:'NEW'+i,cntrctPrceAmt:String(q.answer*(model+1)),prdctSpecNm:`${name}, 제조사${model}, 모델${model}, ${model+1}m`,prdctImgUrl:`https://shop.g2b.go.kr/static/model-${i}-${model}.jpg`})) )];
  const ops=createSourceOperations({apiFactory:()=>apiFor(()=>{calls++;return rows;}),discoverySources:[{key:'test',term:'장비',category:'과학',operation:'getMASCntrctPrdctInfoList'}]});
  const first=await ops.collect(root,()=>{},5);assert.equal(first.added,5);
  const second=await ops.collect(root,()=>{},5);assert.equal(second.added,5);assert.equal(calls,1);
  const state=await loadCatalog(root);
  assert.equal(state.catalog.candidates.length,13);
  assert.equal(new Set(state.catalog.candidates.map(c=>c.productId)).size,13);
  assert.equal(new Set(state.catalog.candidates.filter(c=>[...first.ids,...second.ids].includes(c.id)).map(c=>familyOf(c).key)).size,10);
  assert.ok(!state.catalog.candidates.some(c=>c.productId==='10000001'));
  assert.ok(!state.catalog.candidates.some(c=>c.productId==='99999999'));
  assert.ok([...first.ids,...second.ids].every(id=>state.review.decisions[id].status==='unreviewed'));
  assert.equal(state.review.decisions.C01.status,'approved');
  const restored=updateDecision(state.review,state.catalog,{id:'C01',status:'excluded',revision:state.review.revision});
  assert.ok(restored.excludedProducts[q.productId]);
  assert.ok(!updateDecision(restored,state.catalog,{id:'C01',status:'held',revision:restored.revision}).excludedProducts[q.productId]);
});

test('용도 이름이 달라도 동일한 상품 이미지면 새 후보에서 제거',async t=>{
  const root=await fixture(t),q=legacy.questions[0];
  const sameBytes=Buffer.concat([bytes,Buffer.from('same stock image')]);
  const rows=['기체분석기','지진계'].map((name,i)=>rowFor(q,{prdctIdntNo:String(90000001+i),prdctClsfcNoNm:'과학장비',prdctSpecNm:`${name}, 회사, 모델`,prdctImgUrl:`https://shop.g2b.go.kr/static/copy-${i}.jpg`}));
  const api=apiFor(()=>rows);api.image=async()=>({bytes:sameBytes,sha256:sha256(sameBytes),extension:'.jpg'});
  const ops=createSourceOperations({apiFactory:()=>api,discoverySources:[{key:'same-image',term:'장비',category:'과학',operation:'getMASCntrctPrdctInfoList'}],maxRequests:2});
  const result=await ops.collect(root,()=>{},5);
  assert.equal(result.added,1);assert.ok(result.duplicateImages>=1);
});

test('승인 정보 갱신은 가격 차이를 기록하고 과거 이미지·게임 파일·승인 상태를 보존',async t=>{
  const root=await fixture(t),initial=await loadCatalog(root);
  const gameBefore=await readFile(path.join(root,'dist/data.json'),'utf8');
  const imageBefore=await readFile(path.join(root,'dist/assets/products/C01.jpg'));
  const ops=createSourceOperations({apiFactory:()=>apiFor((op,p)=>{
    const c=initial.catalog.candidates.find(c=>c.productId===p.prdctIdntNo);
    return [rowFor(c,{cntrctPrceAmt:String(c.answer+123)})];
  })});
  const result=await ops.refresh(root);assert.equal(result.verified,3);assert.equal(result.changed,3);
  const updated=await loadCatalog(root);
  assert.equal(updated.catalog.candidates[0].answer,initial.catalog.candidates[0].answer+123);
  assert.ok(updated.catalog.candidates[0].lastChanges.some(c=>c.field==='answer'));
  assert.equal(updated.catalog.candidates[0].freshness.status,'verified');
  assert.equal(updated.catalog.base.referenceDate,kstDate());
  assert.equal(await readFile(path.join(root,'dist/data.json'),'utf8'),gameBefore);
  assert.deepEqual(await readFile(path.join(root,'dist/assets/products/C01.jpg')),imageBefore);
  assert.deepEqual(updated.review.decisions,initial.review.decisions);
  const bank=buildBank(updated.catalog,updated.review,{requireFresh:true});
  const later=structuredClone(updated.catalog);for(const c of later.candidates){c.checkedAt=new Date(Date.parse(c.checkedAt)+1000).toISOString();c.image.retrievedAt=new Date().toISOString();}
  assert.equal(buildBank(later,updated.review).bankVersion,bank.bankVersion);
});

test('새 후보 한 묶음이 여러 분야를 번갈아 포함하도록 수집',async t=>{
  const root=await fixture(t);let sequence=0;
  const ops=createSourceOperations({apiFactory:()=>apiFor((operation,p)=>Array.from({length:5},()=>{const id=String(12000000+sequence++);return rowFor(legacy.questions[0],{prdctIdntNo:id,prdctClsfcNoNm:p.prdctClsfcNoNm,prdctSpecNm:p.prdctClsfcNoNm+', 제조사, 모델',prdctImgUrl:`https://shop.g2b.go.kr/static/${id}.jpg`});})),discoverySources:DISCOVERY_SOURCES});
  const result=await ops.collect(root,()=>{},20);assert.equal(result.added,20);
  const {catalog}=await loadCatalog(root);
  assert.ok(new Set(catalog.candidates.filter(c=>result.ids.includes(c.id)).map(c=>c.category)).size>=5);
});

test('서버 중단 전 저장한 수집 후보를 중복 없이 복구',async t=>{
  const root=await fixture(t),initial=await loadCatalog(root);
  const recoveredBytes=Buffer.concat([bytes,Buffer.from('recovered')]);
  const recovered={...initial.catalog.candidates[0],id:'P33333333',productId:'33333333',title:'인공위성모형',specification:'인공위성모형, 제조사, 모델',checkedAt:new Date().toISOString(),image:{...initial.catalog.candidates[0].image,src:'./assets/products/recovered.jpg',sha256:sha256(recoveredBytes)}};
  await writeFile(path.join(root,'content/images/recovered.jpg'),recoveredBytes);
  await writeJSON(path.join(root,'.artifacts/source-state.json'),{strategy:'novel-families-v1',nextSource:0,sources:{},pendingCandidates:[recovered]});
  const ops=createSourceOperations({apiFactory:()=>apiFor(()=>{throw Error('복구에 추가 조회가 필요하지 않음');})});
  const result=await ops.collect(root,()=>{},1);assert.equal(result.added,1);assert.equal(result.requests,0);
  const state=await loadCatalog(root);assert.equal(state.review.decisions.P33333333.status,'unreviewed');
  assert.equal(state.catalog.candidates.filter(c=>c.productId==='33333333').length,1);
  assert.deepEqual((await readJSON(path.join(root,'.artifacts/source-state.json'))).pendingCandidates,[]);
});

test('조회 실패와 계약 행 변경은 최신으로 표시하지 않고 기존 게임 발행을 유지',async t=>{
  const root=await fixture(t),initial=await loadCatalog(root),before=await readFile(path.join(root,'dist/data.json'),'utf8');
  const ops=createSourceOperations({apiFactory:()=>apiFor((op,p)=>{
    const c=initial.catalog.candidates.find(c=>c.productId===p.prdctIdntNo);
    return [rowFor(c,{shopngCntrctSno:'다른계약'})];
  })});
  await assert.rejects(ops.apply(root),/기존 게임은 유지/);
  const latest=await loadCatalog(root);
  assert.ok(latest.catalog.candidates.every(c=>c.freshness.status==='failed'));
  assert.deepEqual(latest.review.decisions,initial.review.decisions);
  assert.equal(await readFile(path.join(root,'dist/data.json'),'utf8'),before);
  assert.throws(()=>buildBank(latest.catalog,latest.review,{requireFresh:true}),/최신 계약/);
});

test('검증 후 반영은 현재 계약을 다시 조회해 게임과 SQL을 같은 가격으로 생성',async t=>{
  const root=await fixture(t),initial=await loadCatalog(root);let queries=0;
  const ops=createSourceOperations({apiFactory:()=>apiFor((op,p)=>{queries++;return [rowFor(initial.catalog.candidates.find(c=>c.productId===p.prdctIdntNo))];})});
  const result=await ops.apply(root);assert.equal(result.count,3);assert.equal(queries,3);
  const bank=await readJSON(path.join(root,'dist/data.json'));
  assert.equal(bank.referenceDate,kstDate());
  assert.ok(bank.questions.every(q=>kstDate(q.checkedAt)===kstDate()));
  assert.ok((await readFile(path.join(root,'supabase/curated-release.sql'),'utf8')).includes(bank.bankVersion));
});

test('백그라운드 작업은 중복 실행을 막고 진행률·완료·실패 상태를 노출',async()=>{
  let finish;
  const jobs=createSourceJobs({collect:async(root,progress)=>{progress({added:3});await new Promise(resolve=>finish=resolve);return {added:3};},refresh:async()=>{throw Error('연결 실패');}},'.');
  const job=jobs.start('collect');await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(jobs.active().id,job.id);assert.equal(job.progress.added,3);
  assert.throws(()=>jobs.start('collect'),/진행 중/);
  finish();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(jobs.get(job.id).status,'complete');
  const failed=jobs.start('refresh');await new Promise(resolve=>setTimeout(resolve,0));assert.equal(jobs.get(failed.id).error,'연결 실패');
});
