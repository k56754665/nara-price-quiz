import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { QUESTION_COUNTS, parseGuess, scoreGuess, relativeError, koreanAmount, totalScore, grade, guessHint, isValidSession } from '../dist/engine.js';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const question = data.questions[0];
const initial = () => ({ version: 3, phase: 'question', index: 0, attempts: [], rounds: [], questionCount: 10, draft: '' });

test('가격 입력은 쉼표·공백을 처리하고 0원·음수·문자·범위 밖 금액을 거부', () => {
  assert.equal(parseGuess(' 425,000 '), 425000);
  assert.equal(parseGuess('951 500 000'), 951500000);
  for (const value of ['', ' ', '0', '-100', '1.5', '100만원', 'Infinity', '1000000000000']) assert.equal(parseGuess(value), null);
});

test('정답만 1000점, 1원 차이는 만점이 아니며 배율 점수는 대칭', () => {
  assert.equal(scoreGuess(425000, 425000), 1000);
  assert.equal(scoreGuess(424999, 425000), 999);
  assert.equal(scoreGuess(850000, 425000), 354);
  assert.equal(scoreGuess(212500, 425000), 354);
  assert.equal(scoreGuess(null, 425000), 0);
  assert.ok(scoreGuess(400000, 425000) > scoreGuess(300000, 425000));
  assert.equal(relativeError(850000, 425000), 100);
});

test('힌트는 올려야 하면 UP, 내려야 하면 DOWN이며 숫자 정답·오차율을 노출하지 않음', () => {
  assert.deepEqual(guessHint(400000, 425000), { direction: 'UP', label: '아주 조금 낮아요', instruction: '가격을 아주 조금 더 올려 보세요.' });
  assert.equal(guessHint(450000, 425000).direction, 'DOWN');
  assert.equal(guessHint(1000000, 425000).label, '많이 높아요');
  assert.equal(guessHint(1000, 425000).label, '아주 많이 낮아요');
  assert.equal(guessHint(425000, 425000), null);
  assert.equal(guessHint(null, 425000), null);
  assert.equal(/[0-9%]/.test(JSON.stringify(guessHint(300000, 425000))), false);
});

test('거리 형용사는 비싸게·싸게 추측한 배율을 같은 기준으로 평가', () => {
  for (const factor of [1.05, 1.2, 1.6, 3, 10]) {
    const low = guessHint(100000 / factor, 100000).label.replace('낮아요', '');
    const high = guessHint(100000 * factor, 100000).label.replace('높아요', '');
    assert.equal(low, high);
  }
});

test('첫 오답은 결과를 확정하지 않은 재도전 상태로 저장·복구', () => {
  assert.equal(isValidSession(initial(), data.questions), true);
  assert.equal(isValidSession({ ...initial(), attempts: [300000], draft: '400,000' }, data.questions), true);
  assert.equal(isValidSession({ ...initial(), attempts: [question.answer] }, data.questions), false);
  assert.equal(isValidSession({ ...initial(), version: 1, players: ['A', 'B'] }, data.questions), false);
});

test('첫 정답은 1회에 확정하고, 재도전은 마지막 추측으로 점수를 반영', () => {
  const one = { ...initial(), phase: 'reveal', rounds: [{ candidateId: question.id, attempts: [425000], score: 1000 }] };
  assert.equal(isValidSession(one, data.questions), true);
  const retry = { ...initial(), phase: 'reveal', rounds: [{ candidateId: question.id, attempts: [400000, 850000], score: 354 }] };
  assert.equal(isValidSession(retry, data.questions), true);
  assert.equal(isValidSession({ ...retry, rounds: [{ ...retry.rounds[0], score: scoreGuess(400000, 425000) }] }, data.questions), false);
  assert.equal(isValidSession({ ...retry, rounds: [{ ...retry.rounds[0], attempts: [400000, 850000, 425000] }] }, data.questions), false);
});

test('시간 제한이 없어 빈 추측(시간초과)이나 예전 45초 세션은 받지 않음', () => {
  assert.equal(isValidSession({ ...initial(), attempts: [null] }, data.questions), false);
  assert.equal(isValidSession({ ...initial(), phase: 'reveal', rounds: [{ candidateId: question.id, attempts: [null, null], score: 0 }] }, data.questions), false);
  assert.equal(isValidSession({ ...initial(), version: 2, timeLimit: 45 }, data.questions), false);
});

test('문제 수는 3~50 중 정해진 값이고, 앞에서부터 그만큼 출제', () => {
  assert.deepEqual(QUESTION_COUNTS, [3, 5, 10, 15, 20, 30, 40, 50]);
  const three = data.questions.slice(0, 3);
  const rounds = three.map(q => ({ candidateId: q.id, attempts: [q.answer], score: 1000 }));
  const done = { ...initial(), questionCount: 3, phase: 'results', index: 2, rounds };
  assert.equal(isValidSession(done, three), true);
  assert.equal(isValidSession(done, data.questions), false);
  assert.equal(isValidSession({ ...done, questionCount: 4 }, data.questions.slice(0, 4)), false);
  assert.equal(grade(2700, 3).title, grade(9000, 10).title);
});

test('검증된 가격·단위·인도조건과 계약기간을 유지', () => {
  assert.equal(data.questions.length, 10);
  assert.equal(new Set(data.questions.map(q => q.id)).size, 10);
  assert.equal(data.questions.find(q => q.id === 'C01').answer, 425000);
  assert.equal(data.questions.find(q => q.id === 'C22').answer, 20000);
  assert.equal(data.questions.find(q => q.id === 'C28').answer, 951500000);
  assert.equal(data.questions.find(q => q.id === 'C29').quantity, '1포');
  assert.match(data.questions.find(q => q.id === 'C29').specification, /1000kg\/포/);
  assert.equal(data.questions.some(q => ['C11', 'C16'].includes(q.id)), false);
  for (const q of data.questions) {
    assert.ok(q.contractStart <= data.referenceDate && q.contractEnd >= data.referenceDate);
    assert.equal(q.vat, '부가가치세포함');
    assert.equal('serviceKey' in q.queryWithoutSecret, false);
  }
});

test('공식 상품 이미지 10개가 로컬에 존재하고 원문 체크섬·물품 출처를 보존', async () => {
  for (const q of data.questions) {
    assert.match(q.image.sourceUrl, /^https:\/\/shop\.g2b\.go\.kr\//);
    assert.ok(q.image.alt.includes(q.specification));
    const bytes = await readFile(new URL('../dist/' + q.image.src.replace(/^\.\//, ''), import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), q.image.sha256);
    assert.ok(bytes.length > 1000);
  }
  assert.equal(data.questions.find(q => q.id === 'C04').image.kind, 'catalog-render');
  assert.equal(data.questions.find(q => q.id === 'C06').image.kind, 'product-photo');
});

test('틈새 지식 9개의 공식 출처·기준기간과 문제 연결 유지', () => {
  assert.equal(data.trivia.length, 9);
  for (const q of data.questions.slice(0, -1)) {
    const card = data.trivia.find(t => t.id === q.triviaId);
    assert.ok(card?.period && card.text && card.sources.length);
    assert.ok(card.sources.every(s => /^https:\/\//.test(s.url) && s.publisher));
  }
  assert.equal(data.questions.at(-1).triviaId, null);
});

test('최종 결과는 10문제가 완료돼야 복구할 수 있고 합계가 정확함', () => {
  const rounds = data.questions.map(q => ({ candidateId: q.id, attempts: [q.answer], score: 1000 }));
  assert.equal(totalScore(rounds), 10000);
  assert.equal(isValidSession({ ...initial(), phase: 'results', index: 9, rounds }, data.questions), true);
  assert.equal(isValidSession({ ...initial(), phase: 'results', index: 9, rounds: rounds.slice(0, 9) }, data.questions), false);
  assert.equal(isValidSession({ ...initial(), index: 99 }, data.questions), false);
  assert.equal(koreanAmount(951500000), '9억 5,150만 원');
});
