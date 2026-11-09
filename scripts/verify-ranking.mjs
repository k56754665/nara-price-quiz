// Read-only deployment gate. Does not submit a score or change the live DB.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { LEADERBOARD_CONFIG } from '../dist/leaderboard-config.js';
import { isConfigured } from '../dist/leaderboard.js';
import { RULES_VERSION } from '../dist/engine.js';
const bank = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const answerFingerprint = bank => createHash('md5').update([...bank.questions].sort((a,b)=>a.id.localeCompare(b.id)).map(q=>`${q.id}:${q.answer}`).join(',')).digest('hex');
const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
if(bank.questions.some(q=>!Number.isFinite(Date.parse(q.checkedAt)) || Date.now()-Date.parse(q.checkedAt)>86400000 || q.contractEnd<today))throw Error('24시간 이내에 확인하지 않은 품목이 있습니다. 문제은행의 원본 계약 정보를 확인한 뒤 배포해 주세요.');
if (!isConfigured(LEADERBOARD_CONFIG)) {
  console.log('Ranking is disabled; no live DB check required.');
} else {
  const response = await fetch(`${LEADERBOARD_CONFIG.url.replace(/\/+$/, '')}/rest/v1/rpc/get_quiz_bank_status`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { apikey: LEADERBOARD_CONFIG.anonKey, Authorization: `Bearer ${LEADERBOARD_CONFIG.anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_question_set: bank.bankVersion }),
  });
  const result = await response.json();
  if (!response.ok || Number(result?.[0]?.question_count) !== bank.questions.length || result?.[0]?.answer_fingerprint !== answerFingerprint(bank)) throw Error('운영 랭킹에 문제은행이 준비되지 않았습니다. supabase/curated-release.sql을 적용한 후 다시 검사하세요.');
  // 게임 규칙 v3(±10% · 4번 추측) 채점 함수가 적용됐는지 확인합니다.
  const protocol = await fetch(`${LEADERBOARD_CONFIG.url.replace(/\/+$/, '')}/rest/v1/rpc/get_ranking_protocol`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { apikey: LEADERBOARD_CONFIG.anonKey, Authorization: `Bearer ${LEADERBOARD_CONFIG.anonKey}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!protocol.ok || Number(await protocol.json()) < RULES_VERSION) throw Error('운영 랭킹에 새 게임 규칙이 적용되지 않았습니다. supabase/rules-v3.sql을 적용한 후 다시 검사하세요.');
  console.log(`Ranking bank ready: ${bank.bankVersion}, ${bank.questions.length} questions, rules v${RULES_VERSION}.`);
}
