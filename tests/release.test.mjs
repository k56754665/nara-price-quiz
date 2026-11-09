import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ROUND_COUNT, sampleQuestions, createSession, restoreSession } from '../dist/engine.js';

const readJSON = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
const bank = await readJSON('../dist/data.json');
const legacy = await readJSON('../dist/legacy-data.json');

test('배포 문제은행과 SQL 정답표·이미지 출처 목록이 같은 버전과 항목을 사용', async () => {
  assert.ok(bank.questions.length >= 3);
  assert.equal(bank.rankingProtocol, 2);
  assert.equal(new Set(bank.questions.map(q => q.id)).size, bank.questions.length);
  const sql = await readFile(new URL('../supabase/curated-release.sql', import.meta.url), 'utf8');
  const rows = [...sql.matchAll(/\('([^']+)', '([^']+)', (\d+)\)/g)].map(m => ({ set:m[1], id:m[2], answer:Number(m[3]) }));
  assert.deepEqual(rows, bank.questions.map(q => ({ set:bank.bankVersion, id:q.id, answer:q.answer })));
  const fingerprint = createHash('md5').update([...rows].sort((a,b) => a.id.localeCompare(b.id)).map(q => `${q.id}:${q.answer}`).join(',')).digest('hex');
  assert.ok(sql.includes(`question_count = ${bank.questions.length} and answer_fingerprint = '${fingerprint}'`));
  const sources = await readJSON('../image-sources.json');
  assert.equal(sources.bank_version, bank.bankVersion);
  assert.deepEqual(sources.images.map(q => [q.candidate_id,q.src,q.sha256]), bank.questions.map(q => [q.id,q.image.src,q.image.sha256]));
});

test('현재 문제 전체와 이전 이어하기 이미지의 체크섬·출처를 보존', async () => {
  for (const q of [...bank.questions, ...legacy.questions]) {
    const bytes = await readFile(new URL('../dist/' + q.image.src, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), q.image.sha256, q.id);
    assert.match(q.image.sourceUrl, /^https:\/\/shop\.g2b\.go\.kr\//);
    assert.ok(q.productId && q.contractNumber && q.specification && q.unit && q.delivery && q.checkedAt);
    assert.ok(Number.isSafeInteger(q.answer) && q.answer > 0);
  }
});

test('전체 문제은행에서 10문제를 무작위로 중복 없이 출제하고 저장한 순서를 복구', () => {
  const original = structuredClone(bank.questions);
  assert.ok(bank.questions.length >= ROUND_COUNT);
  const first = sampleQuestions(bank.questions,ROUND_COUNT,()=>0);
  const second = sampleQuestions(bank.questions,ROUND_COUNT,()=>.999);
  assert.equal(first.length,ROUND_COUNT);
  assert.equal(new Set(first.map(q=>q.id)).size,ROUND_COUNT);
  assert.notDeepEqual(first.map(q=>q.id),second.map(q=>q.id));
  const session = createSession(bank,true,()=>0);
  assert.deepEqual(restoreSession(structuredClone(session)),session);
  assert.deepEqual(bank.questions,original);
});
