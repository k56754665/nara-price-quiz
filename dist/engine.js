export const MAX_GUESS = 999_999_999_999;

export function parseGuess(value) {
  const text = String(value).trim();
  if (!/^[\d,\s]+$/.test(text)) return null;
  const number = Number(text.replace(/[,\s]/g, ""));
  return Number.isSafeInteger(number) && number > 0 && number <= MAX_GUESS ? number : null;
}

// 게임 규칙: 매 게임 문제은행에서 10문제를 무작위로 뽑고, 물건마다 최대 3번 추측합니다.
// 정답의 ±10% 안이면 성공이며, 몇 번째에 맞혔는지에 따라 점수를 줍니다. 실패하면 0점입니다.
// 점수를 바꾸면 supabase/rules-v4.sql의 submit_score_v4도 같이 바꿔야 합니다.
export const ROUND_COUNT = 10;
export const MAX_ATTEMPTS = 3;
export const TOLERANCE_PERCENT = 10;
export const ATTEMPT_SCORES = [1000, 800, 500];
export const RULES_VERSION = 4;

// 정수로만 비교해 서버(PostgreSQL)와 결과가 같도록 합니다.
export function isCorrect(guess, answer) {
  return Number.isSafeInteger(guess) && guess > 0 && Number.isSafeInteger(answer) && answer > 0 && Math.abs(guess - answer) * 100 <= answer * TOLERANCE_PERCENT;
}

export function scoreRound(attempts, answer) {
  const index = attempts.findIndex(guess => isCorrect(guess, answer));
  return index === -1 ? 0 : ATTEMPT_SCORES[index];
}

export function relativeError(guess, answer) {
  return guess === null ? null : (guess - answer) / answer * 100;
}

export function koreanAmount(value) {
  if (!value) return "숫자를 입력하거나 금액 버튼을 눌러 주세요";
  const units = [[100_000_000, "억"], [10_000, "만"], [1, ""]];
  let rest = value;
  return units.map(([size, label]) => {
    const count = Math.floor(rest / size);
    rest %= size;
    return count ? count.toLocaleString("ko-KR") + label : "";
  }).filter(Boolean).join(" ") + " 원";
}

export function judge(score) {
  if (score === ATTEMPT_SCORES[0]) return { title: "한 번에 맞혔어요!", tag: "단번에 정답", tone: "excellent" };
  if (score === ATTEMPT_SCORES[1]) return { title: "두 번 만에 맞혔어요!", tag: "날카로운 감각", tone: "excellent" };
  if (score === ATTEMPT_SCORES[2]) return { title: "마지막 기회에 성공!", tag: "아슬아슬 정답", tone: "okay" };
  return { title: "이 가격, 예상하셨나요?", tag: "아쉽게 놓쳤어요", tone: "surprise" };
}

// 틀린 추측에만 힌트를 줍니다. 오차 10% 안은 이미 정답이라 '조금'부터 시작합니다.
export function guessHint(guess, answer) {
  if (!Number.isFinite(guess) || guess <= 0 || !Number.isFinite(answer) || answer <= 0 || isCorrect(guess, answer)) return null;
  const factor = Math.max(guess / answer, answer / guess);
  const distance = factor <= 1.5 ? '조금' : factor <= 2 ? '꽤' : factor <= 5 ? '많이' : '아주 많이';
  const direction = guess < answer ? 'UP' : 'DOWN';
  return {
    direction,
    label: `${distance} ${direction === 'UP' ? '낮아요' : '높아요'}`,
    instruction: `가격을 ${distance} 더 ${direction === 'UP' ? '올려' : '내려'} 보세요.`,
  };
}

export function totalScore(rounds) {
  return rounds.reduce((sum, round) => sum + round.score, 0);
}

export function grade(total, roundCount = ROUND_COUNT) {
  const average = total / roundCount;
  const legendaryDescription = "말도 안 돼요!! 설마 모든 가격을 맞히신 건가요?! 조달청이 발칵 뒤집혔습니다! 전국의 견적서들이 당신 앞에 무릎을 꿇고, 나라장터에는 당신을 위한 황금 동상이 세워질 예정입니다. 축하합니다! 당신은 이제 인간의 영역을 넘어선 조달의 신입니다!";
  if (total === roundCount * ATTEMPT_SCORES[0]) return {
    tier: 'deity', title: '조달의 신', subtitle: legendaryDescription,
    image: 'result-catchers.png', imageCrop: 'left', imageAlt: '그물을 든 흰 새',
  };
  if (average >= 600) return {
    tier: 'estimate', title: '걸어 다니는 견적서',
    subtitle: '웬만한 가격에는 눈썹 하나 까딱하지 않는 경지! 이제 물건을 보면 가격보다 규격과 납품 조건이 먼저 보이시나요? 나라장터가 당신에게 견적을 물어볼지도 모르겠네요.',
    image: 'result-surprised.png', imageCrop: 'full', imageAlt: '고글을 쓰고 놀란 흰 새',
  };
  if (average >= 400) return {
    tier: 'ace', title: '견적서 수사대 에이스',
    subtitle: "수상한 가격을 제법 정확하게 추리했습니다! 하지만 견적서는 아직 당신에게 몇 가지 비밀을 숨기고 있어요. 다음엔 '현장 설치 포함' 같은 조건도 놓치지 마세요.",
    image: 'result-scientists.png', imageCrop: 'full', imageAlt: '로봇과 주황 동물 과학자',
  };
  if (average >= 200) return {
    tier: 'bargain', title: '가격표와 밀당 중',
    subtitle: '분명 이 정도 가격일 줄 알았는데…! 맞힐 듯 말 듯, 가격표와 치열한 심리전을 벌였습니다. 이제 알겠죠? 세상의 모든 물건이 우리가 생각하는 가격에 팔리지는 않는다는 걸요.',
    image: 'result-officials.png', imageCrop: 'full', imageAlt: '판사 다람쥐와 경찰 새 마스코트',
  };
  return {
    tier: 'shocked', title: '가격표 앞에서 동공지진',
    subtitle: '네?! 이게 이 가격이라고요?! 오늘 당신의 상식이 몇 번이나 흔들렸는지 모르겠네요. 하지만 이제 길거리의 가로수 보호판 하나도 예사롭게 보이지 않을 겁니다.',
    image: 'result-catchers.png', imageCrop: 'right', imageAlt: '호두 클립보드를 든 다람쥐',
  };
}

export function sampleQuestions(questions, count = ROUND_COUNT, random = Math.random) {
  if (!Number.isInteger(count) || count < 1 || count > questions.length || new Set(questions.map(q => q.id)).size !== questions.length) throw Error('invalid question pool');
  const pool = [...questions];
  for (let i = pool.length - 1; i > 0; i--) {
    const value = random();
    if (!(value >= 0 && value < 1)) throw Error('invalid random value');
    const j = Math.floor(value * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

// 랭킹은 문제은행 버전 + 규칙 버전마다 따로 집계합니다(예전 규칙 기록과 섞이지 않게).
export const rankingSet = bankVersion => `${bankVersion}:r${RULES_VERSION}`;

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const httpsUrl = value => {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
};

function validTriviaCards(cards) {
  return Array.isArray(cards) && cards.every(card => card && nonempty(card.id) && nonempty(card.title)
    && nonempty(card.text) && nonempty(card.period) && Array.isArray(card.sources) && card.sources.length > 0
    && card.sources.every(source => source && nonempty(source.title) && nonempty(source.publisher) && httpsUrl(source.url)))
    && new Set(cards.map(card => card.id)).size === cards.length
    && new Set(cards.map(card => card.text.trim().replace(/\s+/g, ' '))).size === cards.length;
}

// 지식 풀은 정답표·랭킹 버전과 별도로 관리합니다.
export function isValidTriviaPool(pool) {
  return pool?.schemaVersion === 1 && nonempty(pool.version) && validTriviaCards(pool.cards) && pool.cards.length >= ROUND_COUNT;
}

function assignTrivia(pool, random) {
  if (!isValidTriviaPool(pool)) throw Error('invalid trivia pool');
  return { triviaVersion: pool.version, triviaRounds: structuredClone(sampleQuestions(pool.cards, ROUND_COUNT, random)) };
}

export function createSession(bank, triviaPool, rankEligible = false, random = Math.random) {
  const questions = structuredClone(sampleQuestions(bank.questions, ROUND_COUNT, random));
  return { version: 6, phase: 'question', index: 0, attempts: [], rounds: [], draft: '', questionCount: ROUND_COUNT, rankEligible,
    questionSet: bank.bankVersion, rankingSet: rankingSet(bank.bankVersion), rulesVersion: RULES_VERSION, referenceDate: bank.referenceDate,
    questionIds: questions.map(q => q.id), questions, ...assignTrivia(triviaPool, random) };
}

// v5는 추측·점수·출제 순서를 보존하고 지식만 한 번 배정합니다. v6는 재추첨하지 않습니다.
export function restoreSession(saved, triviaPool, random = Math.random) {
  if (saved?.version === 6) return isValidSession(saved, saved.questions) ? saved : null;
  if (saved?.version !== 5 || !Array.isArray(saved.trivia) || !isValidProgress(saved, saved.questions)) return null;
  const { trivia, ...previous } = saved;
  return { ...previous, version: 6, ...assignTrivia(triviaPool, random) };
}

// questions는 이 게임에 저장된 출제 순서이며, 현재 문제은행이 아닙니다.
export function isValidSession(value, questions) {
  return value?.version === 6 && nonempty(value.triviaVersion) && validTriviaCards(value.triviaRounds)
    && value.triviaRounds.length === ROUND_COUNT && isValidProgress(value, questions);
}

function isValidProgress(value, questions) {
  if (!value || value.rulesVersion !== RULES_VERSION || !["question", "reveal", "results"].includes(value.phase) || !Array.isArray(questions)) return false;
  if (typeof value.questionSet !== 'string' || !value.questionSet || value.rankingSet !== rankingSet(value.questionSet) || typeof value.referenceDate !== 'string') return false;
  if (value.questionCount !== ROUND_COUNT || questions.length !== ROUND_COUNT) return false;
  if (!Array.isArray(value.questionIds) || value.questionIds.length !== questions.length || new Set(value.questionIds).size !== questions.length) return false;
  if (questions.some((q, i) => !q || q.id !== value.questionIds[i] || !Number.isSafeInteger(q.answer) || q.answer <= 0 || !q.image?.src || typeof q.title !== 'string' || typeof q.specification !== 'string')) return false;
  if (!Number.isInteger(value.index) || value.index < 0 || value.index >= questions.length) return false;
  if (!Array.isArray(value.rounds) || value.rounds.length > questions.length) return false;
  const validGuess = x => Number.isSafeInteger(x) && x > 0 && x <= MAX_GUESS;
  if (value.draft != null && (typeof value.draft !== 'string' || !/^[\d,]{0,15}$/.test(value.draft))) return false;
  if (value.rounds.some((r, i) => {
    const answer = questions[i].answer;
    if (!r || r.candidateId !== questions[i].id || !Array.isArray(r.attempts) || r.attempts.length < 1 || r.attempts.length > MAX_ATTEMPTS || r.attempts.some(x => !validGuess(x))) return true;
    // 정답이 나오면 그 라운드는 끝나므로, 마지막을 뺀 추측은 모두 오답이어야 합니다.
    if (r.attempts.slice(0, -1).some(x => isCorrect(x, answer))) return true;
    if (!isCorrect(r.attempts.at(-1), answer) && r.attempts.length !== MAX_ATTEMPTS) return true;
    return r.score !== scoreRound(r.attempts, answer);
  })) return false;
  // 진행 중인 라운드의 추측은 모두 오답이고, 기회가 남아 있어야 합니다.
  if (!Array.isArray(value.attempts) || value.attempts.length >= MAX_ATTEMPTS || value.attempts.some(x => !validGuess(x))) return false;
  if (value.phase === 'question') return value.rounds.length === value.index && !value.attempts.some(x => isCorrect(x, questions[value.index].answer));
  if (value.attempts.length !== 0) return false;
  if (value.phase === 'reveal') return value.rounds.length === value.index + 1;
  return value.rounds.length === questions.length && value.index === questions.length - 1;
}
