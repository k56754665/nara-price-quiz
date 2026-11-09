import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, restoreSession, isValidSession, sampleQuestions, scoreGuess } from '../dist/engine.js';
import { buildSubmission, submitScore } from '../dist/leaderboard.js';
import { buildShareText, scoreBlocks } from '../dist/share.js';
import { projectRoot, loadCatalog, buildBank, updateDecision, publishBank, writeJSON, digest, answerSeed } from '../scripts/curation.mjs';
import { createLocalServer, calculatePreviewScore } from '../scripts/local-server.mjs';
const { catalog, review, bank } = await loadCatalog();
const legacy = JSON.parse(await readFile(new URL('../dist/legacy-data.json', import.meta.url)));
const baseReview = { schemaVersion:1, revision:0, decisions:Object.fromEntries(catalog.candidates.map(c=>[c.id,{status:legacy.questions.some(q=>q.id===c.id)?'approved':'held',note:''}])) };

test('승인 목록과 배포 데이터·SQL이 일치하고, 전체 후보 이미지가 로컬에 존재', async () => {
  assert.ok(catalog.candidates.length >= 30);
  // Human selections are staged until Apply; they need not match an older
  // playable release. Validate both the staged selection and published SQL.
  const staged=buildBank(catalog,review);
  assert.equal(staged.questions.length,Object.values(review.decisions).filter(d=>d.status==='approved').length);
  assert.equal(staged.questions.some(q=>review.decisions[q.id].status!=='approved'),false);
  assert.equal(bank.questions.some(q => review.decisions[q.id]?.status === 'unreviewed'), false);
  const sql = await readFile(new URL('../supabase/curated-release.sql', import.meta.url), 'utf8');
  assert.ok(sql.includes(answerSeed(bank)));
  const images = JSON.parse(await readFile(new URL('../image-sources.json', import.meta.url), 'utf8'));
  assert.equal(images.bank_version, bank.bankVersion);
  assert.deepEqual(images.images.map(image => [image.candidate_id, image.sha256]), bank.questions.map(q => [q.id, q.image.sha256]));
  for (const c of catalog.candidates) {
    const bytes = await readFile(path.join(projectRoot, 'content/images', path.basename(c.image.src)));
    assert.equal(digest(bytes), c.image.sha256);
    assert.ok(!JSON.stringify(c).includes('serviceKey'));
  }
  for (const q of bank.questions) {
    assert.equal(digest(await readFile(path.join(projectRoot, 'dist', q.image.src))), q.image.sha256);
    assert.ok(q.revealNote && q.contractNumber && q.productId);
    if (q.triviaId) assert.ok(bank.trivia.some(t => t.id === q.triviaId));
  }
});

test('승인만 출제하고, 잘못된 가격 기준·3개 미만·동시 편집을 차단', () => {
  const review = baseReview, bank = buildBank(catalog, review);
  const next = updateDecision(review, catalog, { id: 'C02', status: 'approved', note: '흥미로움', revision: review.revision });
  assert.equal(next.decisions.C02.status, 'approved');
  assert.equal(review.decisions.C02.status, 'held');
  assert.ok(buildBank(catalog, next).questions.some(q => q.id === 'C02'));
  assert.notEqual(buildBank(catalog, next).bankVersion, bank.bankVersion);
  assert.throws(() => updateDecision(next, catalog, { id: 'C02', status: 'held', revision: review.revision }), /새로고침/);
  const invalid = structuredClone(review);
  for (const record of Object.values(invalid.decisions)) record.status = 'held';
  assert.throws(() => buildBank(catalog, invalid), /최소 3개/);
  invalid.decisions.C11.status = 'approved';
  invalid.decisions.C16.status = invalid.decisions.C01.status = 'approved';
  // Current API records may legitimately remove expired discount information.
  // Keep this price-basis regression independent of mutable live catalog fields.
  const discountedCatalog=structuredClone(catalog);
  for(const id of ['C11','C16'])Object.assign(discountedCatalog.candidates.find(c=>c.id===id),{eligible:false,pricePolicy:{basis:'registered_contract_unit_price',contractPriceVerified:true,notice:'할인 정보는 정답 계산에 반영하지 않습니다.'}});
  const withDiscounts = buildBank(discountedCatalog, invalid);
  for(const id of ['C11','C16'])assert.equal(withDiscounts.questions.find(q=>q.id===id).answer,discountedCatalog.candidates.find(q=>q.id===id).answer);
  assert.ok(withDiscounts.questions.filter(q=>['C11','C16'].includes(q.id)).every(q=>q.pricePolicy.notice.includes('할인 정보')));
  const unverified = structuredClone(discountedCatalog);
  delete unverified.candidates.find(c=>c.id==='C11').pricePolicy;
  assert.throws(() => buildBank(unverified, invalid), /출제 기준/);
});

test('무작위 추출은 원본을 보존하고 중복 없이 선택하며, 문제은행 50개 초과도 지원', () => {
  const original = structuredClone(bank.questions);
  const a = sampleQuestions(bank.questions, 3, () => 0);
  const b = sampleQuestions(bank.questions, 3, () => .999);
  assert.notDeepEqual(a.map(q => q.id), b.map(q => q.id));
  assert.equal(new Set(a.map(q => q.id)).size, 3);
  assert.deepEqual(original, bank.questions);
  const pool = Array.from({ length: 100 }, (_, i) => ({ id: `Q${i}` }));
  assert.equal(sampleQuestions(pool, 50, () => .5).length, 50);
  assert.equal(sampleQuestions(bank.questions, Math.min(50, bank.questions.length)).length, Math.min(50, bank.questions.length));
  assert.throws(() => sampleQuestions(bank.questions, bank.questions.length + 1), /invalid/);
});

test('랜덤 세션은 문제은행 갱신 후에도 순서·첫 추측·힌트·정답을 그대로 복구', () => {
  const session = createSession(bank, 3, true, () => 0);
  const q = session.questions[0];
  session.attempts = [q.answer + 1]; session.draft = '1,000';
  const restored = restoreSession(JSON.parse(JSON.stringify(session)));
  assert.deepEqual(restored, session);
  assert.equal(isValidSession(restored, restored.questions), true);
  assert.equal(restoreSession({ ...session, questionIds: [q.id, q.id, q.id] }), null);
  const changed = structuredClone(bank); changed.questions.reverse(); changed.questions[0].answer++;
  assert.deepEqual(restoreSession(session).questionIds, session.questionIds);
  assert.equal(restoreSession(session).questions[0].answer, q.answer);
});

test('예전 v2·v3 이어하기와 순서 기반 랭킹 제출을 보존', () => {
  for (const version of [2,3]) {
    const old = { version, timeLimit: 0, phase: 'question', index: 0, attempts: [1], rounds: [], draft: '', questionCount: 10, rankEligible: true };
    const restored = restoreSession(old, legacy);
    assert.equal(restored.version, 4); assert.equal(restored.protocolVersion, 1);
    assert.deepEqual(restored.questionIds, legacy.questions.map(q => q.id));
    assert.equal(restored.questionSet, '2026-11-03');
  }
  assert.equal(restoreSession({ version: 2, timeLimit: 45 }, legacy), null);
});

test('랜덤 라운드는 ID로 서버 채점하고 중복·미승인 ID·위조 점수를 거부', async () => {
  const session = createSession(bank, 3, true, () => 0);
  const rounds = session.questions.map(q => ({ candidateId: q.id, attempts: [q.answer + 1, q.answer], score: -999 }));
  const input = buildSubmission({ questionSet: bank.bankVersion, protocolVersion: 2, clientId: randomUUID(), nickname: '시험', rounds });
  assert.equal(calculatePreviewScore(bank, input).total_score, 3000);
  const forged = structuredClone(input); forged.p_attempts[1].question_id = forged.p_attempts[0].question_id;
  assert.throws(() => calculatePreviewScore(bank, forged), /invalid_attempts/);
  forged.p_attempts[1].question_id = 'unknown';
  assert.throws(() => calculatePreviewScore(bank, forged), /invalid_attempts/);
  let called;
  await submitScore({ url:'https://example.supabase.co', anonKey:'public-test-key' }, input, async url => { called = url; return { ok:true, json:async()=>[{rank:1,total_score:3000,perfect_count:3}] }; });
  assert.match(called, /submit_score_v2$/);
  const result = {total:3000,maxScore:3000,title:'시험',rounds:rounds.map(r=>({...r,score:1000})),best:3000};
  assert.match(buildShareText(result,false), /3문제 · 3,000 \/ 3,000점/);
  assert.equal(scoreBlocks(result.rounds), '🟩🟩🟩');
});

test('로컬 HTTP에서 선택 저장→승인 반영→독립 랭킹까지 연결하고 운영 설정·관리 파일을 보호', async t => {
  const review = baseReview, bank = buildBank(catalog, review);
  const root = await mkdtemp(path.join(os.tmpdir(), 'nara-curation-'));
  t.after(() => { if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nara-curation-'))throw Error('Unsafe temporary path');return rm(root, { recursive:true, force:true }); });
  for (const dir of ['content','dist','supabase','tools']) await cp(path.join(projectRoot,dir),path.join(root,dir),{recursive:true});
  await writeJSON(path.join(root,'content/review.json'),review);
  await publishBank(root);
  const server = createLocalServer({root,admin:true,sourceOperations:{apply:async()=>publishBank(root)}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async url => { const response=await fetch(origin+url); assert.equal(response.status,200); return response; };
  const initial = await (await get('/api/catalog')).json();
  const post = (url,body,extra={}) => fetch(origin+url,{method:'POST',headers:{'Content-Type':'application/json','X-Curation-Token':initial.csrf,...extra},body:JSON.stringify(body)});
  const config = await (await get('/leaderboard-config.js?v=abc')).text();
  assert.match(config,/location.origin/); assert.ok(!config.includes('supabase.co'));
  assert.equal((await (await get('/data.json')).json()).bankVersion,bank.bankVersion);
  assert.equal((await post('/api/review',{id:'C02',status:'approved',revision:review.revision},{'X-Curation-Token':'bad'})).status,403);
  assert.equal((await post('/api/review',{id:'C02',status:'approved',revision:review.revision},{Origin:'https://elsewhere.test'})).status,403);
  const updated = await (await post('/api/review',{id:'C02',status:'approved',revision:review.revision})).json();
  const appliedResponse = await post('/api/apply',{revision:updated.revision}); assert.equal(appliedResponse.status,202);
  let job=await appliedResponse.json();
  while(job.status==='running'){await new Promise(resolve=>setTimeout(resolve,10));job=await (await get('/api/jobs/'+job.id)).json();}
  assert.equal(job.status,'complete',job.error);
  const applied = job.result; assert.ok(applied.ids.includes('C02'));
  const nextBank = await (await get('/data.json')).json();
  assert.equal(nextBank.questions.length,bank.questions.length+1);
  const session = createSession(nextBank,3,true,()=>0);
  const input = buildSubmission({questionSet:nextBank.bankVersion,protocolVersion:2,clientId:randomUUID(),nickname:'로컬검사',rounds:session.questions.map(q=>({candidateId:q.id,attempts:[q.answer]}))});
  const score = await (await post('/rest/v1/rpc/submit_score_v2',input)).json(); assert.equal(score[0].total_score,3000);
  assert.equal((await post('/rest/v1/rpc/submit_score_v2',input)).status,400);
  const rows=await (await post('/rest/v1/rpc/get_leaderboard',{p_question_set:nextBank.bankVersion,p_limit:20})).json();
  assert.equal(rows[0].nickname,'로컬검사'); assert.equal(rows[0].question_count,3);
  assert.equal((await fetch(origin+'/content/review.json')).status,404);
  assert.equal((await fetch(origin+'/.env.local')).status,404);
});
