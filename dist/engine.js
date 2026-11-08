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

// questions는 이번 게임에 나오는 문제들(전체 문제의 앞쪽 questionCount개)입니다.
export function isValidSession(value, questions) {
  if (!value || value.version !== 3 || !["question", "reveal", "results"].includes(value.phase)) return false;
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
