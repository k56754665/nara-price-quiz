import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ROUND_COUNT, createSession, restoreSession, isValidSession, isValidTriviaPool, rankingSet } from '../dist/engine.js';
import { buildSubmission } from '../dist/leaderboard.js';

const read = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
const bank = await read('../dist/data.json');
const pool = await read('../dist/trivia.json');
const random = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const fresh = (triviaPool = pool, seed = 1) => createSession(bank, triviaPool, true, random(seed));
const serialized = value => JSON.parse(JSON.stringify(value));

test('공통 지식은 10개 이상이며 특정 물건 설명을 제외하고 기준 시점·공식 출처를 보존', () => {
  assert.equal(isValidTriviaPool(pool), true);
  assert.equal(pool.cards.some(card => ['T01', 'T07'].includes(card.id)), false);
  assert.ok(pool.cards.some(card => card.id === 'T10' && card.period.includes('2024')));
  for (const card of pool.cards) {
    for (const source of card.sources) assert.ok(['www.pps.go.kr', 'www.korea.kr', 'www.data.go.kr'].includes(new URL(source.url).hostname));
  }
});

test('모든 물건의 기존 연결이 없어도 매 게임 10개의 서로 다른 지식을 배정', () => {
  const independentBank = { ...bank, trivia: [], questions: bank.questions.map(q => ({ ...q, triviaId: null })) };
  const original = serialized(pool);
  const orders = new Set();
  for (let seed = 1; seed <= 100; seed++) {
    const session = createSession(independentBank, pool, true, random(seed));
    assert.equal(session.triviaRounds.length, ROUND_COUNT);
    assert.equal(new Set(session.triviaRounds.map(card => card.id)).size, ROUND_COUNT);
    assert.equal(new Set(session.triviaRounds.map(card => card.text)).size, ROUND_COUNT);
    assert.equal(isValidSession(session, session.questions), true);
    orders.add(session.triviaRounds.map(card => card.id).join(','));
  }
  assert.ok(orders.size > 1);
  assert.deepEqual(pool, original);
});

test('10개보다 큰 지식 풀에서도 10개만 추첨하고 원본 내용과 순서를 보존', () => {
  const expanded = serialized(pool);
  expanded.cards.push(...Array.from({ length: 5 }, (_, i) => ({ ...serialized(pool.cards[0]), id: `test-${i}`, text: `추첨 검사용 지식 ${i}` })));
  const original = serialized(expanded);
  const selections = new Set();
  for (let seed = 1; seed <= 20; seed++) {
    const session = fresh(expanded, seed);
    assert.equal(session.triviaRounds.length, ROUND_COUNT);
    selections.add(session.triviaRounds.map(card => card.id).sort().join(','));
  }
  assert.ok(selections.size > 1);
  assert.deepEqual(expanded, original);
});

test('직렬화·새로고침·이어하기는 재추첨 없이 지식 순서·본문·출처를 복구', () => {
  const session = fresh();
  session.attempts = [1]; session.draft = '1,000';
  const saved = serialized(session);
  const changedPool = serialized(pool);
  changedPool.version = 'next-version';
  changedPool.cards.reverse();
  for (const card of changedPool.cards) card.text += ' 수정된 내용';
  const noRandom = () => { throw Error('이어하기에서는 재추첨하면 안 됩니다.'); };
  assert.deepEqual(restoreSession(saved, changedPool, noRandom), session);
  assert.deepEqual(restoreSession(saved, undefined, noRandom), session);
  changedPool.cards[0].sources[0].title = '변경된 출처';
  assert.deepEqual(saved.triviaRounds, session.triviaRounds);
  assert.equal(fresh(changedPool).triviaVersion, changedPool.version);
  assert.notDeepEqual(fresh(changedPool).triviaRounds, session.triviaRounds);
});

test('새 게임의 지식 스냅샷은 원본 풀 수정의 영향을 받지 않음', () => {
  const editable = serialized(pool);
  const session = fresh(editable);
  const snapshot = serialized(session.triviaRounds);
  editable.cards[0].text = '수정';
  editable.cards[0].sources[0].title = '수정';
  editable.cards.reverse();
  assert.deepEqual(session.triviaRounds, snapshot);
});

test('v5의 문제 풀이·정답 공개·최종 결과를 진행·점수 손실 없이 한 번만 이관', () => {
  for (const phase of ['question', 'reveal', 'results']) {
    const { triviaVersion, triviaRounds, ...session } = fresh();
    const completed = phase === 'results' ? ROUND_COUNT : 3;
    const old = { ...session, version: 5, trivia: serialized(bank.trivia), phase,
      index: phase === 'question' ? completed : completed - 1,
      attempts: phase === 'question' ? [1] : [],
      draft: phase === 'question' ? '1,000' : '',
      rounds: session.questions.slice(0, completed).map(q => ({ candidateId: q.id, attempts: [q.answer], score: 1000 })) };
    const before = serialized(old);
    const migrated = restoreSession(old, pool, random(8));
    assert.equal(migrated.version, 6);
    assert.equal(isValidSession(migrated, migrated.questions), true);
    for (const key of Object.keys(old).filter(key => !['version', 'trivia'].includes(key))) assert.deepEqual(migrated[key], old[key], key);
    assert.deepEqual(old, before);
    assert.deepEqual(restoreSession(serialized(migrated), pool, () => { throw Error('두 번째 추첨'); }), migrated);
  }
});

test('개수 부족·중복 ID/본문·출처 누락 지식 풀은 게임 시작 전에 거부', () => {
  const corruptions = [
    value => { value.cards.pop(); },
    value => { value.cards[1].id = value.cards[0].id; },
    value => { value.cards[1].text = `  ${value.cards[0].text}  `; },
    value => { value.cards[0].period = ''; },
    value => { value.cards[0].sources = []; },
    value => { value.cards[0].sources[0].url = 'javascript:alert(1)'; },
    value => { value.cards[0] = null; },
    value => { value.version = ''; },
  ];
  for (const corrupt of corruptions) {
    const invalid = serialized(pool); corrupt(invalid);
    assert.equal(isValidTriviaPool(invalid), false);
    assert.throws(() => fresh(invalid), /invalid trivia pool/);
  }
});

test('배정된 지식의 중복·누락·잘못된 출처를 저장 기록에서도 거부', () => {
  const corruptions = [
    value => { value.triviaRounds.pop(); },
    value => { value.triviaRounds[1] = serialized(value.triviaRounds[0]); },
    value => { value.triviaRounds[0].sources[0].url = 'http://example.com'; },
    value => { delete value.triviaVersion; },
  ];
  for (const corrupt of corruptions) {
    const invalid = fresh(); corrupt(invalid);
    assert.equal(isValidSession(invalid, invalid.questions), false);
    assert.equal(restoreSession(invalid, pool), null);
  }
  const invalidOld = { ...fresh(), version: 5, trivia: [], rounds: [{}] };
  assert.equal(restoreSession(invalidOld, pool), null);
});

test('지식 풀 변경은 문제 출제·정답표 버전·랭킹 제출 형식에 영향을 주지 않음', () => {
  const changedPool = serialized(pool); changedPool.version = 'next-version'; changedPool.cards.reverse();
  const before = fresh(); const after = fresh(changedPool);
  assert.deepEqual(before.questions, after.questions);
  assert.equal(after.questionSet, bank.bankVersion);
  assert.equal(after.rankingSet, rankingSet(bank.bankVersion));
  const submit = session => buildSubmission({ questionSet: session.questionSet, clientId: 'test', nickname: '검증',
    rounds: session.questions.map(q => ({ candidateId: q.id, attempts: [q.answer] })) });
  assert.deepEqual(submit(before), submit(after));
  assert.equal('trivia' in submit(after), false);
});
