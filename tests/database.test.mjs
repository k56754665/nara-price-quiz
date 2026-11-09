import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createSession, scoreGuess } from '../dist/engine.js';
import { buildSubmission } from '../dist/leaderboard.js';
const read = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
const bank = await read('../dist/data.json');
const legacy = await read('../dist/legacy-data.json');
const original = await readFile(new URL('../supabase/leaderboard.sql', import.meta.url), 'utf8');
const release = await readFile(new URL('../supabase/curated-release.sql', import.meta.url), 'utf8');

test('실제 PostgreSQL에서 기존 랭킹 보존·랜덤 채점·RLS·재실행 검증', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('create role anon; create role authenticated;');
  await db.exec(original);
  const call = async (name, body) => (await db.query(`select * from public.${name}($1,$2,$3::uuid,$4,$5::jsonb)`, [body.p_question_set,body.p_time_limit,body.p_client_id,body.p_nickname,JSON.stringify(body.p_attempts)])).rows[0];
  const oldInput = buildSubmission({questionSet:legacy.referenceDate,clientId:randomUUID(),nickname:'기존기록',rounds:legacy.questions.slice(0,3).map(q=>({attempts:[q.answer]}))});
  assert.equal((await call('submit_score',oldInput)).total_score,3000);
  await db.exec(release);
  await db.exec(release);
  const oldRows = (await db.query('select * from public.get_leaderboard($1,0,20)',[legacy.referenceDate])).rows;
  assert.equal(oldRows[0].nickname,'기존기록');
  assert.equal(oldRows[0].total_score,3000);
  const session=createSession(bank,3,true,()=>0);
  const input=buildSubmission({questionSet:bank.bankVersion,protocolVersion:2,clientId:randomUUID(),nickname:'랜덤검증',rounds:session.questions.map(q=>({candidateId:q.id,attempts:[q.answer+1,q.answer*2]}))});
  const expected=session.questions.reduce((sum,q)=>sum+scoreGuess(q.answer*2,q.answer),0);
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
