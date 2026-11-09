import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ROUND_COUNT, MAX_ATTEMPTS, ATTEMPT_SCORES, parseGuess, isCorrect, scoreRound, relativeError, koreanAmount, totalScore, grade, guessHint, judge, createSession, restoreSession, isValidSession, rankingSet } from '../dist/engine.js';
import { scoreBlocks } from '../dist/share.js';

// 예전 10개 세트(데이터 보존 검사용)와 현재 문제은행
const data = JSON.parse(await readFile(new URL('../dist/legacy-data.json', import.meta.url), 'utf8'));
const bank = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const fresh = () => createSession(bank, true, () => 0);

test('가격 입력은 쉼표·공백을 처리하고 0원·음수·문자·범위 밖 금액을 거부', () => {
  assert.equal(parseGuess(' 425,000 '), 425000);
  assert.equal(parseGuess('951 500 000'), 951500000);
  for (const value of ['', ' ', '0', '-100', '1.5', '100만원', 'Infinity', '1000000000000']) assert.equal(parseGuess(value), null);
});

test('정답 ±10% 안이면 성공이고 경계값도 포함', () => {
  assert.equal(isCorrect(100000, 100000), true);
  assert.equal(isCorrect(90000, 100000), true);
  assert.equal(isCorrect(110000, 100000), true);
  assert.equal(isCorrect(89999, 100000), false);
  assert.equal(isCorrect(110001, 100000), false);
  assert.equal(isCorrect(null, 100000), false);
  assert.equal(relativeError(850000, 425000), 100);
});

test('점수는 몇 번째에 맞혔는지로만 정하고, 3번 모두 틀리면 0점', () => {
  assert.deepEqual(ATTEMPT_SCORES, [1000, 800, 500]);
  assert.equal(MAX_ATTEMPTS, 3);
  assert.equal(scoreRound([100000], 100000), 1000);
  assert.equal(scoreRound([105000], 100000), 1000);
  assert.equal(scoreRound([1, 91000], 100000), 800);
  assert.equal(scoreRound([1, 2, 109000], 100000), 500);
  assert.equal(scoreRound([1, 2, 3], 100000), 0);
  assert.equal(judge(500).tag, '아슬아슬 정답');
  assert.equal(judge(0).tag, '아쉽게 놓쳤어요');
  assert.equal(scoreBlocks([{ attempts: [1], score: 1000 }, { attempts: [1, 2, 3], score: 500 }, { attempts: [1, 2, 3], score: 0 }]), '🟩🟨🟥');
});

test('힌트는 오답에만 UP/DOWN과 거리를 주고, 숫자 정답·오차율을 노출하지 않음', () => {
  assert.deepEqual(guessHint(300000, 425000), { direction: 'UP', label: '조금 낮아요', instruction: '가격을 조금 더 올려 보세요.' });
  assert.equal(guessHint(600000, 425000).direction, 'DOWN');
  assert.equal(guessHint(800000, 425000).label, '꽤 높아요');
  assert.equal(guessHint(1000000, 425000).label, '많이 높아요');
  assert.equal(guessHint(1000, 425000).label, '아주 많이 낮아요');
  assert.equal(guessHint(440000, 425000), null);
  assert.equal(guessHint(null, 425000), null);
  assert.equal(/[0-9%]/.test(JSON.stringify(guessHint(300000, 425000))), false);
});

test('거리 형용사는 비싸게·싸게 추측한 배율을 같은 기준으로 평가', () => {
  for (const factor of [1.2, 1.6, 3, 10]) {
    const low = guessHint(100000 / factor, 100000).label.replace('낮아요', '');
    const high = guessHint(100000 * factor, 100000).label.replace('높아요', '');
    assert.equal(low, high);
  }
});

test('매 게임 문제은행에서 10문제를 중복 없이 뽑고 저장·복구', () => {
  const session = fresh();
  assert.equal(session.questions.length, ROUND_COUNT);
  assert.equal(new Set(session.questionIds).size, ROUND_COUNT);
  assert.equal(session.rankingSet, rankingSet(bank.bankVersion));
  assert.deepEqual(restoreSession(structuredClone(session)), session);
  assert.notDeepEqual(createSession(bank, true, () => .999).questionIds, session.questionIds);
});

test('오답이면 기회가 남은 동안 같은 문제를 이어가고, 정답이 섞인 진행 기록은 거부', () => {
  const s = fresh(); const answer = s.questions[0].answer;
  assert.equal(isValidSession({ ...s, attempts: [1, 2], draft: '400,000' }, s.questions), true);
  assert.equal(isValidSession({ ...s, attempts: [1, 2, 3] }, s.questions), false);
  assert.equal(isValidSession({ ...s, attempts: [answer] }, s.questions), false);
  assert.equal(isValidSession({ ...s, attempts: [null] }, s.questions), false);
});

test('라운드 결과는 규칙대로 끝났을 때만 인정', () => {
  const s = fresh(); const q = s.questions[0];
  const round = attempts => ({ ...s, phase: 'reveal', rounds: [{ candidateId: q.id, attempts, score: scoreRound(attempts, q.answer) }] });
  assert.equal(isValidSession(round([q.answer]), s.questions), true);
  assert.equal(isValidSession(round([1, q.answer]), s.questions), true);
  assert.equal(isValidSession(round([1, 2, 3]), s.questions), true);
  assert.equal(isValidSession(round([1, 2]), s.questions), false);
  assert.equal(isValidSession(round([q.answer, q.answer]), s.questions), false);
  assert.equal(isValidSession(round([1, 2, 3, q.answer]), s.questions), false);
  const tampered = round([1, q.answer]); tampered.rounds[0].score = 1000;
  assert.equal(isValidSession(tampered, s.questions), false);
});

test('예전 규칙(두 번 추측)의 진행 기록은 이어가지 않음', () => {
  assert.equal(restoreSession({ version: 4, phase: 'question', questions: [] }), null);
  assert.equal(restoreSession({ ...fresh(), rulesVersion: 3 }), null);
  assert.equal(restoreSession({ ...fresh(), questionCount: 5 }), null);
});

test('최종 결과는 10문제가 완료돼야 복구할 수 있고 합계가 정확함', () => {
  const s = fresh();
  const rounds = s.questions.map(q => ({ candidateId: q.id, attempts: [q.answer], score: 1000 }));
  assert.equal(totalScore(rounds), 10000);
  assert.equal(isValidSession({ ...s, phase: 'results', index: 9, rounds }, s.questions), true);
  assert.equal(isValidSession({ ...s, phase: 'results', index: 9, rounds: rounds.slice(0, 9) }, s.questions), false);
  assert.equal(isValidSession({ ...s, index: 99 }, s.questions), false);
  assert.equal(grade(9000).title, '나라장터 가격의 달인');
  assert.equal(koreanAmount(951500000), '9억 5,150만 원');
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
