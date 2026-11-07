import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isConfigured, normalizeNickname, buildSubmission, submitScore, fetchLeaderboard, errorMessage } from '../dist/leaderboard.js';
import { LEADERBOARD_CONFIG } from '../dist/leaderboard-config.js';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const sql = await readFile(new URL('../supabase/leaderboard.sql', import.meta.url), 'utf8');
const config = { url: 'https://example.supabase.co/', anonKey: 'anon-key-0123456789abcdef' };

test('랭킹 SQL의 정답·문제 순서가 data.json과 같음', () => {
  const rows = [...sql.matchAll(/\('([\d-]+)', (\d+), '(C\d+)', (\d+)\)/g)].map(m => ({ set: m[1], position: Number(m[2]), id: m[3], answer: Number(m[4]) }));
  assert.equal(rows.length, data.questions.length);
  rows.forEach((row, i) => {
    assert.equal(row.set, data.referenceDate);
    assert.equal(row.position, i + 1);
    assert.equal(row.id, data.questions[i].id);
    assert.equal(row.answer, data.questions[i].answer);
  });
});

test('랭킹 설정은 비어 있으면 꺼지고 service_role 키를 담지 않음', () => {
  assert.equal(isConfigured({ url: '', anonKey: '' }), false);
  assert.equal(isConfigured(config), true);
  const key = LEADERBOARD_CONFIG.anonKey;
  if (key) {
    const payload = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString() || '{}');
    assert.notEqual(payload.role, 'service_role');
  }
});

test('닉네임은 공백을 정리하고 길이·위험 문자를 검사', () => {
  assert.equal(normalizeNickname('  가격   탐정 '), '가격 탐정');
  assert.equal(normalizeNickname('가'.repeat(12)), '가'.repeat(12));
  for (const bad of ['', '   ', '가'.repeat(13), '<b>', 'a\u0007b', null]) assert.equal(normalizeNickname(bad), null);
});

test('제출 데이터에는 점수 대신 라운드별 추측만 담김', () => {
  const rounds = data.questions.map(q => ({ candidateId: q.id, attempts: [q.answer], score: 1000 }));
  const body = buildSubmission({ questionSet: data.referenceDate, timeLimit: 45, clientId: 'id', nickname: '닉', rounds });
  assert.deepEqual(body.p_attempts, data.questions.map(q => [q.answer]));
  assert.equal(body.p_time_limit, 45);
  assert.equal('p_total_score' in body, false);
});

test('Supabase RPC 호출 형식과 오류 메시지 변환', async () => {
  const calls = [];
  const ok = (rows) => async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => rows }; };
  const result = await submitScore(config, { p_nickname: '닉' }, ok([{ rank: 3, total_score: 8120, perfect_count: 2 }]));
  assert.deepEqual(result, { rank: 3, totalScore: 8120, perfectCount: 2 });
  assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/rpc/submit_score');
  assert.equal(calls[0].init.headers.apikey, config.anonKey);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${config.anonKey}`);

  const rows = await fetchLeaderboard(config, { questionSet: '2026-11-03', timeLimit: 0 }, ok([{ rank: 1, nickname: 'A', total_score: 9000, perfect_count: 5 }]));
  assert.deepEqual(rows, [{ rank: 1, nickname: 'A', totalScore: 9000, perfectCount: 5 }]);

  const fail = async () => ({ ok: false, json: async () => ({ code: 'P0001', message: 'already_submitted' }) });
  await assert.rejects(submitScore(config, {}, fail), { code: 'already_submitted', message: errorMessage('already_submitted') });
  await assert.rejects(fetchLeaderboard(config, {}, async () => { throw new TypeError('offline'); }), { code: 'network' });
});
