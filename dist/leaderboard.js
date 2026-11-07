// Supabase RPC로 온라인 랭킹을 주고받습니다. 외부 라이브러리 없이 fetch만 사용합니다.

export const NICKNAME_MAX = 12;

export function isConfigured(config) {
  return Boolean(config && /^https:\/\/[^\s/]+/.test(config.url ?? '') && typeof config.anonKey === 'string' && config.anonKey.length > 20);
}

export function normalizeNickname(value) {
  const text = String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!text || [...text].length > NICKNAME_MAX || /[\u0000-\u001f\u007f<>]/.test(text)) return null;
  return text;
}

export function buildSubmission({ questionSet, timeLimit, clientId, nickname, rounds }) {
  return {
    p_question_set: questionSet,
    p_time_limit: timeLimit,
    p_client_id: clientId,
    p_nickname: nickname,
    p_attempts: rounds.map(r => r.attempts),
  };
}

const errorMessages = {
  already_submitted: '이 기기에서는 이 모드의 기록을 이미 등록했어요.',
  invalid_nickname: `닉네임은 1~${NICKNAME_MAX}자로 입력해 주세요.`,
  invalid_attempts: '기록을 확인하지 못했어요. 새 게임으로 다시 도전해 주세요.',
  unknown_question_set: '지금 문제 세트는 랭킹을 지원하지 않아요.',
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
    const code = Object.keys(errorMessages).find(key => payload?.message === key) ?? 'server';
    throw new LeaderboardError(code);
  }
  return payload;
}

export async function submitScore(config, submission, fetchImpl) {
  const rows = await rpc(config, 'submit_score', submission, fetchImpl);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !Number.isInteger(Number(row.rank))) throw new LeaderboardError('server');
  return { rank: Number(row.rank), totalScore: row.total_score, perfectCount: row.perfect_count };
}

export async function fetchLeaderboard(config, { questionSet, timeLimit, limit = 20 }, fetchImpl) {
  const rows = await rpc(config, 'get_leaderboard', { p_question_set: questionSet, p_time_limit: timeLimit, p_limit: limit }, fetchImpl);
  if (!Array.isArray(rows)) throw new LeaderboardError('server');
  return rows.map(r => ({ rank: Number(r.rank), nickname: String(r.nickname), totalScore: Number(r.total_score), perfectCount: Number(r.perfect_count) }));
}
