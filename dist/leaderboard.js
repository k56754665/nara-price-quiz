// Supabase RPC로 온라인 랭킹을 주고받습니다. 외부 라이브러리 없이 fetch만 사용합니다.

export const NICKNAME_MAX = 12;

export function isConfigured(config) {
  // secret 키(sb_secret_...)는 브라우저에 두면 안 되므로 랭킹을 켜지 않습니다.
  const validUrl = /^https:\/\/[^\s/]+/.test(config?.url ?? '') || config?.preview === true && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(config.url);
  return Boolean(validUrl && typeof config.anonKey === 'string' && config.anonKey.length > 20 && !config.anonKey.startsWith('sb_secret_'));
}

export function normalizeNickname(value) {
  const text = String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!text || [...text].length > NICKNAME_MAX || /[\u0000-\u001f\u007f<>]/.test(text)) return null;
  return text;
}

// 시간 제한 모드는 없어졌지만, 서버 함수 형식을 유지하려고 p_time_limit은 항상 0으로 보냅니다.
// rules 1: 예전 10개 세트(추측만), 2 이상: 문제은행에서 뽑은 문제 ID와 추측을 함께 보냅니다.
export function buildSubmission({ questionSet, clientId, nickname, rounds, protocolVersion = 3 }) {
  return {
    p_question_set: questionSet,
    p_time_limit: 0,
    p_client_id: clientId,
    p_nickname: nickname,
    p_attempts: protocolVersion >= 2 ? rounds.map(r => ({ question_id: r.candidateId, attempts: r.attempts })) : rounds.map(r => r.attempts),
  };
}

const errorMessages = {
  already_submitted: '이 기기에서는 이미 기록을 등록했어요.',
  invalid_nickname: `닉네임은 1~${NICKNAME_MAX}자로 입력해 주세요.`,
  invalid_attempts: '기록을 확인하지 못했어요. 새 게임으로 다시 도전해 주세요.',
  unknown_question_set: '지금 문제 세트는 랭킹을 지원하지 않아요.',
  ranking_not_ready: '새 문제의 랭킹 연결을 준비하고 있어요. 잠시 후 다시 시도해 주세요.',
};

export function errorMessage(code) {
  return errorMessages[code] ?? '랭킹 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.';
}

export class LeaderboardError extends Error {
  constructor(code) { super(errorMessage(code)); this.code = code; }
}

async function rpc(config, name, body, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${config.url.replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { throw new LeaderboardError('network'); }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.code === 'PGRST202' ? 'ranking_not_ready' : Object.keys(errorMessages).find(key => payload?.message === key) ?? 'server';
    throw new LeaderboardError(code);
  }
  return payload;
}

export async function submitScore(config, submission, fetchImpl) {
  // 현재 규칙(±10% · 4번 추측)은 submit_score_v3가 채점합니다.
  const name = submission.p_attempts?.[0]?.question_id ? 'submit_score_v3' : 'submit_score';
  const rows = await rpc(config, name, submission, fetchImpl);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !Number.isInteger(Number(row.rank))) throw new LeaderboardError('server');
  return { rank: Number(row.rank), totalScore: row.total_score, perfectCount: row.perfect_count };
}

// questionSet은 랭킹 집계 단위입니다. 현재 규칙은 engine.js의 rankingSet(문제은행 버전)을 넘깁니다.
export async function fetchLeaderboard(config, { questionSet, limit = 20 }, fetchImpl) {
  const rows = await rpc(config, 'get_leaderboard', { p_question_set: questionSet, p_time_limit: 0, p_limit: limit }, fetchImpl);
  if (!Array.isArray(rows)) throw new LeaderboardError('server');
  // question_count가 없으면 예전 SQL(10문제 고정)에서 온 기록입니다.
  return rows.map(r => ({ rank: Number(r.rank), nickname: String(r.nickname), totalScore: Number(r.total_score), perfectCount: Number(r.perfect_count), questionCount: Number(r.question_count ?? 10) }));
}
