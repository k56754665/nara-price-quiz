// Offline report only: no network client, credentials, game publishing or review mutations.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { matchesFamiliarTopic } from './familiar-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
const [plan, catalog, review, bank] = await Promise.all([
  read('content/familiar-item-topics.json'), read('content/candidates.json'),
  read('content/review.json'), read('dist/data.json')
]);
const protectedFiles = ['content/candidates.json', 'content/review.json', 'dist/data.json'];
const digest = async file => createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
const before = await Promise.all(protectedFiles.map(digest));
assert.ok(plan.topics.length > 0);
assert.equal(new Set(plan.topics.map(t => t.id)).size, plan.topics.length);
assert.equal(new Set(plan.topics.map(t => t.name)).size, plan.topics.length);
assert.ok(plan.topics.every(t => plan.groups.some(group => group.id === t.group)));
for (const group of plan.groups) assert.equal(plan.topics.filter(t => t.group === group.id).length, group.count);

const squash = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const numeric = value => Number(String(value ?? '').replaceAll(',', ''));
const catalogByProduct = new Map(catalog.candidates.map(c => [String(c.productId), c]));
const records = new Map(), sourceFiles = new Set();
let occurrences = 0;
function addRecord(row, file, locator, checkedAt, normalized = false) {
  const productId = String(normalized ? row.productId : row.prdctIdntNo || '');
  const specification = normalized ? row.specification : row.prdctSpecNm;
  if (!productId || !specification) return;
  const current = catalogByProduct.get(productId);
  // A product rejected in the curator stays rejected even when found in old raw responses.
  const reviewStatus = current ? review.decisions[current.id]?.status || 'unreviewed'
    : review.excludedProducts?.[productId] ? 'excluded' : 'cached';
  const contractNumber = String(normalized ? row.contractNumber || '' : row.shopngCntrctNo || '');
  const contractLine = String(normalized ? row.contractLine ?? '' : row.shopngCntrctSno ?? '');
  const unit = String(normalized ? row.unit || '' : row.prdctUnit || '');
  const key = [productId, contractNumber, contractLine, unit].join('|');
  const price = numeric(normalized ? row.answer : row.cntrctPrceAmt);
  const occurrence = {
    productId, catalogId: current?.id || null, reviewStatus, specification,
    family: specification.split(',')[0].trim(), savedPrice: Number.isFinite(price) && price > 0 ? price : null,
    unit, delivery: normalized ? row.delivery : row.prdctDlvryCndtnNm || '',
    vat: normalized ? row.vat : row.vatAplDivNm || '', contractNumber, contractLine,
    contractStart: normalized ? row.contractStart : row.cntrctBgnDate || '',
    contractEnd: normalized ? row.contractEnd : row.cntrctEndDate || '',
    checkedAt: checkedAt || null, file, locator,
    freshnessStatus: current?.freshness?.status || null,
    inPublishedBank: current ? bank.questions.some(q => q.id === current.id) : false
  };
  let record = records.get(key);
  if (!record) {
    record = { ...occurrence, prices: new Set(), sources: [], normalized };
    records.set(key, record);
  } else if (normalized || !record.normalized && String(checkedAt || '') > String(record.checkedAt || '')) {
    Object.assign(record, occurrence, { normalized });
  }
  if (occurrence.savedPrice) record.prices.add(occurrence.savedPrice);
  if (!record.sources.some(s => s.file === file && s.locator === locator)) record.sources.push({ file, locator, checkedAt: checkedAt || null });
  sourceFiles.add(file); occurrences++;
}

const researchDir = path.resolve(root, '../research/sources');
const logs = new Map();
for (const file of ['category_query_log.json', 'extra_query_log.json', 'verification_log.json']) {
  try {
    const data = JSON.parse(await readFile(path.join(researchDir, file), 'utf8'));
    for (const row of Array.isArray(data) ? data : []) if (row.file) logs.set(path.basename(row.file), row);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// Read only actual saved response files. Swagger examples, credentials and contact fields are never exported.
const snapshotFiles = (await readdir(researchDir)).filter(file => /^(category_\d+|extra_\d+|verify_C\d+_.+|probe_.+|api_live_probe)\.json$/.test(file)).sort();
for (const file of snapshotFiles) {
  const data = JSON.parse(await readFile(path.join(researchDir, file), 'utf8'));
  const items = data.response?.body?.items;
  const rows = Array.isArray(items) ? items : Array.isArray(items?.item) ? items.item : items?.item ? [items.item] : [];
  rows.forEach((row, i) => addRecord(row, `../research/sources/${file}`, `response.body.items[${i}]`, logs.get(file)?.retrieved_at));
}
const state = await read('.artifacts/source-state.json');
for (const [source, value] of Object.entries(state.sources || {})) {
  for (const [i, item] of (value.buffer || []).entries()) {
    addRecord(item.row, '.artifacts/source-state.json', `sources[${JSON.stringify(source)}].buffer[${i}].row`, item.checkedAt);
  }
}
catalog.candidates.forEach((candidate, i) => addRecord(candidate, 'content/candidates.json', `candidates[${i}]`, candidate.checkedAt, true));
try {
  const familiarCache=await read('.artifacts/familiar-source-cache.json');
  for(const [key,entry] of Object.entries(familiarCache.queries || {}))for(const [i,row] of (entry.items || []).entries()) {
    addRecord(row,'.artifacts/familiar-source-cache.json',`queries[${JSON.stringify(key)}].items[${i}]`,entry.checkedAt);
  }
} catch(error) { if(error.code!=='ENOENT')throw error; }
const allRecords = [...records.values()];
const publicEvidence = record => {
  const { prices, sources, normalized, ...rest } = record;
  return { ...rest, savedPriceVariants: [...prices].sort((a,b) => a-b), sourceReferences: sources };
};
const statusOrder = { approved: 0, cached: 1, unreviewed: 2, held: 3, excluded: 4 };
const evidenceOrder = (a,b) => (statusOrder[a.reviewStatus] ?? 5) - (statusOrder[b.reviewStatus] ?? 5)
  || String(b.checkedAt || '').localeCompare(String(a.checkedAt || '')) || a.productId.localeCompare(b.productId);
function exactMatch(topic, record) {
  return matchesFamiliarTopic(topic,record);
}
// Evidence levels, not game approval actions.
const labels = { approved: '자료 확보 · 승인 있음', cached: '원자료 확보 · 미선별', held: '보류 자료만 있음', excluded: '제외 자료만 있음', partial: '유사 자료만 있음', missing: '추가 탐색 필요' };
const topics = plan.topics.map(topic => {
  const matches = allRecords.filter(record => exactMatch(topic, record)).sort(evidenceOrder);
  const partial = allRecords.filter(record => topic.partialFamilies?.some(f => squash(f) === squash(record.family)) && !exactMatch(topic, record)).sort(evidenceOrder);
  const counts = Object.fromEntries(['approved','cached','unreviewed','held','excluded'].map(status => [status, new Set(matches.filter(r => r.reviewStatus === status).map(r => r.productId)).size]));
  const status = counts.approved ? 'approved' : counts.cached || counts.unreviewed ? 'cached' : counts.held ? 'held' : matches.length ? 'excluded' : partial.length ? 'partial' : 'missing';
  const needsAdditionalSearch = !['approved','cached'].includes(status);
  const action = {
    approved: '저장된 승인 상품을 우선 활용. 실제 출제 전에 가격·계약·범위 검증은 별도 수행.',
    cached: '추가 API 호출보다 저장 원자료를 먼저 검토. 대표 1개를 골라도 자동 승인·적재하지 않음.',
    held: '보류 유지. 기존 조회 실패가 해소되기 전에는 출제하지 않음.',
    excluded: '제외 유지. 같은 종류의 다른 모델도 새 종류 수집에서는 자동 추천하지 않음.',
    partial: '유사 자료는 참고만 하고 목표 물건의 본체·완제품 근거를 추가 확보.',
    missing: '로컬 자료에서 일치 상품을 찾지 못함. 향후 탐색 대상이며 공식 등록 여부도 미확인.'
  }[status];
  const uniqueExamples = rows => [...new Map([...rows].reverse().map(r => [r.productId, r])).values()].sort(evidenceOrder);
  const samples = uniqueExamples(matches).slice(0,3).map(publicEvidence);
  const partialSamples = uniqueExamples(partial).slice(0,2).map(publicEvidence);
  const multipleContractPrices = uniqueExamples(matches).some(record =>
    new Set(matches.filter(r => r.productId === record.productId).flatMap(r => [...r.prices])).size > 1);
  return { ...topic, priority: topic.priority || 2, status, statusLabel: labels[status], needsAdditionalSearch,
    action, matchProductCounts: counts, exactProductCount: new Set(matches.map(r => r.productId)).size,
    exactContractRowCount: matches.length, multipleContractPrices, samples, partialSamples,
    alreadyPublishedCount: new Set(matches.filter(r => r.inPublishedBank).map(r => r.productId)).size
  };
});
// A model or contract row must never inflate two distinct object topics.
for (const record of allRecords) assert.ok(topics.filter(topic => exactMatch(topic, record)).length <= 1, `Overlapping types: ${record.specification}`);
const counts = Object.fromEntries(Object.keys(labels).map(status => [status, topics.filter(t => t.status === status).length]));
const catalogStatusCounts = catalog.candidates.reduce((out,c) => { const status=review.decisions[c.id]?.status || 'unreviewed';out[status]=(out[status] || 0)+1;return out; },{});
const savedDates = allRecords.map(r => r.checkedAt).filter(Boolean).sort();
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), mode: 'offline-local-files-only', apiCalls: 0,
  criterion: plan.criterion, rules: plan.rules,
  summary: { topicCount: topics.length, counts, locallyAvailableTypes: counts.approved + counts.cached,
    needsAdditionalSearchTypes: topics.filter(t => t.needsAdditionalSearch).length, priorityTypes: topics.filter(t => t.priority === 1).length },
  audit: { snapshotFilesScanned: snapshotFiles.length, filesWithRecords: sourceFiles.size, recordOccurrences: occurrences,
    uniqueContractRows: allRecords.length, uniqueProducts: new Set(allRecords.map(r => r.productId)).size,
    oldestKnownCheckedAt: savedDates[0], newestKnownCheckedAt: savedDates.at(-1),
    catalogCandidates: catalog.candidates.length, catalogStatusCounts, reviewRevision: review.revision,
    publishedBankVersion: bank.bankVersion, publishedQuestions: bank.questions.length,
    unchangedFileHashes: Object.fromEntries(protectedFiles.map((file,i) => [file, before[i]])),
    sourceFiles: [...sourceFiles].sort(),
    limitations: ['최신 가격·판매·계약 상태는 이번 작업에서 확인하지 않았다.', '자료 없음은 로컬 저장 범위 안에서의 결과이며, 나라장터에 상품이 없다는 뜻이 아니다.', '원자료 확보는 사진 확인·출제 범위 확정·사용자 승인·게임 적재를 완료했다는 뜻이 아니다.', '기존 제외 상품은 원자료에서도 제외로 집계하며 자동 복원하지 않는다.']
  }, groups: plan.groups, topics
};
await mkdir(path.join(root,'docs'), { recursive: true });
await writeFile(path.join(root,'docs/familiar-items-100.json'), JSON.stringify(report,null,2)+'\n');

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const money = value => value ? `${value.toLocaleString('ko-KR')}원` : '가격 미기록';
const shortStatus = { approved:'승인', excluded:'제외', held:'보류', unreviewed:'미검토', cached:'원자료' };
function evidenceCard(record) {
  return `<div class="evidence"><b>${esc(record.catalogId || record.productId)} · ${shortStatus[record.reviewStatus]}</b><p>${esc(record.specification)}</p><p>저장 가격 ${money(record.savedPrice)} / ${esc(record.unit || '단위 미기록')} · ${esc(record.vat || '부가세 미기록')} · 조회 ${esc(record.checkedAt || '시각 미기록')}</p>${record.savedPriceVariants.length > 1 ? '<p class="warning">동일 식별·계약행에 서로 다른 저장 가격이 있습니다. 대표 가격을 그대로 출제하지 마세요.</p>':''}<code>${esc(record.file)} → ${esc(record.locator)}</code></div>`;
}
const latestBatch=topics.map(topic=>topic.addedBatch).filter(Boolean).at(-1) || '';
const latestBatchCount=topics.filter(topic=>topic.addedBatch===latestBatch).length;
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'">
<title>익숙한 물건 ${topics.length}종 · 저장 자료 대조</title><style>
:root{font-family:system-ui,-apple-system,'Malgun Gothic',sans-serif;color:#1f3041;background:#f6f5f0;line-height:1.6}*{box-sizing:border-box}body{margin:0}main{max-width:1160px;margin:auto;padding:36px 24px 70px}header{border-bottom:2px solid #183e43;padding-bottom:24px}.eyebrow{color:#376f64;font-size:13px;font-weight:800;letter-spacing:.06em}h1{font-size:clamp(25px,4vw,40px);line-height:1.3;letter-spacing:-.04em;margin:12px 0}h2{font-size:22px;letter-spacing:-.025em}p{margin:8px 0}.intro{max-width:840px}.notice{padding:16px 18px;border-left:4px solid #b99137;background:#fff8e7;margin:20px 0;border-radius:4px}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0}.metric{background:#fff;border:1px solid #dcded5;border-radius:12px;padding:16px}.metric strong{display:block;font-size:32px;line-height:1.3;color:#174d40}.metric span{font-size:14px}.legend{display:flex;gap:8px;flex-wrap:wrap}.badge{display:inline-block;border-radius:20px;padding:4px 10px;font-size:12px;font-weight:700;background:#e5e9ee;color:#38485a}.approved{background:#dbefdf;color:#245631}.cached{background:#e0eafb;color:#234779}.excluded{background:#eee4e1;color:#704b41}.held{background:#f5e9c7;color:#73530b}.partial{background:#efe4f4;color:#634176}.missing{background:#eceeeb;color:#545e56}.filters{position:sticky;top:0;z-index:1;background:#f6f5f0f5;padding:16px 0;border-bottom:1px solid #dedfd8;display:flex;gap:10px;flex-wrap:wrap}input,select{font:inherit;border:1px solid #cbd1c9;background:#fff;color:inherit;border-radius:8px;padding:10px;max-width:100%}input{flex:1;min-width:190px}select{flex:0 1 auto}.small{font-size:13px;color:#657067}.count{font-size:14px;margin:12px 0}.topic{background:#fff;border:1px solid #dcded5;border-radius:12px;margin:12px 0;padding:18px 20px;break-inside:avoid}.topline{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.topic h3{font-size:19px;margin:8px 0}.number{font-variant-numeric:tabular-nums;font-size:12px;color:#69776b}.hook{font-weight:600}.scope{font-size:14px;color:#4c625b}.note{color:#795527;font-size:14px}.action{font-size:14px;border-top:1px solid #edf0e9;padding-top:10px;margin-top:12px}summary{cursor:pointer;color:#365c74;font-size:14px}details{margin-top:12px}.evidence{padding:12px 14px;background:#f3f6f2;border-radius:7px;margin:10px 0;font-size:13px;overflow-wrap:anywhere}.evidence p{margin:5px 0}code{font-size:11px;overflow-wrap:anywhere}.warning{color:#8a4b22}.priority{color:#916414;font-size:12px;font-weight:700}.priority-list{columns:2;column-gap:24px;padding-left:24px;font-size:14px}.priority-list li{break-inside:avoid;margin:5px 0}.empty{padding:28px;text-align:center}.audit{border-top:1px solid #ccd3c7;margin-top:32px;padding-top:16px;overflow-wrap:anywhere}a{color:#2d6570}button{font:inherit}.topic[hidden],section[hidden]{display:none!important}@media(max-width:650px){main{padding:24px 14px 50px}.summary{grid-template-columns:repeat(2,1fr)}.metric{padding:12px}.metric strong{font-size:27px}.filters{position:static}input,select{width:100%;flex:1 1 100%}.topic{padding:16px}.priority-list{columns:1}}@media print{.filters{display:none}.topic{box-shadow:none}main{padding:0}.summary{grid-template-columns:repeat(4,1fr)}}
</style></head><body><main>
<header><div class="eyebrow">OFFLINE RESEARCH · API 호출 0회</div><h1>익숙한 물건, 궁금한 가격.<br>후보 물건 종류 ${topics.length}개</h1><p class="intro">${esc(plan.criterion)}</p><p class="small">작성 ${esc(report.generatedAt)} · 모델 수가 아닌 물건 종류 수 · ${plan.groups.length}개 생활 장면</p></header>
<div class="notice"><strong>저장 자료를 대조한 탐색 계획입니다.</strong><br>가격은 저장 당시 값이며 최신 확인을 하지 않았습니다. 기존 승인·보류·제외와 게임 데이터는 변경하지 않았습니다. 이 화면에는 API 호출·승인·게임 반영 기능이 없습니다.</div>
<div class="summary"><div class="metric"><strong>${topics.length}</strong><span>선정한 물건 종류</span></div><div class="metric"><strong>${counts.approved}</strong><span>일치하는 승인 자료 있음</span></div><div class="metric"><strong>${counts.cached}</strong><span>저장 원자료 먼저 검토</span></div><div class="metric"><strong>${report.summary.needsAdditionalSearchTypes}</strong><span>추가 탐색·확인 필요</span></div></div>
<div class="legend">${Object.entries(labels).map(([status,label])=>`<span class="badge ${status}">${label} ${counts[status]}</span>`).join('')}</div>
<p class="small">자료 확보 ${report.summary.locallyAvailableTypes}종 = 승인 자료 ${counts.approved}종 + 미선별 원자료 ${counts.cached}종. 추가 탐색·확인 ${report.summary.needsAdditionalSearchTypes}종 = 제외 자료만 ${counts.excluded}종 + 보류 자료만 ${counts.held}종 + 유사 자료만 ${counts.partial}종 + 미확보 ${counts.missing}종.</p>
<details><summary>먼저 찾아볼 ${report.summary.priorityTypes}종 — 사용자가 고개를 끄덕일 장면부터</summary><p class="small">향후 탐색 우선순위 제안입니다. 이번에는 호출하지 않았고, 검색어가 공식 분류명인지도 아직 확인하지 않았습니다.</p><ol class="priority-list">${topics.filter(t=>t.priority===1).map(t=>`<li>${esc(t.name)} <span class="small">(${esc(t.statusLabel)})</span></li>`).join('')}</ol></details>
<div class="filters"><input id="search" type="search" placeholder="물건·생활 장면·검색어 찾기" aria-label="물건 검색"><select id="group" aria-label="생활 장면"><option value="">모든 생활 장면</option>${plan.groups.map(g=>`<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('')}</select><select id="status" aria-label="확보 상태"><option value="">모든 확보 상태</option><option value="available">이미 확보한 자료</option><option value="needed">추가 탐색·확인 필요</option>${Object.entries(labels).map(([status,label])=>`<option value="${status}">${label}</option>`).join('')}</select><select id="priority" aria-label="탐색 우선순위"><option value="">전체 ${topics.length}종</option><option value="1">우선 탐색 ${report.summary.priorityTypes}종</option></select><select id="batch" aria-label="검색 목록 추가분"><option value="">전체 등록 목록</option>${latestBatch?`<option value="${esc(latestBatch)}">이번 추가 ${latestBatchCount}종</option>`:''}</select></div>
<p id="count" class="count" aria-live="polite">${topics.length} / ${topics.length}종 표시</p>
${plan.groups.map(group=>`<section data-group="${group.id}"><h2>${esc(group.name)} <span class="small">${group.count}종</span></h2>${topics.filter(t=>t.group===group.id).map(t=>`<article class="topic" data-status="${t.status}" data-needed="${t.needsAdditionalSearch}" data-priority="${t.priority}" data-batch="${esc(t.addedBatch || '')}" data-search="${esc([t.name,t.hook,t.scope,...t.keywords].join(' '))}"><div class="topline"><span class="number">${t.id} · ${esc(group.name)}</span><span class="badge ${t.status}">${esc(t.statusLabel)}</span></div><h3>${esc(t.name)} ${t.priority===1?'<span class="priority">우선 탐색</span>':''}</h3><p class="hook">${esc(t.hook)}</p><p class="scope">출제 범위: ${esc(t.scope)}</p>${t.note?`<p class="note">${esc(t.note)}</p>`:''}<p class="action">${esc(t.action)}</p><details><summary>대조 근거와 향후 검색어${t.exactProductCount?` · 일치 상품 ${t.exactProductCount}개`:''}</summary><p class="small">검색어 초안: ${t.keywords.map(esc).join(' / ')}</p>${t.samples.length?`<p class="small">상태별 고유 상품: 승인 ${t.matchProductCounts.approved} · 원자료/미검토 ${t.matchProductCounts.cached+t.matchProductCounts.unreviewed} · 보류 ${t.matchProductCounts.held} · 제외 ${t.matchProductCounts.excluded}. 대표 근거 최대 3개 표시.</p>${t.samples.map(evidenceCard).join('')}`:'<p class="small">저장 범위에서 목표 종류와 일치한 상품을 찾지 못했습니다.</p>'}${t.partialSamples.length?`<p class="small">아래는 확보 수에 포함하지 않은 유사 자료입니다.</p>${t.partialSamples.map(evidenceCard).join('')}`:''}</details></article>`).join('')}</section>`).join('')}
<p id="empty" class="empty" hidden>조건에 맞는 물건이 없습니다.</p>
<footer class="audit"><h2>자료 대조 범위</h2><p>저장 응답 파일 ${report.audit.snapshotFilesScanned}개, 수집 대기 버퍼, 현재 선별 후보 ${catalog.candidates.length}개를 대조했습니다. 중복 제거 후 상품 ${report.audit.uniqueProducts}개, 계약·단위별 행 ${report.audit.uniqueContractRows}개입니다.</p><p class="small">현재 선별: 승인 ${catalogStatusCounts.approved||0}개 / 보류 ${catalogStatusCounts.held||0}개 / 제외 ${catalogStatusCounts.excluded||0}개 / 미검토 ${catalogStatusCounts.unreviewed||0}개. 승인 상품 수와 이 보고서의 물건 종류 수는 다릅니다.</p><p class="small">검토에서 제외한 조합놀이대·상업용 식기세척기·제설제 등의 기존 승인 상태도 그대로 유지했습니다. 이번 목록에서 빠졌다는 이유로 기존 승인을 취소하지 않았습니다.</p><p class="small">구조화 결과: docs/familiar-items-100.json · 종류·매칭 기준: content/familiar-item-topics.json · 재생성: node scripts/plan-familiar-items.mjs (로컬 파일만 읽음)</p></footer>
</main><script>
const search=document.querySelector('#search'),group=document.querySelector('#group'),status=document.querySelector('#status'),priority=document.querySelector('#priority'),batch=document.querySelector('#batch');
function filter(){const query=search.value.normalize('NFKC').replace(/\\s+/g,'').toLowerCase();let shown=0;for(const section of document.querySelectorAll('section[data-group]')){let sectionShown=0;for(const card of section.querySelectorAll('.topic')){const text=card.dataset.search.normalize('NFKC').replace(/\\s+/g,'').toLowerCase();const statusMatches=!status.value||(status.value==='available'?card.dataset.needed==='false':status.value==='needed'?card.dataset.needed==='true':status.value===card.dataset.status);card.hidden=!!(batch.value&&batch.value!==card.dataset.batch||group.value&&group.value!==section.dataset.group||!statusMatches||priority.value&&priority.value!==card.dataset.priority||query&&!text.includes(query));if(!card.hidden){shown++;sectionShown++;}}section.hidden=sectionShown===0;}document.querySelector('#count').textContent=shown+' / ${topics.length}종 표시';document.querySelector('#empty').hidden=shown!==0;}
for(const input of [search,group,status,priority,batch])input.addEventListener('input',filter);
const requestedBatch=new URLSearchParams(location.search).get('batch');if([...batch.options].some(option=>option.value===requestedBatch))batch.value=requestedBatch;filter();
</script></body></html>\n`;
await writeFile(path.join(root,'tools/curator/familiar-items.html'), html);
assert.deepEqual(await Promise.all(protectedFiles.map(digest)), before, 'Candidate/review/game data changed during offline report');
console.log(JSON.stringify({ ...report.summary, audit: { snapshotFiles: snapshotFiles.length, uniqueProducts: report.audit.uniqueProducts, uniqueContractRows: allRecords.length, catalogStatusCounts }, files: ['content/familiar-item-topics.json','docs/familiar-items-100.json','tools/curator/familiar-items.html'], apiCalls: 0 },null,2));
