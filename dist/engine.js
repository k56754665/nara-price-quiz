export const MAX_GUESS = 999_999_999_999;

export function parseGuess(value) {
  const text = String(value).trim();
  if (!/^[\d,\s]+$/.test(text)) return null;
  const number = Number(text.replace(/[,\s]/g, ""));
  return Number.isSafeInteger(number) && number > 0 && number <= MAX_GUESS ? number : null;
}

export function scoreGuess(guess, answer) {
  if (!Number.isFinite(guess) || guess <= 0 || !Number.isFinite(answer) || answer <= 0) return 0;
  if (guess === answer) return 1000;
  return Math.min(999, Math.round(1000 * Math.exp(-1.5 * Math.abs(Math.log(guess / answer)))));
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
  if (score === 1000) return { title: "가격 감각, 완벽해요!", tag: "정확히 맞혔어요", tone: "excellent" };
  if (score >= 850) return { title: "거의 가격표를 봤는데요?", tag: "놀라운 감각", tone: "excellent" };
  if (score >= 600) return { title: "꽤 가까이 왔어요!", tag: "좋은 추측", tone: "good" };
  if (score >= 300) return { title: "예상과 조금 달랐죠?", tag: "새로운 발견", tone: "okay" };
  return { title: "이 가격, 예상하셨나요?", tag: "뜻밖의 가격", tone: "surprise" };
}

export function guessHint(guess, answer) {
  if (!Number.isFinite(guess) || guess <= 0 || !Number.isFinite(answer) || answer <= 0 || guess === answer) return null;
  const factor = Math.max(guess / answer, answer / guess);
  const distance = factor <= 1.1 ? '아주 조금' : factor <= 1.35 ? '조금' : factor <= 2 ? '꽤' : factor <= 5 ? '많이' : '아주 많이';
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

export function grade(total, roundCount = 10) {
  const average = total / roundCount;
  if (average >= 850) return { title: "나라장터 가격의 달인", subtitle: "이 정도면 가격표와 마음이 통했어요.", symbol: "✦" };
  if (average >= 600) return { title: "예리한 가격 탐정", subtitle: "규격 속에 숨은 가격의 단서를 잘 찾았어요.", symbol: "◎" };
  if (average >= 350) return { title: "호기심 많은 발견가", subtitle: "익숙한 물건을 새로운 가격으로 발견했어요.", symbol: "↗" };
  return { title: "뜻밖의 가격 수집가", subtitle: "오늘의 놀라움이 다음 추측의 힌트가 될 거예요.", symbol: "?" };
}

export const QUESTION_COUNTS = [3, 5, 10, 15, 20, 30, 40, 50];

export function sampleQuestions(questions, count, random = Math.random) {
  if (!QUESTION_COUNTS.includes(count) || count > questions.length || new Set(questions.map(q => q.id)).size !== questions.length) throw Error('invalid question pool');
  const pool = [...questions];
  for (let i = pool.length - 1; i > 0; i--) {
    const value = random();
    if (!(value >= 0 && value < 1)) throw Error('invalid random value');
    const j = Math.floor(value * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export function createSession(bank, count, rankEligible = false, random = Math.random) {
  const questions = structuredClone(sampleQuestions(bank.questions, count, random));
  return { version: 4, phase: 'question', index: 0, attempts: [], rounds: [], draft: '', questionCount: count, rankEligible,
    questionSet: bank.bankVersion, protocolVersion: 2, referenceDate: bank.referenceDate,
    questionIds: questions.map(q => q.id), questions, trivia: structuredClone(bank.trivia) };
}

export function restoreSession(saved, legacyBank) {
  if (!saved) return null;
  if (saved.version === 4) return isValidSession(saved, saved.questions) ? saved : null;
  if (saved.version === 2) {
    if (saved.timeLimit !== 0) return null;
    const { timeLimit, deadline, ...rest } = saved;
    saved = { ...rest, version: 3, questionCount: 10 };
  }
  if (saved.version !== 3 || !legacyBank) return null;
  const questions = legacyBank.questions.slice(0, saved.questionCount);
  if (!isValidSession(saved, questions)) return null;
  return { ...saved, version: 4, questionSet: legacyBank.referenceDate, protocolVersion: 1, referenceDate: legacyBank.referenceDate,
    questionIds: questions.map(q => q.id), questions: structuredClone(questions), trivia: structuredClone(legacyBank.trivia) };
}

// questions is the saved, ordered selection, not the current published pool.
export function isValidSession(value, questions) {
  if (!value || ![3, 4].includes(value.version) || !["question", "reveal", "results"].includes(value.phase) || !Array.isArray(questions)) return false;
  if (value.version === 4) {
    if (![1, 2].includes(value.protocolVersion) || typeof value.questionSet !== 'string' || !value.questionSet || typeof value.referenceDate !== 'string') return false;
    if (!Array.isArray(value.questionIds) || value.questionIds.length !== questions.length || new Set(value.questionIds).size !== questions.length) return false;
    if (!Array.isArray(value.trivia) || questions.some((q, i) => !q || q.id !== value.questionIds[i] || !Number.isSafeInteger(q.answer) || q.answer <= 0 || !q.image?.src || typeof q.title !== 'string' || typeof q.specification !== 'string')) return false;
  }
  if (!QUESTION_COUNTS.includes(value.questionCount) || value.questionCount !== questions.length) return false;
  if (!Number.isInteger(value.index) || value.index < 0 || value.index >= questions.length) return false;
  if (!Array.isArray(value.rounds) || value.rounds.length > questions.length) return false;
  const validGuess = x => Number.isSafeInteger(x) && x > 0 && x <= MAX_GUESS;
  if (!Array.isArray(value.attempts) || value.attempts.length > 1 || value.attempts.some(x => !validGuess(x))) return false;
  if (value.draft != null && (typeof value.draft !== 'string' || !/^[\d,]{0,15}$/.test(value.draft))) return false;
  if (value.rounds.some((r, i) => {
    if (!r || r.candidateId !== questions[i].id || !Array.isArray(r.attempts) || r.attempts.length < 1 || r.attempts.length > 2 || r.attempts.some(x => !validGuess(x))) return true;
    const firstIsCorrect = r.attempts[0] === questions[i].answer;
    if ((r.attempts.length === 1) !== firstIsCorrect) return true;
    return r.score !== scoreGuess(r.attempts.at(-1), questions[i].answer);
  })) return false;
  if (value.phase === 'question') return value.rounds.length === value.index && value.attempts[0] !== questions[value.index].answer;
  if (value.attempts.length !== 0) return false;
  if (value.phase === 'reveal') return value.rounds.length === value.index + 1;
  return value.rounds.length === questions.length && value.index === questions.length - 1;
}
