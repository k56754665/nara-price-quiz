import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectRoot, loadCatalog, readJSON, writeJSON, updateDecision, excludeUnreviewed, buildBank, answerFingerprint } from './curation.mjs';
import { familyOf } from './discovery-policy.mjs';
import { scoreGuess, QUESTION_COUNTS, MAX_GUESS } from '../dist/engine.js';
import { normalizeNickname } from '../dist/leaderboard.js';
import { createFamiliarSourceOperations } from './familiar-collection.mjs';
import { createSourceJobs } from './source-jobs.mjs';
import { comparisonContext, publicComparison } from './product-comparison.mjs';
import { chooseComparisonCandidate } from './comparison-choice.mjs';
import { getDiscoveryStatus } from './discovery-status.mjs';
import { COLLECTION_PRESETS,collectionPreset } from './collection-presets.mjs';
import { candidateQuality,assertApprovalQuality } from './candidate-quality.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.sql': 'text/plain; charset=utf-8' };
function safePath(root, relative) {
  const target = path.resolve(root, relative), rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Forbidden');
  return target;
}
async function bodyJSON(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 100_000) throw Error('요청이 너무 큽니다.'); }
  return JSON.parse(data);
}
export function calculatePreviewScore(bank, input, protocol = 2) {
  if (input.p_time_limit !== 0) throw Error('invalid_mode');
  if (typeof input.p_client_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.p_client_id)) throw Error('invalid_client');
  if (!normalizeNickname(input.p_nickname)) throw Error('invalid_nickname');
  if (input.p_question_set !== (protocol === 2 ? bank.bankVersion : bank.referenceDate)) throw Error('unknown_question_set');
  if (!Array.isArray(input.p_attempts) || !QUESTION_COUNTS.includes(input.p_attempts.length) || input.p_attempts.length > bank.questions.length) throw Error('invalid_attempts');
  const seen = new Set(); let total = 0, perfect = 0;
  for (const [i, row] of input.p_attempts.entries()) {
    const q = protocol === 2 ? bank.questions.find(q => q.id === row?.question_id) : bank.questions[i];
    const attempts = protocol === 2 ? row?.attempts : row;
    if (!q || seen.has(q.id) || !Array.isArray(attempts) || ![1,2].includes(attempts.length) || attempts.some(g => !Number.isSafeInteger(g) || g <= 0 || g > MAX_GUESS)) throw Error('invalid_attempts');
    seen.add(q.id);
    if ((attempts.length === 1) !== (attempts[0] === q.answer)) throw Error('invalid_attempts');
    total += scoreGuess(attempts.at(-1), q.answer);
    if (attempts.at(-1) === q.answer) perfect++;
  }
  return { total_score: total, perfect_count: perfect, question_count: input.p_attempts.length };
}

export function createLocalServer({ root = projectRoot, admin = false, sourceOperations = createFamiliarSourceOperations(), comparisonImageReader } = {}) {
  const csrf = randomUUID();
  const sourceJobs=createSourceJobs(sourceOperations,root);
  let mutation = Promise.resolve();
  const exclusive = fn => { const result = mutation.then(fn); mutation = result.catch(() => {}); return result; };
  const server = http.createServer(async (req, res) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
      res.end(type.startsWith('application/json') && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
    };
    try {
      const expectedHost = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== expectedHost && req.headers.host !== `localhost:${server.address().port}`) return send(403, { message: 'Forbidden host' });
      const pathname = decodeURIComponent(new URL(req.url, `http://${expectedHost}`).pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.method !== 'POST' || req.headers.origin && ![`http://${expectedHost}`, `http://localhost:${server.address().port}`].includes(req.headers.origin)) return send(403, { message: 'Forbidden origin' });
        if (!String(req.headers['content-type']).startsWith('application/json')) return send(415, { message: 'JSON only' });
      }
      if (pathname === '/leaderboard-config.js') return send(200, `export const LEADERBOARD_CONFIG = { url: location.origin, anonKey: 'local-preview-only-no-production-key', preview: true, curator: ${admin} };`, mime['.js']);
      if (pathname.startsWith('/rest/v1/rpc/')) {
        if (req.method !== 'POST') return send(405, { message: 'Method not allowed' });
        return await exclusive(async () => {
          const input = await bodyJSON(req), storage = path.join(root, '.artifacts/preview-scores.json');
          let scores = []; try { scores = await readJSON(storage); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          const bank = await readJSON(path.join(root, 'dist/data.json'));
          const name = pathname.split('/').at(-1);
          if (name === 'get_quiz_bank_status') return send(200, [{ question_count: input.p_question_set === bank.bankVersion ? bank.questions.length : 0, answer_fingerprint: answerFingerprint(bank) }]);
          const ranked = set => {
            const rows = scores.filter(r => r.question_set === set).sort((a,b) => b.total_score-a.total_score || b.perfect_count-a.perfect_count || a.created_at.localeCompare(b.created_at));
            return rows.map(r => ({ ...r, rank: 1 + rows.filter(s => s.total_score > r.total_score || s.total_score === r.total_score && s.perfect_count > r.perfect_count).length }));
          };
          if (name === 'get_leaderboard') return send(200, ranked(input.p_question_set).slice(0, Math.min(50, Math.max(1, input.p_limit || 20))));
          if (!['submit_score', 'submit_score_v2'].includes(name)) return send(404, { code: 'PGRST202', message: 'Unknown RPC' });
          const protocol = name === 'submit_score_v2' ? 2 : 1;
          let selectedBank = protocol === 1 ? await readJSON(path.join(root, 'dist/legacy-data.json')) : bank;
          if (protocol === 2 && input.p_question_set !== bank.bankVersion && /^curated-[a-f0-9]{16}$/.test(input.p_question_set)) {
            try { selectedBank = await readJSON(path.join(root, '.artifacts/releases', `${input.p_question_set}.json`)); } catch {}
          }
          const result = calculatePreviewScore(selectedBank, input, protocol);
          if (scores.some(r => r.question_set === input.p_question_set && r.client_id === input.p_client_id)) throw Error('already_submitted');
          const entry = { ...result, question_set: input.p_question_set, client_id: input.p_client_id, nickname: normalizeNickname(input.p_nickname), created_at: new Date().toISOString() };
          scores.push(entry); await writeJSON(storage, scores);
          return send(200, [{ rank: ranked(input.p_question_set).find(r => r.client_id === input.p_client_id).rank, ...result }]);
        });
      }
      if (pathname.startsWith('/api/')) {
        if (!admin) return send(404, { message: 'Not found' });
        if (pathname === '/api/catalog' && req.method === 'GET') {
          const { catalog, review, bank } = await loadCatalog(root);
          const discoveryStatus=await getDiscoveryStatus(root,catalog,review);
          let lastCollection=null;
          try {const result=await readJSON(path.join(root,'.artifacts/familiar-last-collection.json'));lastCollection={added:result.added,newKinds:result.newKinds,existingKindModels:result.existingKindModels,requests:result.requests,requestLimit:result.requestLimit,receivedRows:result.receivedRows,cacheHits:result.cacheHits,remainingSearches:result.remainingSearches,stopReason:result.stopReason};}
          catch(error){if(error.code!=='ENOENT')throw error;}
          const comparisons={};
          if(catalog.candidates.some(c=>c.discoveryTopicId)) {
            const context=await comparisonContext(root,catalog,review);
            for(const candidate of catalog.candidates)if(candidate.discoveryTopicId && review.decisions[candidate.id]?.status!=='excluded')comparisons[candidate.id]=publicComparison(context.forCandidate(candidate));
          }
          const quality=Object.fromEntries(catalog.candidates.filter(c=>review.decisions[c.id]?.status!=='excluded').map(c=>[c.id,candidateQuality(c,comparisons[c.id])]));
          let pendingChanges=true;try{pendingChanges=buildBank(catalog,review).bankVersion!==bank.bankVersion;}catch{}
          return send(200, { candidates: catalog.candidates.map(c=>({...c,discoveryFamily:familyOf(c)})), comparisons, quality, lastCollection, discoveryStatus, collectionPresets:COLLECTION_PRESETS, referenceDate: catalog.base.referenceDate, lastCollectedAt:catalog.lastCollectedAt,lastRefreshedAt:catalog.lastRefreshedAt,activeJob:sourceJobs.active(),pendingChanges,review, applied: { bankVersion: bank.bankVersion, ids: bank.questions.map(q => q.id) }, csrf });
        }
        if(pathname.startsWith('/api/jobs/') && req.method==='GET') { const job=sourceJobs.get(pathname.split('/').at(-1));return send(job?200:404,job||{message:'작업 정보를 찾지 못했습니다.'}); }
        if (pathname === '/api/release.sql' && req.method === 'GET') return send(200, await readFile(path.join(root, 'supabase/curated-release.sql'), 'utf8'), mime['.sql']);
        if (req.headers['x-curation-token'] !== csrf) return send(403, { message: '선별 화면을 새로고침해 주세요.' });
        if (req.method !== 'POST') return send(405, { message: 'Method not allowed' });
        if(sourceJobs.active())return send(409,{message:'수집·갱신 작업이 진행 중입니다. 완료 후 다시 선택해 주세요.'});
        return await exclusive(async () => {
          if(sourceJobs.active())throw Error('수집·갱신 작업이 진행 중입니다. 완료 후 다시 선택해 주세요.');
          const input = await bodyJSON(req);
          if(pathname==='/api/exclude-unreviewed') {
            const {catalog,review}=await loadCatalog(root);
            const result=excludeUnreviewed(review,catalog,input.revision);
            if(result.ids.length) {
              await writeJSON(path.join(root,'.artifacts/review-backups',`${Date.now()}.json`),review);
              await writeJSON(path.join(root,'content/review.json'),result.review);
            }
            return send(200,{excludedCount:result.ids.length,review:result.review});
          }
          if (pathname === '/api/review') {
            const { catalog, review } = await loadCatalog(root);
            const candidate=catalog.candidates.find(c=>c.id===input.id);
            if(input.status==='approved' && candidate) {
              const context=candidate.discoveryTopicId?await comparisonContext(root,catalog,review):null,comparison=context?.forCandidate(candidate);
              assertApprovalQuality(candidate,comparison,input.note);
            }
            const updated = updateDecision(review, catalog, input);
            await writeJSON(path.join(root, 'content/review.json'), updated);
            return send(200, updated);
          }
          if(pathname==='/api/review-batch') {
            const {catalog,review}=await loadCatalog(root);
            if(input.revision!==review.revision)throw Error('선택 내용이 바뀌었습니다. 새로고침 후 다시 선택해 주세요.');
            if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>100||new Set(input.ids).size!==input.ids.length||!['approved','excluded','held'].includes(input.status))throw Error('한 번에 선택한 후보 1~100개를 처리할 수 있습니다.');
            const context=input.status==='approved'?await comparisonContext(root,catalog,review):null;
            let updated=review;
            for(const id of input.ids) {
              const candidate=catalog.candidates.find(c=>c.id===id);
              if(!candidate || review.decisions[id]?.status!=='unreviewed')throw Error('일괄 처리는 미검토 후보에서만 가능합니다.');
              const note=review.decisions[id].note;
              if(context)assertApprovalQuality(candidate,context.forCandidate(candidate),note);
              updated=updateDecision(updated,catalog,{id,status:input.status,note,revision:updated.revision});
            }
            // Validate the whole selection before the single commit.
            await writeJSON(path.join(root,'.artifacts/review-backups',`batch-${Date.now()}.json`),review);
            await writeJSON(path.join(root,'content/review.json'),updated);
            return send(200,updated);
          }
          if(pathname==='/api/comparison-choice')return send(200,await chooseComparisonCandidate(root,input,{imageReader:comparisonImageReader}));
          if (['/api/collect','/api/refresh','/api/apply'].includes(pathname)) {
            const { catalog,review } = await loadCatalog(root);
            if (input.revision !== review.revision) throw Error('선택이 바뀌었습니다. 새로고침 후 다시 반영해 주세요.');
            if(pathname==='/api/collect') {
              const status=await getDiscoveryStatus(root,catalog,review);
              if(!status.canCollect)throw Error(status.message+' 추가 API는 호출하지 않았습니다.');
            }
            const collection=pathname==='/api/collect'&&input.collectionPreset!==undefined?collectionPreset(input.collectionPreset):undefined;
            return send(202, sourceJobs.start(pathname.split('/').at(-1),collection));
          }
          return send(404, { message: 'Not found' });
        });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return send(405, { message: 'Method not allowed' });
      let base = path.join(root, 'dist'), relative = pathname.slice(1) || 'index.html';
      if (pathname === '/admin' || pathname.startsWith('/admin/')) {
        if (!admin) return send(404, { message: 'Not found' });
        base = path.join(root, 'tools/curator'); relative = pathname.replace(/^\/admin\/?/, '') || 'index.html';
      }
      if (pathname.startsWith('/candidate-images/')) {
        if (!admin) return send(404, { message: 'Not found' });
        base = path.join(root, 'content/images'); relative = pathname.slice('/candidate-images/'.length);
      }
      const requested = safePath(base, relative);
      send(200, await readFile(requested), mime[path.extname(requested).toLowerCase()] || 'application/octet-stream');
    } catch (error) {
      if (!res.headersSent) send(error.code === 'ENOENT' ? 404 : 400, { message: error.code === 'ENOENT' ? 'Not found' : error.message });
      else res.end();
    }
  });
  return server;
}
export function startLocalServer(admin = false) {
  const port = Number(process.env.PORT || (admin ? 4174 : 4173)), server = createLocalServer({ admin });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Game preview: http://127.0.0.1:${port}/`);
    if (admin) console.log(`Curation: http://127.0.0.1:${port}/admin/`);
    console.log('Local test leaderboard only. Production Supabase is not used.');
  });
  for (const event of ['SIGINT','SIGTERM']) process.on(event, () => server.close(() => process.exit(0)));
  return server;
}
