// Read-only deployment gate. Does not submit a score or change the live DB.
import { readJSON, projectRoot, answerFingerprint } from './curation.mjs';
import { LEADERBOARD_CONFIG } from '../dist/leaderboard-config.js';
import { isConfigured } from '../dist/leaderboard.js';
import path from 'node:path';
import { kstDate } from './procurement-api.mjs';
const bank = await readJSON(path.join(projectRoot, 'dist/data.json'));
if(bank.questions.some(q=>!Number.isFinite(Date.parse(q.checkedAt)) || Date.now()-Date.parse(q.checkedAt)>86400000 || q.contractEnd<kstDate()))throw Error('24시간 이내에 확인하지 않은 품목이 있습니다. 선별실에서 검증 후 게임에 반영을 먼저 실행해 주세요.');
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
  console.log(`Ranking bank ready: ${bank.bankVersion}, ${bank.questions.length} questions.`);
}
