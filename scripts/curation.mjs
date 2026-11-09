import { readFile, writeFile, rename, mkdir, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kstDate } from './procurement-api.mjs';
import { familiesFor } from './discovery-policy.mjs';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const digest = value => createHash('sha256').update(value).digest('hex');
export const answerFingerprint = bank => createHash('md5').update([...bank.questions].sort((a,b)=>a.id.localeCompare(b.id)).map(q=>`${q.id}:${q.answer}`).join(',')).digest('hex');
export async function readJSON(file) { return JSON.parse(await readFile(file, 'utf8')); }
export async function writeJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, file);
}
export async function loadCatalog(root = projectRoot) {
  const catalog = await readJSON(path.join(root, 'content/candidates.json'));
  const review = await readJSON(path.join(root, 'content/review.json'));
  const bank = await readJSON(path.join(root, 'dist/data.json'));
  for (const c of catalog.candidates) if (!review.decisions[c.id]) review.decisions[c.id]={status:'unreviewed',note:''};
  return { catalog, review, bank };
}
export function updateDecision(review, catalog, { id, status, note = '', revision }) {
  if (revision !== review.revision) throw Error('다른 화면에서 선택이 바뀌었습니다. 새로고침 후 다시 선택해 주세요.');
  const candidate=catalog.candidates.find(c=>c.id===id);
  if (!candidate || !['unreviewed', 'approved', 'held', 'excluded'].includes(status) || typeof note !== 'string' || note.length > 500) throw Error('선택 내용을 확인해 주세요.');
  if(status==='approved' && candidate.discoveryTopicId && catalog.candidates.some(c=>c.id!==id && c.discoveryTopicId===candidate.discoveryTopicId && review.decisions[c.id]?.status==='approved'))throw Error('같은 종류의 승인 대표가 이미 있습니다. 기존 대표를 보류로 바꾼 뒤 새 상품을 승인해 주세요.');
  const excludedProducts={...(review.excludedProducts||{})};
  if(status==='excluded')excludedProducts[candidate.productId]={note,excludedAt:new Date().toISOString()};
  else delete excludedProducts[candidate.productId];
  return { ...review, excludedProducts, seenFamilies:familiesFor(catalog,review), revision: review.revision + 1, decisions: { ...review.decisions, [id]: { status, note } } };
}

export function excludeUnreviewed(review,catalog,revision) {
  if(revision!==review.revision)throw Error('선택 내용이 바뀌었습니다. 새로고침 후 다시 시도해 주세요.');
  const decisions={...review.decisions},excludedProducts={...(review.excludedProducts||{})};
  const ids=[],excludedAt=new Date().toISOString();
  for(const c of catalog.candidates)if(decisions[c.id]?.status==='unreviewed') {
    decisions[c.id]={...decisions[c.id],status:'excluded'};
    excludedProducts[c.productId]={note:decisions[c.id].note || '검토 완료 후 미선택 항목 일괄 제외',excludedAt};ids.push(c.id);
  }
  return {review:{...review,decisions,excludedProducts,seenFamilies:familiesFor(catalog,review),revision:review.revision+(ids.length?1:0)},ids};
}
export function buildBank(catalog, review, { requireFresh=false, now=Date.now() } = {}) {
  const approved = catalog.candidates.filter(c => review.decisions[c.id]?.status === 'approved');
  const topics=approved.map(c=>c.discoveryTopicId).filter(Boolean);
  if(new Set(topics).size!==topics.length)throw Error('같은 종류의 새 비교 후보는 대표 1개만 승인할 수 있습니다.');
  if (approved.length < 3) throw Error('게임에는 승인된 항목이 최소 3개 필요합니다. 기존 게임은 그대로 유지됩니다.');
  const questions = approved.map((c, i) => {
    if(requireFresh && (c.freshness?.status!=='verified' || !Number.isFinite(Date.parse(c.checkedAt)) || now-Date.parse(c.checkedAt)>86400000 || Date.parse(c.checkedAt)>now+60000 || c.contractStart>kstDate(now) || c.contractEnd<kstDate(now))) throw Error(`${c.id} ${c.title}: 최신 계약 정보를 다시 확인해 주세요. 기존 게임은 유지됩니다.`);
    // The initial shortlist's recommendation is not a veto on human approval.
    // Discount-bearing records can use their verified contract price, with the
    // price basis shown before guessing. Unverified records still cannot publish.
    const verifiedContractBasis = c.pricePolicy?.basis === 'registered_contract_unit_price'
      && c.pricePolicy.contractPriceVerified === true && Boolean(c.pricePolicy.notice);
    if (!c.eligible && !verifiedContractBasis) throw Error(`${c.id} ${c.title}: 등록 계약단가와 출제 기준을 먼저 확인해 주세요.`);
    if (!Number.isSafeInteger(c.answer) || c.answer <= 0 || !c.unit || !c.delivery || !c.specification || !c.image.sha256) throw Error(`${c.id}: 가격·단위·규격·이미지 확인이 필요합니다.`);
    const { eligible, eligibilityReason, interestReason, evidence, freshness, lastChanges, sourceChangedAt, discoveryFamily, classification, discoveryScore, discoveryTopicId, discoverySource, manufacturer, selectionSupersededBy, comparisonBaseline, ...question } = c;
    return { ...question, order: i + 1 };
  });
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw Error('문제 ID가 중복됩니다.');
  const core = { ...catalog.base, version: 3, questions };
  // Rechecking an unchanged price within the same reference day should not reset
  // the ranking season just because a verification timestamp advanced.
  const semantic={...core,questions:questions.map(({checkedAt,image,...q})=>({...q,image:Object.fromEntries(Object.entries(image).filter(([key])=>key!=='retrievedAt'))}))};
  return { ...core, bankVersion: `curated-${digest(JSON.stringify(semantic)).slice(0, 16)}`, rankingProtocol: 2 };
}
export function answerSeed(bank) {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  return `\n-- Generated from the approved bank. Do not edit answers by hand.\ninsert into public.quiz_answers_v2 (question_set, question_id, answer) values\n${bank.questions.map(q => `  (${quote(bank.bankVersion)}, ${quote(q.id)}, ${q.answer})`).join(',\n')}\non conflict (question_set, question_id) do nothing;\n\ndo $$ begin\n  if not exists (select 1 from public.get_quiz_bank_status(${quote(bank.bankVersion)}) where question_count = ${bank.questions.length} and answer_fingerprint = '${answerFingerprint(bank)}') then\n    raise exception 'question bank mismatch';\n  end if;\nend; $$;\n`;
}
export async function publishBank(root = projectRoot, options = {}) {
  const { catalog, review, bank: before } = await loadCatalog(root);
  const bank = buildBank(catalog, review, options);
  // Verify every asset before changing the playable bank.
  for (const q of bank.questions) {
    const bytes = await readFile(path.join(root, 'content/images', path.basename(q.image.src)));
    if (digest(bytes) !== q.image.sha256) throw Error(`${q.id}: 이미지 체크섬이 다릅니다.`);
  }
  const migration = await readFile(path.join(root, 'supabase/curation-v2.sql'), 'utf8');
  for (const q of bank.questions) await copyFile(path.join(root, 'content/images', path.basename(q.image.src)), path.join(root, 'dist', q.image.src));
  await mkdir(path.join(root, '.artifacts/releases'), { recursive: true });
  await writeJSON(path.join(root, '.artifacts/releases', `${before.bankVersion || before.referenceDate}.json`), before);
  await writeFile(path.join(root, 'supabase/curated-release.sql'), 'begin;\n' + migration + answerSeed(bank) + '\ncommit;\n');
  await writeJSON(path.join(root, 'image-sources.json'), {
    reference_date: bank.referenceDate,
    bank_version: bank.bankVersion,
    source: '조사 당시 물품식별번호별 공식 API의 prdctImgUrl',
    images: bank.questions.map(q => ({ candidate_id: q.id, product_id: q.productId, specification: q.specification, ...q.image })),
  });
  // data.json is the final commit point. A failed validation never replaces it.
  await writeJSON(path.join(root, 'dist/data.json'), bank);
  return { bankVersion: bank.bankVersion, count: bank.questions.length, ids: bank.questions.map(q => q.id) };
}
