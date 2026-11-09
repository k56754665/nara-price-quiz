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
  if (average >= 850) return { title: "나라장터 가격의 달인", subtitle: "이 정도면 가격표와 마음이 통했어요.", symbol: "✦" };
  if (average >= 600) return { title: "예리한 가격 탐정", subtitle: "규격 속에 숨은 가격의 단서를 잘 찾았어요.", symbol: "◎" };
  if (average >= 350) return { title: "호기심 많은 발견가", subtitle: "익숙한 물건을 새로운 가격으로 발견했어요.", symbol: "↗" };
  return { title: "뜻밖의 가격 수집가", subtitle: "오늘의 놀라움이 다음 추측의 힌트가 될 거예요.", symbol: "?" };
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

export function createSession(bank, rankEligible = false, random = Math.random) {
  const questions = structuredClone(sampleQuestions(bank.questions, ROUND_COUNT, random));
  return { version: 5, phase: 'question', index: 0, attempts: [], rounds: [], draft: '', questionCount: ROUND_COUNT, rankEligible,
    questionSet: bank.bankVersion, rankingSet: rankingSet(bank.bankVersion), rulesVersion: RULES_VERSION, referenceDate: bank.referenceDate,
    questionIds: questions.map(q => q.id), questions, trivia: structuredClone(bank.trivia) };
}

// 예전 규칙(두 번 추측)으로 하던 게임은 새 규칙으로 이어갈 수 없어 버립니다.
export function restoreSession(saved) {
  return saved?.version === 5 && isValidSession(saved, saved.questions) ? saved : null;
}

// questions는 이 게임에 저장된 출제 순서이며, 현재 문제은행이 아닙니다.
export function isValidSession(value, questions) {
  if (!value || value.version !== 5 || value.rulesVersion !== RULES_VERSION || !["question", "reveal", "results"].includes(value.phase) || !Array.isArray(questions)) return false;
  if (typeof value.questionSet !== 'string' || !value.questionSet || value.rankingSet !== rankingSet(value.questionSet) || typeof value.referenceDate !== 'string') return false;
  if (value.questionCount !== ROUND_COUNT || questions.length !== ROUND_COUNT) return false;
  if (!Array.isArray(value.questionIds) || value.questionIds.length !== questions.length || new Set(value.questionIds).size !== questions.length) return false;
  if (!Array.isArray(value.trivia) || questions.some((q, i) => !q || q.id !== value.questionIds[i] || !Number.isSafeInteger(q.answer) || q.answer <= 0 || !q.image?.src || typeof q.title !== 'string' || typeof q.specification !== 'string')) return false;
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
