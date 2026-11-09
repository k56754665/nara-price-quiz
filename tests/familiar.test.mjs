import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { projectRoot, readJSON, writeJSON, loadCatalog } from '../scripts/curation.mjs';
import { createProcurementApi, sha256 } from '../scripts/procurement-api.mjs';
import { createFamiliarSourceOperations } from '../scripts/familiar-collection.mjs';
import { createLocalServer } from '../scripts/local-server.mjs';
import { matchesFamiliarTopic, familiarSearchPlan, FAMILIAR_SEARCHES } from '../scripts/familiar-policy.mjs';
import { getDiscoveryStatus,pendingDiscoveryJobs } from '../scripts/discovery-status.mjs';
import { buildProductComparison } from '../scripts/product-comparison.mjs';
import { COLLECTION_PRESETS } from '../scripts/collection-presets.mjs';

const plan=await readJSON(path.join(projectRoot,'content/familiar-item-topics.json'));
const base=await readJSON(path.join(projectRoot,'content/candidates.json'));
const q=base.candidates.find(c=>c.id==='C01');
const row=(id,family,extra='')=>({prdctIdntNo:id,prdctClsfcNoNm:family,prdctSpecNm:`${family}, 회사, 모델, ${extra || (family==='농구대'?'고정식':family==='시소'?'2000×400×800mm, 2인용':'1000×500×800mm')}`,cntrctPrceAmt:'500000',prdctUnit:'대',prdctDlvryCndtnNm:'현장설치도',vatAplDivNm:'부가가치세포함',shopngCntrctNo:'TEST',shopngCntrctSno:id,cntrctBgnDate:'2020-01-01',cntrctEndDate:'2035-12-31',prdctImgUrl:`https://shop.g2b.go.kr/static/${id}.jpg`});
async function fixture(t) {
  const parent=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(parent,'nara-familiar-'));
  t.after(()=>{if(path.dirname(path.resolve(root))!==parent||!path.basename(root).startsWith('nara-familiar-'))throw Error('Unsafe fixture path');return rm(root,{recursive:true,force:true});});
  await mkdir(path.join(root,'content'),{recursive:true});await mkdir(path.join(root,'dist'),{recursive:true});
  await writeJSON(path.join(root,'content/candidates.json'),{...base,candidates:[q]});
  await writeJSON(path.join(root,'content/review.json'),{schemaVersion:1,revision:3,decisions:{C01:{status:'approved',note:'유지'}}});
  await copyFile(path.join(projectRoot,'content/familiar-item-topics.json'),path.join(root,'content/familiar-item-topics.json'));
  await copyFile(path.join(projectRoot,'dist/data.json'),path.join(root,'dist/data.json'));
  return root;
}
const api=(query)=>({query:async(op,params)=>{const items=await query(params.prdctClsfcNoNm);return {items,totalCount:items.length,pageSize:100,checkedAt:new Date().toISOString()};},image:async url=>{const bytes=Buffer.from(url);return {bytes,sha256:sha256(bytes),extension:'.jpg'};}});

test('일상 종류 매칭은 서비스·부품·기둥·임의 농업장비를 제외하고 실제 용도 별칭만 허용',()=>{
  const get=id=>plan.topics.find(t=>t.id===id);
  assert.equal(matchesFamiliarTopic(get('F028'),row('80000001','시소')),true);
  assert.equal(matchesFamiliarTopic(get('F028'),row('80000001','시소','(부품)지주')),false);
  assert.equal(matchesFamiliarTopic(get('F028'),row('80000001','농업용트랙터')),false);
  assert.equal(matchesFamiliarTopic(get('F003'),row('80000001','신호등주')),false);
  assert.equal(matchesFamiliarTopic(get('F003'),row('80000001','교통신호등','차량용')),false);
  assert.equal(matchesFamiliarTopic(get('F003'),row('80000001','교통신호등','보행자용')),true);
  assert.equal(matchesFamiliarTopic(get('F002'),row('80000001','버스및차량정보안내장치','버스정보안내단말기')),true);
  assert.equal(matchesFamiliarTopic(get('F058'),row('80000001','주차관제장치','차량차단기')),true);
  assert.equal(matchesFamiliarTopic(get('F058'),row('80000001','주차관제장치','번호판인식카메라')),false);
  assert.equal(matchesFamiliarTopic(get('F085'),row('80000001','침낭','침낭주머니')),false);
  assert.equal(matchesFamiliarTopic(get('F035'),row('80000001','식판배분대')),false);
  assert.equal(matchesFamiliarTopic(get('F035'),row('80000001','식탁용식기','스테인리스 식판')),true);
  assert.equal(matchesFamiliarTopic(get('F029'),row('80000001','운동장및놀이터용흔들놀이기구','곰돌이')),true);
  assert.equal(matchesFamiliarTopic(get('F107'),row('80000001','자동개집표기','지하철 개찰 게이트')),true);
  assert.equal(matchesFamiliarTopic(get('F107'),row('80000001','자동요금징수기','톨게이트 하이패스')),false);
  assert.equal(matchesFamiliarTopic(get('F150'),row('80000001','환자운반기','계단용 리프트')),false);
  assert.equal(matchesFamiliarTopic(get('F150'),row('80000001','환자운반기','환자운반 들것')),true);
  assert.equal(matchesFamiliarTopic(get('F193'),row('80000001','휠체어','수동 접이식')),true);
  assert.equal(matchesFamiliarTopic(get('F193'),row('80000001','휠체어','전동 모터 구동')),false);
  assert.equal(matchesFamiliarTopic(get('F222'),row('80000001','무인항공기','카메라 영상 촬영')),true);
  assert.equal(matchesFamiliarTopic(get('F222'),row('80000001','무인항공기','카메라 포함 농약 살포용')),false);
  assert.equal(matchesFamiliarTopic(get('F247'),row('80000001','자동흉부압박기','환자용 본체')),true);
  assert.equal(matchesFamiliarTopic(get('F247'),row('80000001','자동흉부압박기','심폐소생술 실습 모형')),false);
});

test('API 예산·종류당 1개·기존 제외·새 미검토 적재·게임 유지·응답 재사용',async t=>{
  const root=await fixture(t),before=await readFile(path.join(root,'dist/data.json'),'utf8');
  const review=await readJSON(path.join(root,'content/review.json'));review.excludedProducts={'80000001':{note:'제외 유지'}};
  await writeJSON(path.join(root,'content/review.json'),review);
  let calls=0;
  const searches=[['F028','시소'],['F043','농구대'],['F044','축구골대'],['F035','식판']];
  const client=api(term=>{calls++;return [row('80000001',term),row(String(80000000+calls*10),term),row(String(80000001+calls*10),term)];});
  const ops=createFamiliarSourceOperations({apiFactory:()=>client,maxRequests:3,searches});
  const result=await ops.collect(root);
  assert.equal(calls,3);assert.equal(result.requests,3);assert.equal(result.added,3);assert.equal(new Set(result.items.map(i=>i.topicId)).size,3);
  const latest=await loadCatalog(root);assert.equal(latest.review.decisions.C01.note,'유지');
  assert.ok(result.ids.every(id=>latest.review.decisions[id].status==='unreviewed'));
  assert.ok(!latest.catalog.candidates.some(c=>c.productId==='80000001'));
  assert.equal(await readFile(path.join(root,'dist/data.json'),'utf8'),before);
  const repeat=await createFamiliarSourceOperations({apiFactory:()=>{throw Error('no extra requests');},maxRequests:0,searches}).collect(root);
  assert.equal(repeat.requests,0);assert.equal(repeat.added,0);
});

test('0건 응답을 재사용하고 제외한 종류는 다른 모델로 다시 채우지 않음',async t=>{
  const root=await fixture(t);let calls=0;
  const empty=createFamiliarSourceOperations({apiFactory:()=>api(()=>{calls++;return [];}),maxRequests:1,searches:[['F028','시소']]});
  await empty.collect(root);await empty.collect(root);assert.equal(calls,1);
  const {catalog,review}=await loadCatalog(root);
  catalog.candidates.push({...q,id:'P81000001',productId:'81000001',specification:'농구대, A, MODEL'});
  review.decisions.P81000001={status:'excluded',note:'이 상품은 제외'};review.seenFamilies={'kind:농구대':{label:'농구대'}};
  await writeJSON(path.join(root,'content/candidates.json'),catalog);await writeJSON(path.join(root,'content/review.json'),review);
  const result=await createFamiliarSourceOperations({apiFactory:()=>{throw Error('제외 종류를 다시 조회하면 안 됨');},maxRequests:1,searches:[['F043','농구대']]}).collect(root);
  assert.equal(result.added,0);assert.equal(result.newKinds,0);assert.equal(result.requests,0);assert.equal((await loadCatalog(root)).review.decisions.P81000001.status,'excluded');
});

test('제외한 종류의 저장 모델은 건너뛰고 아직 보지 않은 종류만 조회·추가',async t=>{
  const root=await fixture(t),state=await loadCatalog(root),checkedAt=new Date().toISOString();
  const rejected={...q,id:'P81000001',productId:'81000001',specification:'농구대, 회사A, MODEL, 고정식',discoveryTopicId:'F043'};
  state.catalog.candidates.push(rejected);state.review.decisions[rejected.id]={status:'excluded',note:'다시 안 보고 싶음'};
  await writeJSON(path.join(root,'content/candidates.json'),state.catalog);await writeJSON(path.join(root,'content/review.json'),state.review);
  const cached=row('81000002','농구대');
  await writeJSON(path.join(root,'.artifacts/familiar-source-cache.json'),{queries:{cached:{items:[cached],totalCount:1,checkedAt,operation:'getMASCntrctPrdctInfoList'}},runs:[]});
  const queried=[];
  const client=api(term=>{queried.push(term);assert.notEqual(term,'농구대');return [row('81000003','시소')];});
  const searches=[['F043','농구대'],['F028','시소']];
  const result=await createFamiliarSourceOperations({apiFactory:()=>client,maxRequests:2,searches}).collect(root);
  assert.deepEqual(queried,['시소']);assert.equal(result.newKinds,1);assert.equal(result.existingKindModels,0);
  assert.equal(result.items[0].topicId,'F028');assert.equal(result.ids.includes('P81000002'),false);
  const after=await loadCatalog(root);after.review.decisions[result.ids[0]].status='excluded';
  await writeJSON(path.join(root,'content/review.json'),after.review);
  const repeat=await createFamiliarSourceOperations({apiFactory:()=>{throw Error('같은 종류의 조회·이미지 요청 금지');},maxRequests:2,searches}).collect(root);
  assert.equal(repeat.requests,0);assert.equal(repeat.newKinds,0);
  assert.equal((await loadCatalog(root)).review.decisions[rejected.id].note,'다시 안 보고 싶음');
});

test('이미지를 받는 동안 같은 종류가 제외되면 저장 직전에 다시 검사하고 추가 수를 부풀리지 않음',async t=>{
  const root=await fixture(t),client=api(()=>[row('81000010','시소')]);
  const image=client.image;
  client.image=async url=>{
    const state=await loadCatalog(root);
    state.catalog.candidates.push({...q,id:'P81000011',productId:'81000011',specification:'시소, 회사, 다른모델, 2000×400×800mm, 2인용',discoveryTopicId:'F028'});
    state.review.decisions.P81000011={status:'excluded',note:'다른 화면에서 제외'};state.review.revision++;
    await writeJSON(path.join(root,'content/candidates.json'),state.catalog);await writeJSON(path.join(root,'content/review.json'),state.review);
    return image(url);
  };
  const result=await createFamiliarSourceOperations({apiFactory:()=>client,maxRequests:1,searches:[['F028','시소']]}).collect(root);
  assert.equal(result.added,0);assert.equal(result.newKinds,0);assert.deepEqual(result.ids,[]);
  const after=await loadCatalog(root);assert.equal(after.catalog.candidates.some(c=>c.id==='P81000010'),false);
  assert.equal(after.review.decisions.P81000011.status,'excluded');assert.equal(after.review.decisions.C01.note,'유지');
});

test('예산 수집은 실패 시 숨은 재시도를 하지 않음',async()=>{
  let calls=0;const client=createProcurementApi({serviceKey:'test',maxAttempts:1,fetchImpl:async()=>{calls++;throw Error('offline');}});
  await assert.rejects(client.query('getMASCntrctPrdctInfoList'));assert.equal(calls,1);
});

test('저장된 새 종류가 있으면 빈 API 검색을 기다리지 않고 즉시 반환',async t=>{
  const root=await fixture(t),checkedAt=new Date().toISOString();
  await writeJSON(path.join(root,'.artifacts/familiar-source-cache.json'),{queries:{saved:{operation:'getMASCntrctPrdctInfoList',checkedAt,items:[row('81000021','시소')],totalCount:1}},runs:[]});
  const result=await createFamiliarSourceOperations({apiFactory:()=>api(()=>{throw Error('추가 가격 조회 금지');}),maxRequests:2,searches:[['F028','시소'],['F043','농구대']]}).collect(root);
  assert.equal(result.added,1);assert.equal(result.requests,0);assert.equal(result.stopReason,'cached_candidates_added');
});

test('기존 20개 검색이 캐시되어도 100종의 미탐색 검색으로 실제 조회를 이어감',async t=>{
  const root=await fixture(t),checkedAt=new Date().toISOString();
  const sources=familiarSearchPlan(plan);
  assert.equal(new Set(sources.map(source=>source.id)).size,plan.topics.length);
  assert.ok(sources.some(source=>source.operation==='getThptyUcntrctPrdctInfoList'));
  const oldKeys=new Set(FAMILIAR_SEARCHES.map(([,term])=>'getMASCntrctPrdctInfoList:'+term));
  await writeJSON(path.join(root,'.artifacts/familiar-source-cache.json'),{queries:Object.fromEntries([...oldKeys].map(key=>[key,{items:[],totalCount:0,checkedAt}])),runs:[]});
  const called=[];
  const ops=createFamiliarSourceOperations({maxRequests:1,apiFactory:()=>api(term=>{called.push(term);return [];})});
  const result=await ops.collect(root);
  assert.equal(called.length,1);assert.equal(result.requests,1);
  assert.ok(!oldKeys.has('getMASCntrctPrdctInfoList:'+called[0]));
  assert.ok(result.remainingSearches>0);assert.equal(result.stopReason,'request_limit');
});

test('첫 페이지 캐시는 반복 조회하지 않고 아직 받지 않은 다음 페이지로 진행',async t=>{
  const root=await fixture(t),checkedAt=new Date().toISOString();
  const term='시소',key='getMASCntrctPrdctInfoList:'+term;
  await writeJSON(path.join(root,'.artifacts/familiar-source-cache.json'),{queries:{[key]:{items:[row('83000001','농업용트랙터')],totalCount:200,pageSize:100,checkedAt,operation:'getMASCntrctPrdctInfoList'}},runs:[]});
  let page,calls=0;
  const client=api(()=>[row('83000002','시소')]);const query=client.query;
  client.query=async(operation,params)=>{page=params.pageNo;calls++;return query(operation,params);};
  const result=await createFamiliarSourceOperations({apiFactory:()=>client,maxRequests:1,searches:[['F028',term]]}).collect(root);
  assert.equal(calls,1);assert.equal(page,2);assert.equal(result.added,1);assert.equal(result.receivedRows,1);
  const saved=await readJSON(path.join(root,'.artifacts/familiar-source-cache.json'));
  assert.ok(saved.queries[key+':page:2']);assert.equal(saved.queries[key].checkedAt,checkedAt);
});

test('기본 수집 버튼의 HTTP 작업도 캐시 20개 이후 실제 새 조회와 후보 적재를 수행',async t=>{
  const root=await fixture(t),checkedAt=new Date().toISOString(),oldKeys=FAMILIAR_SEARCHES.map(([,term])=>'getMASCntrctPrdctInfoList:'+term);
  await writeJSON(path.join(root,'.artifacts/familiar-source-cache.json'),{queries:Object.fromEntries(oldKeys.map(key=>[key,{items:[],totalCount:0,checkedAt}])),runs:[]});
  let calls=0;
  const sourceOperations=createFamiliarSourceOperations({maxRequests:1,apiFactory:()=>api(term=>{calls++;return [row('85000001',term)];})});
  const server=createLocalServer({root,admin:true,sourceOperations});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`,model=await fetch(url+'/api/catalog').then(r=>r.json());
  const response=await fetch(url+'/api/collect',{method:'POST',headers:{'Content-Type':'application/json','X-Curation-Token':model.csrf},body:JSON.stringify({revision:model.review.revision})});
  assert.equal(response.status,202);let job=await response.json();
  for(let i=0;job.status==='running'&&i<100;i++){await new Promise(resolve=>setTimeout(resolve,10));job=await fetch(url+'/api/jobs/'+job.id).then(r=>r.json());}
  assert.equal(job.status,'complete');assert.equal(calls,1);assert.equal(job.result.requests,1);assert.equal(job.result.added,1);
  assert.ok(!oldKeys.includes('getMASCntrctPrdctInfoList:'+job.result.queries[0].term));
  assert.equal((await loadCatalog(root)).review.decisions[job.result.ids[0]].status,'unreviewed');
  const refreshed=await fetch(url+'/api/catalog').then(r=>r.json());assert.equal(refreshed.lastCollection.requests,1);assert.equal(refreshed.lastCollection.receivedRows,1);assert.equal(refreshed.lastCollection.added,1);
});

test('다수공급자 조회만 완료된 경우 다른 계약 유형의 미탐색 조회가 남음',async t=>{
  const root=await fixture(t),checkedAt=new Date().toISOString(),sources=familiarSearchPlan(plan);
  await writeJSON(path.join(root,'.artifacts/familiar-source-cache.json'),{queries:Object.fromEntries(sources.filter(s=>s.operation==='getMASCntrctPrdctInfoList').map(s=>[s.key,{items:[],totalCount:0,checkedAt}])),runs:[]});
  let usedOperation;
  const client=api(()=>[]),query=client.query;client.query=async(operation,params)=>{usedOperation=operation;return query(operation,params);};
  const result=await createFamiliarSourceOperations({maxRequests:1,apiFactory:()=>client}).collect(root);
  assert.equal(result.requests,1);assert.equal(usedOperation,'getThptyUcntrctPrdctInfoList');
});

test('두 계약 유형을 확인했어도 일반 단가계약의 미탐색 조회를 이어감',async t=>{
  const root=await fixture(t),checkedAt=new Date().toISOString(),sources=familiarSearchPlan(plan);
  await writeJSON(path.join(root,'.artifacts/familiar-source-cache.json'),{queries:Object.fromEntries(sources.filter(s=>s.operation!=='getUcntrctPrdctInfoList').map(s=>[s.key,{items:[],totalCount:0,checkedAt}])),runs:[]});
  let usedOperation;
  const client=api(()=>[]),query=client.query;client.query=async(operation,params)=>{usedOperation=operation;return query(operation,params);};
  const result=await createFamiliarSourceOperations({maxRequests:1,apiFactory:()=>client}).collect(root);
  assert.equal(result.requests,1);assert.equal(usedOperation,'getUcntrctPrdctInfoList');
});

test('검색이 모두 끝나면 화면 모델과 수집 API가 소진 상태를 알리고 추가 호출하지 않음',async t=>{
  const root=await fixture(t),checkedAt=new Date().toISOString();
  await writeJSON(path.join(root,'.artifacts/familiar-source-cache.json'),{queries:Object.fromEntries(familiarSearchPlan(plan).map(s=>[s.key,{items:[],totalCount:0,checkedAt}])),runs:[]});
  const sourceOperations=createFamiliarSourceOperations({apiFactory:()=>{throw Error('API must not run');}});
  const server=createLocalServer({root,admin:true,sourceOperations});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`,model=await fetch(url+'/api/catalog').then(r=>r.json());
  assert.equal(model.discoveryStatus.exhausted,true);assert.equal(model.discoveryStatus.remainingQueries,0);
  const response=await fetch(url+'/api/collect',{method:'POST',headers:{'Content-Type':'application/json','X-Curation-Token':model.csrf},body:JSON.stringify({revision:model.review.revision})});
  assert.equal(response.status,400);assert.match((await response.json()).message,/검색 목록 추가가 필요/);
  assert.equal(model.discoveryStatus.actionRequired,'expand_search_plan');assert.match(model.discoveryStatus.message,/검색 목록 추가가 필요/);
  assert.equal((await readJSON(path.join(root,'.artifacts/familiar-source-cache.json'))).runs.length,0);
});

test('공식 품명 소화기는 약품과 구분하고 동일 중량만 비교하며 저장 자료로 새 후보를 적재',async t=>{
  const root=await fixture(t),checkedAt=new Date().toISOString(),topic=plan.topics.find(t=>t.id==='F062');
  const make=(id,maker,spec,price)=>({...row(id,'수동식소화기',spec),prdctMakrNm:maker,prdctUnit:'개',cntrctPrceAmt:String(price)});
  const items=[make('86000001','A','3.3kg, ABC',25000),make('86000002','B','ABC3.30kg',26500),make('86000003','C','20kg, ABC',180000),row('86000004','기타의소화기관용약')];
  assert.equal(matchesFamiliarTopic(topic,items[0]),true);assert.equal(matchesFamiliarTopic(topic,items[3]),false);
  const comparison=buildProductComparison(topic,items.map(row=>({row,checkedAt,operation:'getThptyUcntrctPrdctInfoList'})));
  assert.equal(comparison.manufacturerCount,2);assert.equal(comparison.insufficient,true);assert.equal(comparison.medianPrice,null);
  assert.deepEqual(comparison.options.map(o=>o.productId),['86000001','86000002']);
  const queries=Object.fromEntries(familiarSearchPlan(plan).map(s=>[s.key,{items:[],totalCount:0,checkedAt,operation:s.operation}]));
  queries['getThptyUcntrctPrdctInfoList:소화기'].items=items;
  await writeJSON(path.join(root,'.artifacts/familiar-source-cache.json'),{queries,runs:[]});
  const {catalog,review}=await loadCatalog(root),status=await getDiscoveryStatus(root,catalog,review);
  assert.equal(status.remainingQueries,0);assert.equal(status.cachedNewTopics,1);assert.equal(status.canCollect,true);
  const before=await readFile(path.join(root,'dist/data.json'),'utf8');let calls=0;
  const client=api(()=>{calls++;throw Error('no new price request');});
  const result=await createFamiliarSourceOperations({maxRequests:0,apiFactory:()=>client}).collect(root);
  assert.equal(result.added,1);assert.equal(result.requests,0);assert.equal(calls,0);
  const after=await loadCatalog(root);assert.equal(after.review.decisions[result.ids[0]].status,'unreviewed');
  assert.deepEqual(after.review.decisions.C01,review.decisions.C01);assert.equal(await readFile(path.join(root,'dist/data.json'),'utf8'),before);
  assert.equal((await getDiscoveryStatus(root,after.catalog,after.review)).exhausted,true);
});

test('소진 뒤 추가한 물건 종류는 재시작 없이 새 검색으로 연결되고 기존 선택·게임을 유지',async t=>{
  const root=await fixture(t),checkedAt=new Date().toISOString();
  const oldPlan={...plan,topics:[plan.topics.find(t=>t.id==='F028')]};
  await writeJSON(path.join(root,'content/familiar-item-topics.json'),oldPlan);
  await writeJSON(path.join(root,'.artifacts/familiar-source-cache.json'),{queries:Object.fromEntries(familiarSearchPlan(oldPlan).map(s=>[s.key,{items:[],totalCount:0,checkedAt}])),runs:[]});
  const before=await loadCatalog(root),game=await readFile(path.join(root,'dist/data.json'),'utf8'),called=[];
  const client=api(term=>{called.push(term);return [row('87000001','자동개집표기','게이트, 1000×500×800mm')];});
  const server=createLocalServer({root,admin:true,sourceOperations:createFamiliarSourceOperations({maxRequests:1,apiFactory:()=>client})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`;
  const exhausted=await fetch(url+'/api/catalog').then(r=>r.json());assert.equal(exhausted.discoveryStatus.exhausted,true);
  await writeJSON(path.join(root,'content/familiar-item-topics.json'),{...oldPlan,topics:[...oldPlan.topics,plan.topics.find(t=>t.id==='F107')]});
  const expanded=await fetch(url+'/api/catalog').then(r=>r.json());assert.equal(expanded.discoveryStatus.totalTopics,2);
  assert.equal(expanded.discoveryStatus.exhausted,false);assert.equal(expanded.discoveryStatus.actionRequired,null);assert.ok(expanded.discoveryStatus.remainingQueries>=3);
  const response=await fetch(url+'/api/collect',{method:'POST',headers:{'Content-Type':'application/json','X-Curation-Token':expanded.csrf},body:JSON.stringify({revision:expanded.review.revision})});
  assert.equal(response.status,202);let job=await response.json();
  for(let i=0;job.status==='running'&&i<100;i++){await new Promise(resolve=>setTimeout(resolve,10));job=await fetch(url+'/api/jobs/'+job.id).then(r=>r.json());}
  assert.equal(job.status,'complete');assert.equal(job.result.added,1);assert.deepEqual(called,['자동개집표기']);
  const after=await loadCatalog(root);assert.deepEqual(after.review.decisions.C01,before.review.decisions.C01);
  assert.equal(after.review.decisions[job.result.ids[0]].status,'unreviewed');assert.equal(await readFile(path.join(root,'dist/data.json'),'utf8'),game);
});

test('기본 수집은 10회에서 끊기지 않고 20종을 찾으면 30회 상한 전에 멈춤',async t=>{
  const root=await fixture(t),game=await readFile(path.join(root,'dist/data.json'),'utf8');
  const topics=Array.from({length:25},(_,i)=>({id:'X'+i,group:'public',name:'검증 물건 '+i,keywords:['검증물건'+i],families:['검증물건'+i],hook:'검증용',scope:'1대'}));
  await writeJSON(path.join(root,'content/familiar-item-topics.json'),{...plan,topics});
  let calls=0;const client=api(term=>{calls++;return [row(String(88000000+calls),term)];});
  const result=await createFamiliarSourceOperations({apiFactory:()=>client}).collect(root);
  assert.equal(result.added,20);assert.equal(calls,20);assert.equal(result.requestLimit,30);assert.equal(result.stopReason,'target_reached');
  const after=await loadCatalog(root);assert.equal(after.review.decisions.C01.note,'유지');
  assert.ok(result.ids.every(id=>after.review.decisions[id].status==='unreviewed'));
  assert.equal(await readFile(path.join(root,'dist/data.json'),'utf8'),game);
});

test('수집 모드의 목표·조회 상한이 HTTP 작업에 전달되고 원시 숫자로 상한을 우회할 수 없음',async t=>{
  for(const preset of COLLECTION_PRESETS)await t.test(preset.id,async t=>{
    const root=await fixture(t);let calls=0;
    const server=createLocalServer({root,admin:true,sourceOperations:createFamiliarSourceOperations({apiFactory:()=>api(()=>{calls++;return [];})})});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
    const url=`http://127.0.0.1:${server.address().port}`,model=await fetch(url+'/api/catalog').then(r=>r.json());
    assert.deepEqual(model.collectionPresets,COLLECTION_PRESETS);
    const headers={'Content-Type':'application/json','X-Curation-Token':model.csrf};
    const invalid=await fetch(url+'/api/collect',{method:'POST',headers,body:JSON.stringify({revision:model.review.revision,collectionPreset:'unlimited'})});
    assert.equal(invalid.status,400);assert.equal(calls,0);
    const response=await fetch(url+'/api/collect',{method:'POST',headers,body:JSON.stringify({revision:model.review.revision,collectionPreset:preset.id,maxRequests:9999,target:9999})});
    assert.equal(response.status,202);let job=await response.json();
    for(let i=0;job.status==='running'&&i<300;i++){await new Promise(resolve=>setTimeout(resolve,10));job=await fetch(url+'/api/jobs/'+job.id).then(r=>r.json());}
    assert.equal(job.status,'complete');assert.equal(job.collection.id,preset.id);
    assert.equal(job.result.requests,preset.maxRequests);assert.equal(calls,preset.maxRequests);
    assert.equal(job.result.requestLimit,preset.maxRequests);assert.equal(job.result.target,preset.target);assert.equal(job.result.stopReason,'request_limit');
  });
});

test('수집당 50회보다 큰 한도는 API를 호출하기 전에 거부',async()=>{
  assert.throws(()=>createFamiliarSourceOperations({maxRequests:51}),/최대 50회/);
  const ops=createFamiliarSourceOperations({apiFactory:()=>{throw Error('must not call API');}});
  await assert.rejects(ops.collect('.',()=>{},20,{maxRequests:51}),/최대 50회/);
});

test('MAS 기본 품명 조회가 0건이면 추측 별칭보다 다른 주요 계약 유형을 먼저 확인',()=>{
  const topic=plan.topics.find(t=>t.id==='F107'),smallPlan={...plan,topics:[topic]};
  const key='getMASCntrctPrdctInfoList:'+topic.keywords[0];
  const cache={queries:{[key]:{items:[],totalCount:0,checkedAt:new Date().toISOString()}},runs:[]};
  const {jobs}=pendingDiscoveryJobs(smallPlan,cache,new Set());
  assert.equal(jobs[0].operation,'getThptyUcntrctPrdctInfoList');assert.equal(jobs[0].term,topic.keywords[0]);
  assert.ok(jobs.findIndex(j=>j.operation==='getMASCntrctPrdctInfoList')>0);
});
