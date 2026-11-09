import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createSession, scoreRound, rankingSet } from '../dist/engine.js';
import { buildSubmission } from '../dist/leaderboard.js';
const read = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
const bank = await read('../dist/data.json');
const legacy = await read('../dist/legacy-data.json');
const original = await readFile(new URL('../supabase/leaderboard.sql', import.meta.url), 'utf8');
const release = await readFile(new URL('../supabase/curated-release.sql', import.meta.url), 'utf8');
const rulesV3 = await readFile(new URL('../supabase/rules-v3.sql', import.meta.url), 'utf8');
const rulesV4 = await readFile(new URL('../supabase/rules-v4.sql', import.meta.url), 'utf8');
// 예전 규칙(v2, 두 번 추측)의 점수식. 예전 함수가 계속 동작하는지 확인할 때만 씁니다.
const oldScore = (g, a) => g === a ? 1000 : Math.min(999, Math.round(1000 * Math.exp(-1.5 * Math.abs(Math.log(g / a)))));

test('실제 PostgreSQL에서 기존 랭킹 보존·랜덤 채점·RLS·재실행 검증', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('create role anon; create role authenticated;');
  await db.exec(original);
  const call = async (name, body) => (await db.query(`select * from public.${name}($1,$2,$3::uuid,$4,$5::jsonb)`, [body.p_question_set,body.p_time_limit,body.p_client_id,body.p_nickname,JSON.stringify(body.p_attempts)])).rows[0];
  const oldInput = buildSubmission({questionSet:legacy.referenceDate,clientId:randomUUID(),nickname:'기존기록',protocolVersion:1,rounds:legacy.questions.slice(0,3).map(q=>({attempts:[q.answer]}))});
  assert.equal((await call('submit_score',oldInput)).total_score,3000);
  await db.exec(release);
  await db.exec(release);
  const oldRows = (await db.query('select * from public.get_leaderboard($1,0,20)',[legacy.referenceDate])).rows;
  assert.equal(oldRows[0].nickname,'기존기록');
  assert.equal(oldRows[0].total_score,3000);
  const session={questions:bank.questions.slice(0,3)};
  const input=buildSubmission({questionSet:bank.bankVersion,protocolVersion:2,clientId:randomUUID(),nickname:'랜덤검증',rounds:session.questions.map(q=>({candidateId:q.id,attempts:[q.answer+1,q.answer*2]}))});
  const expected=session.questions.reduce((sum,q)=>sum+oldScore(q.answer*2,q.answer),0);
  const result=await call('submit_score_v2',input);
  assert.equal(result.total_score,expected); assert.equal(result.perfect_count,0); assert.equal(Number(result.rank),1);
  await assert.rejects(call('submit_score_v2',input),/already_submitted/);
  for (const corrupt of [
    a=>{a.p_attempts[1].question_id=a.p_attempts[0].question_id;},
    a=>{a.p_attempts[1].question_id='unknown';},
    a=>{a.p_attempts[1].attempts=[];},
    a=>{a.p_attempts[1].attempts=[null];},
    a=>{a.p_attempts[1].attempts=[1];},
    a=>{a.p_attempts[1].attempts=[-1,1];},
    a=>{a.p_attempts[1].attempts=[1.5,1];},
    a=>{a.p_attempts[1].attempts=[1000000000000,1];},
    a=>{a.p_attempts[1].attempts=[1,2,3];},
    a=>{a.p_attempts[1].question_id=null;},
    a=>{a.p_attempts[1].attempts=null;},
    a=>{a.p_attempts=null;},
  ]) {
    const bad=structuredClone(input); bad.p_client_id=randomUUID(); corrupt(bad);
    await assert.rejects(call('submit_score_v2',bad),/invalid_attempts/);
  }
  const perfect=buildSubmission({questionSet:bank.bankVersion,protocolVersion:2,clientId:randomUUID(),nickname:'만점검증',rounds:session.questions.map(q=>({candidateId:q.id,attempts:[q.answer]}))});
  assert.equal((await call('submit_score_v2',perfect)).total_score,3000);
  const rows=(await db.query('select * from public.get_leaderboard($1,0,20)',[bank.bankVersion])).rows;
  assert.equal(rows[0].nickname,'만점검증'); assert.equal(rows[0].question_count,3);
  await db.query('update public.quiz_answers_v2 set answer = answer + 1 where question_set=$1 and question_id=$2',[bank.bankVersion,bank.questions[0].id]);
  await assert.rejects(db.exec(release),/question bank mismatch/);
  await db.exec('rollback;');
  await db.query('update public.quiz_answers_v2 set answer = answer - 1 where question_set=$1 and question_id=$2',[bank.bankVersion,bank.questions[0].id]);
  // The pool is independent of the 50-round game limit.
  await db.exec("insert into public.quiz_answers_v2 select 'large-bank','Q'||n,1000 from generate_series(1,100) n;");
  assert.equal(Number((await db.query("select * from public.get_quiz_bank_status('large-bank')")).rows[0].question_count),100);
  await db.exec('set role anon;');
  await assert.rejects(db.query('select * from public.quiz_answers_v2'),/permission denied/);
  await assert.rejects(db.query('select * from public.leaderboard_scores'),/permission denied/);
  assert.equal(Number((await db.query('select * from public.get_quiz_bank_status($1)',[bank.bankVersion])).rows[0].question_count),bank.questions.length);
  const publicInput={...perfect,p_client_id:randomUUID(),p_nickname:'공개호출'};
  assert.equal((await call('submit_score_v2',publicInput)).total_score,3000);
});

test('새 규칙(v4): ±10% 안 정답, 3번 추측 회차별 점수, 10문제 고정, 잘못된 기록 거부', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('create role anon; create role authenticated;');
  await db.exec(original); await db.exec(release); await db.exec(rulesV3); await db.exec(rulesV4); await db.exec(rulesV4);
  const call = async body => (await db.query('select * from public.submit_score_v4($1,$2,$3::uuid,$4,$5::jsonb)', [body.p_question_set,body.p_time_limit,body.p_client_id,body.p_nickname,JSON.stringify(body.p_attempts)])).rows[0];
  const session = createSession(bank, true, () => 0);
  // 1번째·2번째·3번째 성공, 실패를 섞어 봅니다. 9%·10% 경계도 포함합니다.
  const plans = [a=>[a], a=>[1,Math.round(a*1.1)], a=>[1,2,Math.round(a*0.91)], a=>[1,2,3], a=>[a]];
  const rounds = session.questions.map((q,i) => { const attempts = plans[i % plans.length](q.answer); return { candidateId:q.id, attempts, score:scoreRound(attempts,q.answer) }; });
  const input = buildSubmission({ questionSet:bank.bankVersion, clientId:randomUUID(), nickname:'새규칙', rounds });
  const expected = rounds.reduce((sum,r)=>sum+r.score,0);
  assert.equal(expected, 2*(1000+800+500+0+1000));
  const result = await call(input);
  assert.equal(result.total_score, expected); assert.equal(result.perfect_count, 8); assert.equal(Number(result.rank), 1);
  // 같은 기기는 다시 등록할 수 있고, 최고 점수 하나만 남습니다.
  const again = await call(input);
  assert.equal(again.total_score, expected);
  const worse = structuredClone(input); worse.p_nickname = '낮은점수';
  worse.p_attempts = session.questions.map(q => ({ question_id:q.id, attempts:[1,2,3] }));
  assert.equal((await call(worse)).total_score, expected);
  const better = structuredClone(input); better.p_nickname = '갱신';
  better.p_attempts = session.questions.map((q,i) => ({ question_id:q.id, attempts: i ? [q.answer] : [1,q.answer] }));
  const improved = await call(better);
  assert.equal(improved.total_score, 9800); assert.equal(improved.perfect_count, 10); assert.equal(Number(improved.rank), 1);
  const stored = (await db.query("select nickname, total_score from public.leaderboard_scores where client_id = $1", [input.p_client_id])).rows;
  assert.deepEqual(stored, [{ nickname:'갱신', total_score:9800 }]);
  for (const corrupt of [
    a=>{a.p_attempts.pop();},
    a=>{a.p_attempts[1].question_id=a.p_attempts[0].question_id;},
    a=>{a.p_attempts[1].question_id='unknown';},
    a=>{a.p_attempts[0].attempts=[];},
    a=>{a.p_attempts[0].attempts=[1];},
    a=>{a.p_attempts[0].attempts=[1,2];},
    a=>{a.p_attempts[0].attempts=[1,2,3,4];},
    a=>{a.p_attempts[0].attempts=[session.questions[0].answer,session.questions[0].answer];},
    a=>{a.p_attempts[0].attempts=[null];},
    a=>{a.p_attempts[0].attempts=[1.5,2,3];},
    a=>{a.p_attempts=null;},
  ]) {
    const bad=structuredClone(input); bad.p_client_id=randomUUID(); corrupt(bad);
    await assert.rejects(call(bad), /invalid_attempts/);
  }
  const perfect = buildSubmission({ questionSet:bank.bankVersion, clientId:randomUUID(), nickname:'만점', rounds:session.questions.map(q=>({candidateId:q.id,attempts:[q.answer]})) });
  assert.equal((await call(perfect)).total_score, 10000);
  const rows = (await db.query('select * from public.get_leaderboard($1,0,20)', [rankingSet(bank.bankVersion)])).rows;
  assert.deepEqual(rows.map(r=>[r.nickname,r.total_score]), [['만점',10000],['갱신',9800]]);
  // 새 규칙 기록은 예전 규칙 랭킹과 섞이지 않습니다.
  assert.equal((await db.query('select * from public.get_leaderboard($1,0,20)', [bank.bankVersion])).rows.length, 0);
  await db.exec('set role anon;');
  assert.equal((await db.query('select public.get_ranking_protocol() as v')).rows[0].v, 4);
  assert.equal((await call({...perfect,p_client_id:randomUUID(),p_nickname:'공개호출'})).total_score, 10000);
});
