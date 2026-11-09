const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const labels = {all:'선별 대상',unreviewed:'미검토',approved:'승인',held:'보류',excluded:'제외'};
const filterLabels={ready:'먼저 볼 후보',unreviewed:'미검토 전체',needs:'확인 필요',approved:'승인',held:'보류',all:'선별 대상'};
const dateText = value => { const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date):'확인 필요'; };
let model,filter='all',busy=false,comparisonCandidateId=null;
let visibleLimit=24,saveQueue=Promise.resolve();
const selectedIds=new Set(),pendingIds=new Set(),draftNotes=new Map(),noteTimers=new Map();
let selectedCollectionPreset='standard';
try {selectedCollectionPreset=localStorage.getItem('curator-collection-preset') || 'standard';}catch{}
function notice(message,error=false) { $('#notice').textContent=message;$('#notice').classList.toggle('error',error); }
async function request(url,body) {
  const response=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json','X-Curation-Token':model.csrf},body:JSON.stringify(body)}:undefined);
  const result=await response.json();if(!response.ok)throw Error(result.message || '작업을 완료하지 못했습니다.');return result;
}
function counts() {
  const result=Object.fromEntries(Object.keys(labels).map(status=>[status,model.candidates.filter(c=>status==='all'?model.review.decisions[c.id].status!=='excluded':model.review.decisions[c.id].status===status).length]));
  result.ready=model.candidates.filter(c=>model.review.decisions[c.id].status==='unreviewed'&&model.quality?.[c.id]?.ready).length;
  result.needs=result.unreviewed-result.ready;return result;
}
function resetCardFilters() {
  for(const id of ['search','category','price'])$('#'+id).value='';
}
function finishReviewIfEmpty(message) {
  const count=counts();
  if(!['unreviewed','ready','needs'].includes(filter)||count[filter])return false;
  filter=count.unreviewed?'unreviewed':count.approved?'approved':count.held?'held':'all';resetCardFilters();
  notice(`${message} ${filterLabels[filter]} 목록을 표시합니다.`);
  return true;
}
function emptyCardsMessage() {
  const count=counts();
  const actions=`${count.approved?`<button type="button" data-empty-filter="approved">승인 ${count.approved}개 보기</button>`:''}${count.held?`<button type="button" data-empty-filter="held">보류 ${count.held}개 보기</button>`:''}<button type="button" data-empty-filter="all">선별 대상 전체 보기</button>`;
  if(filter==='unreviewed'&&!count.unreviewed)return `<div class="empty"><strong>미검토 후보를 모두 처리했어요.</strong><p>승인 ${count.approved}개 · 보류 ${count.held}개가 저장되어 있어요.</p><div class="empty-actions">${actions}</div></div>`;
  if($('#search').value.trim()||$('#category').value||$('#price').value)return `<div class="empty"><strong>현재 검색·분류·가격 조건에 맞는 물건이 없어요.</strong><p>${filterLabels[filter]}에는 ${count[filter]}개가 있어요. 필터를 초기화하면 다시 볼 수 있어요.</p><div class="empty-actions"><button type="button" data-reset-filters="true">검색·분류·가격 필터 초기화</button>${actions}</div></div>`;
  return `<div class="empty"><strong>${filter==='ready'?'비교 근거가 충분한 미검토 후보가 없어요. 확인 필요 목록을 살펴보거나 새 후보를 찾아 주세요.':`${filterLabels[filter]} 물건이 아직 없어요.`}</strong><div class="empty-actions">${actions}</div></div>`;
}
function render(updateCards=true) {
  const count=counts();$('#total').textContent=count.all;
  const locked=busy||pendingIds.size>0;
  $('#goal-label').textContent=`${count.approved} / 100개 승인`;
  $('#goal-meter').value=Math.min(100,count.approved);
  $('#goal-detail').textContent=count.approved<100?`100개까지 ${100-count.approved}개 · 먼저 볼 후보 ${count.ready}개`:'100개 확보 · 계속 추가할 수 있어요';
  const last=model.lastCollection;$('#collection-history').hidden=!last;
  if(last)$('#collection-history').textContent=`최근 수집: 실제 API 조회 ${last.requests} / ${last.requestLimit??10}회 · 받은 상품 ${last.receivedRows??0}건 · ${Number.isInteger(last.newKinds)?`처음 본 종류 ${last.newKinds}종 · 기존 종류의 다른 모델 ${last.existingKindModels||0}개`:`후보 추가 ${last.added}개 (새 종류 수 미집계)`} · 저장 응답 재사용 ${last.cacheHits||0}건`;
  const discovery=model.discoveryStatus;$('#discovery-status').hidden=!discovery;
  $('#discovery-alert').hidden=!discovery?.exhausted;
  if(discovery) {
    $('#discovery-alert-message').textContent=(discovery.message || '').replace(/^검색 목록 추가가 필요합니다\.\s*/,'');
    $('#discovery-status').textContent=discovery.exhausted?`등록한 ${discovery.totalTopics}종 안에서 더 찾을 후보가 없어요. 다른 종류나 검색어를 검색 목록에 추가해야 해요.`:`지금까지 본 종류 ${discovery.seenTopics??discovery.coveredTopics} / 등록한 ${discovery.totalTopics}종 · 아직 안 본 종류 ${discovery.unseenTopics??discovery.unresolvedTopics}종 · 남은 조회 조건 ${discovery.remainingQueries}개 (새 물건 수와 달라요) · 저장 자료에서 추가 가능한 종류 ${discovery.cachedNewTopics}종`;
    $('#topic-plan-description').textContent=`등록한 ${discovery.totalTopics}종 안에서 아직 안 본 종류를 찾아요. 승인·보류·제외한 종류의 다른 모델은 자동으로 다시 가져오지 않아요. `;
    $('#topic-plan-link').textContent=`${discovery.totalTopics}종 검색 목록 ↗`;
  }
  $('#approval-count').innerHTML=`${count.approved}<small>개 승인</small>`;
  $('#quick-count').textContent=`${count.approved}개 승인`;
  const preset=model.collectionPresets?.find(preset=>preset.id===$('#collection-mode').value);
  $('#collection-mode').disabled=locked||discovery?.exhausted;
  if(preset)$('#collection-help').textContent=`새 종류 ${preset.target}종을 목표로 조회를 최대 ${preset.maxRequests}회 이어갑니다. 검색 결과가 없거나 조건에 맞지 않으면 더 적게 추가될 수 있어요.`;
  $('#collect').disabled=locked||discovery?.exhausted;$('#collect').textContent=discovery?.exhausted?'검색 목록 추가 필요':'아직 안 본 종류 찾기';$('#exclude-unreviewed').disabled=locked||!count.unreviewed;$('#exclude-unreviewed').textContent=`미검토 ${count.unreviewed}개 모두 제외`;$('#refresh').disabled=locked||!count.approved;
  for(const button of [$('#apply'),$('[data-apply]')])button.disabled=locked||count.approved<3;
  const approved=model.candidates.filter(c=>model.review.decisions[c.id].status==='approved').map(c=>c.id).sort();
  const pending=model.pendingChanges||JSON.stringify(approved)!==JSON.stringify([...model.applied.ids].sort());
  $('#publish-summary').textContent=pending?`선택한 ${count.approved}개를 검증한 뒤 반영할 수 있어요.`:`${model.applied.ids.length}개가 로컬 게임에 반영돼 있어요.`;
  $('#filters').innerHTML=Object.entries(filterLabels).map(([status,label])=>`<button type="button" data-filter="${status}" class="${filter===status?'active':''}" aria-pressed="${filter===status}">${label}<b>${count[status]}</b></button>`).join('');
  $('#reference-date').textContent=model.lastCollectedAt?`마지막 수집 ${dateText(model.lastCollectedAt)} · 제외한 물건은 목록에서 숨겨요`:`기존 ${model.referenceDate} 자료 · 품목별 확인 시각 표시`;
  renderSelection();if(updateCards)renderCards();
}
function visibleCandidates() {
  const query=$('#search').value.trim().toLowerCase(),category=$('#category').value,price=$('#price').value;
  const visible=model.candidates.filter(c=>{
    const status=model.review.decisions[c.id].status;
    if(status==='excluded'||category&&c.category!==category)return false;
    if(filter==='ready'||filter==='needs'){if(status!=='unreviewed'||Boolean(model.quality?.[c.id]?.ready)!==(filter==='ready'))return false;}
    else if(filter!=='all'&&status!==filter)return false;
    if(query&&![c.id,c.title,c.specification,c.productId].join(' ').toLowerCase().includes(query))return false;
    return !price||(price==='low'?c.answer<100000:price==='mid'?c.answer>=100000&&c.answer<1000000:price==='high'?c.answer>=1000000&&c.answer<10000000:c.answer>=10000000);
  });
  if(['unreviewed','ready','needs'].includes(filter))visible.sort((a,b)=>(model.quality?.[b.id]?.score||0)-(model.quality?.[a.id]?.score||0)||(Date.parse(b.checkedAt)||0)-(Date.parse(a.checkedAt)||0));
  return visible;
}
function renderSelection() {
  $('#selection-count').textContent=`${selectedIds.size}개 선택`;
  for(const id of ['batch-approve','batch-exclude','clear-selection'])$('#'+id).disabled=busy||pendingIds.size>0||!selectedIds.size;
  $('#select-ready').disabled=busy||pendingIds.size>0||!visibleCandidates().some(c=>model.review.decisions[c.id].status==='unreviewed'&&model.quality?.[c.id]?.ready);
}
function renderCards() {
  const visible=visibleCandidates();
  $('#show-more').hidden=visible.length<=visibleLimit;
  $('#show-more').textContent=`${Math.min(24,visible.length-visibleLimit)}개 더 보기 · 총 ${visible.length}개`;
  $('#cards').innerHTML=visible.slice(0,visibleLimit).map(c=>{
    const decision=model.review.decisions[c.id];
    const quality=model.quality?.[c.id];
    const comparison=model.comparisons?.[c.id];
    const comparisonBlock=comparison?`<div class="comparison-preview"><p>${comparison.scopeMismatch?'이번 출제 범위에 맞는 대체 후보':comparison.insufficient?'비교 제조사 3곳 미만 · 자료 부족':`제조사 ${comparison.manufacturerCount}곳 비교 중앙값 <strong>${comparison.medianPrice.toLocaleString('ko-KR')}원</strong>`}</p><button type="button" data-compare="${c.id}" ${busy||pendingIds.size?'disabled':''}>${comparison.options.length}개 비교 후보 · 대표 고르기 ↗</button>${comparison.outlier?'<p class="comparison-warning">중앙값의 1.75배 이상이에요. 비싼 이유를 메모한 뒤 승인해 주세요.</p>':''}</div>`:'';
    const changes=(c.lastChanges||[]).slice(0,3).map(change=>`${esc(change.label)}: ${esc(typeof change.before==='number'?change.before.toLocaleString('ko-KR')+'원':change.before)} → ${esc(typeof change.after==='number'?change.after.toLocaleString('ko-KR')+'원':change.after)}`).join('<br>');
    return `<article class="card" data-id="${c.id}" data-status="${decision.status}"><button type="button" class="photo" data-photo="${c.id}" aria-label="${esc(c.title)} 이미지 크게 보기"><img src="/candidate-images/${esc(c.image.src.split('/').at(-1))}" alt="${esc(c.image.alt)}" loading="lazy"><span class="id">${c.id}</span><span class="badge">${labels[decision.status]}</span></button><div class="card-body">${decision.status==='unreviewed'?`<label class="card-select"><input type="checkbox" data-select="${c.id}" ${selectedIds.has(c.id)?'checked':''} ${busy||pendingIds.has(c.id)?'disabled':''}> 일괄 처리에 선택</label>`:''}${quality?`<div class="quality ${quality.ready?'ready':'needs'}"><strong>${esc(quality.label)}</strong>${quality.reasons.length?`<ul>${quality.reasons.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul>`:'<p>제조사 3곳 이상 · 비교 가격 편차 기준 통과 · 사진을 보고 최종 선택하세요.</p>'}</div>`:''}<p class="category">${esc(c.category)} · 종류: ${esc(c.discoveryFamily?.label || c.specification.split(',')[0])}</p><h3>${esc(c.title)}</h3><p class="price">${c.answer.toLocaleString('ko-KR')}<small>원 / ${esc(c.quantity)}</small></p><div class="conditions"><span>${esc(c.delivery)}</span><span>${esc(c.vat)}</span></div><p class="checked">최종 확인 ${esc(dateText(c.checkedAt))}${c.freshness?.status==='verified'?' · API 계약 행 조회됨':''}</p>${c.freshness?.status==='failed'?`<p class="flag freshness-failed">확인 필요 · ${esc(c.freshness.message)}<br>마지막 조회 시도 ${esc(dateText(c.freshness.lastAttemptAt))}</p>`:''}${changes?`<div class="changes">최근 변경<br>${changes}</div>`:''}<p class="hook">${esc(c.interestReason)}</p><p class="spec-summary">${esc(c.specification)}</p>${c.pricePolicy?.notice?`<p class="flag"><strong>등록 계약단가 기준으로 출제</strong><br>${esc(c.pricePolicy.notice)}</p>`:!c.eligible?`<p class="flag">기준 확인 필요 · ${esc(c.eligibilityReason)}</p>`:''}${comparisonBlock}<div class="actions" role="group" aria-label="${esc(c.title)} 검토 상태">${['approved','held','excluded'].map(status=>`<button type="button" data-id="${c.id}" data-status="${status}" aria-pressed="${decision.status===status}" ${busy||pendingIds.has(c.id)?'disabled':''}>${status==='approved'?'✓ ':status==='held'?'◷ ':'× '}${labels[status]}</button>`).join('')}</div><details><summary>규격·출처·검토 메모</summary><p>${esc(c.specification)}</p><p>물품번호 ${esc(c.productId)}<br>계약 ${esc(c.contractNumber)} / ${esc(c.contractLine)}<br>계약기간 ${esc(c.contractStart)} ~ ${esc(c.contractEnd)}<br>조회 ${esc(c.checkedAt)}<br>${esc(c.scope)}</p><a href="${esc(c.image.sourceUrl)}" target="_blank" rel="noopener noreferrer">등록 이미지 원본 ↗</a><label><br>검토 메모<textarea data-note="${c.id}" maxlength="500" ${busy?'disabled':''} placeholder="흥미로운 이유, 보류 이유 등을 남겨요.">${esc(draftNotes.get(c.id)??decision.note)}</textarea></label></details></div></article>`;
  }).join('')||emptyCardsMessage();
  $('#cards').setAttribute('aria-busy','false');
}
async function loadModel() {
  model=await request('/api/catalog');
  if(model.collectionPresets?.length) {
    $('#collection-mode').innerHTML=model.collectionPresets.map(preset=>`<option value="${esc(preset.id)}">${esc(preset.label)}</option>`).join('');
    if(!model.collectionPresets.some(preset=>preset.id===selectedCollectionPreset))selectedCollectionPreset='standard';
    $('#collection-mode').value=selectedCollectionPreset;
  }
  const selected=$('#category').value;
  $('#category').innerHTML='<option value="">모든 카테고리</option>'+[...new Set(model.candidates.map(c=>c.category))].map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('#category').value=selected;render();return model;
}
function showProgress(job) {
  $('#source-progress').hidden=false;
  const p=job.progress || {};
  $('#source-message').textContent=p.message || '작업 중이에요.';
  if(p.total||p.target){$('#source-meter').max=p.total||p.target;$('#source-meter').value=p.completed??p.added??0;}else $('#source-meter').removeAttribute('value');
  $('#source-detail').textContent=job.kind==='collect'?`신규 ${p.added||0} / ${p.target||job.collection?.target||20}종 · 새 API 조회 ${p.requests||0} / ${p.requestLimit??job.collection?.maxRequests??30}회 · 저장 응답 재사용 ${p.cacheHits||0}건`:`확인 ${p.completed||0} / ${p.total||'—'}개 · 변경 ${p.changed||0}개 · 확인 필요 ${p.failed||0}개`;
}
async function followJob(job) {
  try {
    while(job.status==='running') {
      showProgress(job);await new Promise(resolve=>setTimeout(resolve,1000));job=await request('/api/jobs/'+job.id);
    }
    await loadModel();
    if(job.status==='failed')throw Error(job.error || '작업을 완료하지 못했습니다.');
    const r=job.result;
    if(job.kind==='collect') {
      filter=counts().ready?'ready':counts().unreviewed?'unreviewed':counts().approved?'approved':'all';
      const next=model.discoveryStatus?.exhausted?` ${model.discoveryStatus.message}`:r.remainingSearches?` 미탐색 검색 조건 ${r.remainingSearches}개는 다음 수집에서 이어갑니다.`:'';
      const excluded=r.filtered?` 이미 본 상품 ${r.filtered.knownProducts}건·이미 본 종류의 모델 ${r.duplicateFamilies||0}건·종류 불일치 ${r.filtered.unmatchedRows}건 건너뜀, 비교 규격 부족 ${r.filtered.comparisonUnavailable}종.`:'';
      notice(`${r.added?`처음 보는 물건 ${r.newKinds??r.added}종을 미검토에 추가했어요.`:'이번 수집에서 처음 보는 종류를 찾지 못했어요. 이미 본 종류를 다른 모델로 채우지 않았어요.'} 새 API 조회 ${r.requests} / ${r.requestLimit??10}회 · 받은 상품 ${r.receivedRows??0}건 · 저장 응답 재사용 ${r.cacheHits||0}건.${excluded}${next}${r.warning?' '+r.warning:''}`,Boolean(r.warning)&&!r.added);
    } else if(job.kind==='refresh') notice(`${r.total}개 중 ${r.verified}개 최신 정보 확인 · 변경 ${r.changed}개 · 확인 필요 ${r.failures.length}개`,Boolean(r.failures.length));
    else notice(`최신 정보를 확인한 ${r.count}개를 게임에 반영했어요. 게임 미리보기를 새로고침한 뒤 새 게임을 시작해 주세요.`);
  } catch(error) {notice(error.message,true);}
  finally {busy=false;$('#source-progress').hidden=true;render();}
}
async function startJob(kind) {
  if(busy||pendingIds.size)return;
  if(!await flushNotes())return;
  busy=true;render();
  notice('공식 API에서 정보를 확인하고 있어요. 화면을 닫았다가 다시 열어도 진행 상태를 확인할 수 있어요.');
  try {const job=await request('/api/'+kind,{revision:model.review.revision,...(kind==='collect'?{collectionPreset:$('#collection-mode').value}:{})});await followJob(job);}
  catch(error){busy=false;$('#source-progress').hidden=true;render();notice(error.message,true);}
}
async function save(id,status,note) {
  if(busy||pendingIds.has(id))return;
  const noteOnly=status===model.review.decisions[id].status;
  clearTimeout(noteTimers.get(id));pendingIds.add(id);
  const card=$(`article[data-id="${id}"]`);
  if(!noteOnly)card?.querySelectorAll('.actions button,input[data-select]').forEach(button=>button.disabled=true);
  render(false);
  const work=saveQueue.then(async()=>{
    try {
      model.review=await request('/api/review',{id,status,note,revision:model.review.revision});
      if(status!=='unreviewed')selectedIds.delete(id);
      if(draftNotes.get(id)===note)draftNotes.delete(id);
      const message=`${id} · ${labels[status]} 저장 완료.${status==='excluded'?' 목록에서 숨겼어요. 같은 종류의 다른 모델도 자동 수집하지 않아요.':''}`;
      if(!finishReviewIfEmpty(message))notice(message);
    } catch(error) {notice(error.message,true);}
    finally {
      pendingIds.delete(id);render(!noteOnly);
      if(draftNotes.has(id)&&draftNotes.get(id)!==note)noteTimers.set(id,setTimeout(()=>save(id,model.review.decisions[id].status,draftNotes.get(id)),600));
    }
  });
  saveQueue=work.catch(()=>{});return work;
}
async function saveBatch(status) {
  if(busy||pendingIds.size||!selectedIds.size)return;
  if(!await flushNotes())return;
  busy=true;render();
  try {
    model.review=await request('/api/review-batch',{ids:[...selectedIds],status,revision:model.review.revision});
    const message=`선택한 ${selectedIds.size}개 · ${labels[status]} 저장 완료.`;
    selectedIds.clear();if(!finishReviewIfEmpty(message))notice(message);
  } catch(error) {notice(error.message,true);}
  finally {busy=false;render();}
}
async function flushNotes() {
  await saveQueue;
  for(const [id,note] of [...draftNotes]) {
    clearTimeout(noteTimers.get(id));
    await save(id,model.review.decisions[id].status,note);
  }
  if(draftNotes.size){notice('메모가 아직 저장되지 않았어요. 저장 오류를 확인한 뒤 다시 시도해 주세요.',true);return false;}
  return true;
}

function showComparison(id) {
  const candidate=model.candidates.find(c=>c.id===id),comparison=model.comparisons?.[id];
  if(!comparison)return;
  comparisonCandidateId=id;
  const canChoose=model.review.decisions[id].status==='unreviewed'&&!busy&&!pendingIds.size;
  $('#comparison-title').textContent=`${candidate.title} · 대표 상품 비교`;
  $('#comparison-body').innerHTML=`<p class="comparison-current">현재 후보: ${esc(candidate.specification)}<br><strong>${candidate.answer.toLocaleString('ko-KR')}원 / ${esc(candidate.quantity)}</strong></p>${comparison.scopeMismatch?'<p class="comparison-warning">현재 후보는 이번 출제 범위 밖이에요. 아래는 범위에 맞는 대체 후보입니다. 기존 상품의 가격은 수정하지 않아요.</p>':''}<div class="comparison-conditions">${comparison.conditions.map(c=>`<span>${esc(c)}</span>`).join('')}</div><p>${comparison.comparableCount}개 상품 · 제조사 ${comparison.manufacturerCount}곳 비교 · 아래에는 제조사가 다른 ${comparison.options.length}개만 표시해요.</p>${comparison.insufficient?'<p class="comparison-warning">비교 가능한 제조사가 3곳 미만이라 중앙값 추천을 하지 않아요.</p>':`<p class="comparison-median">제조사별 대표 상품 1개씩의 중앙값 <strong>${comparison.medianPrice.toLocaleString('ko-KR')}원</strong></p>`}<p class="comparison-caveat">${esc(comparison.caveat)}</p>${comparison.topicPriceConcern?`<p class="comparison-warning">범위를 넓힌 참고: 같은 종류·단위·인도·부가세 조건의 제조사 ${comparison.topicManufacturerCount}곳 중앙값 ${comparison.topicMedianPrice.toLocaleString('ko-KR')}원. 세부 규격이 달라 직접 가격 비교에는 쓸 수 없지만, 현재 후보가 특수 규격인지 확인해야 해요.</p>`:''}<div class="comparison-options">${comparison.options.map(option=>`<article class="comparison-option ${option.isRecommended?'recommended':''}"><img class="comparison-photo" src="${esc(option.imageUrl)}" alt="${esc(option.specification)}" loading="lazy" referrerpolicy="no-referrer"><div class="comparison-option-top"><strong>${esc(option.manufacturer)}</strong><span>${option.isCurrent?'<b class="comparison-tag current">현재 후보</b>':''}${option.isRecommended?'<b class="comparison-tag">중앙값 근접 추천</b>':''}</span></div><p class="comparison-option-price">${option.price.toLocaleString('ko-KR')}원 <small>/ 1${esc(option.unit)}</small></p><p>${esc(option.specification)}</p><p class="comparison-date">저장된 조회 ${esc(dateText(option.checkedAt))}${option.isFresh?'':' · 최신 확인 필요'} · 물품번호 ${esc(option.productId)}</p><div class="comparison-option-actions"><a href="${esc(option.imageUrl)}" target="_blank" rel="noopener noreferrer">등록 사진 보기 ↗</a><button type="button" data-choice="${option.productId}" ${!canChoose||option.isCurrent||!option.isFresh?'disabled':''}>${option.isCurrent?'현재 대표 후보':'이 상품을 대표 후보로'}</button></div></article>`).join('')}</div><p class="comparison-caveat">${canChoose?'다른 상품을 선택하면 기존 미검토 후보는 메모를 유지한 채 보류로 이동해요. 선택한 새 후보는 미검토로 저장되며, 직접 승인해야 게임에 들어가요. 등록 사진은 새 탭에서 열 수 있어요.':'승인·보류·제외한 후보는 이 화면에서 자동 교체하지 않아요. 미검토 후보에서 대표를 선택해 주세요.'}</p><p id="comparison-error" class="notice error" role="status"></p>`;
  if(!$('#comparison-dialog').open)$('#comparison-dialog').showModal();
}
async function chooseComparison(productId) {
  if(busy||pendingIds.size)return;
  if(!await flushNotes())return;
  busy=true;render();showComparison(comparisonCandidateId);
  try {
    const result=await request('/api/comparison-choice',{id:comparisonCandidateId,productId,revision:model.review.revision});
    $('#comparison-dialog').close();await loadModel();filter='unreviewed';
    notice(`${result.id}를 대표 후보로 선택했어요. 기존 후보는 보류로 옮겼고, 아직 게임에는 반영하지 않았어요.`);
  } catch(error) {showComparison(comparisonCandidateId);$('#comparison-error').textContent=error.message;}
  finally {busy=false;render();if($('#comparison-dialog').open){const message=$('#comparison-error')?.textContent;showComparison(comparisonCandidateId);$('#comparison-error').textContent=message || '';}}
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.filter){filter=button.dataset.filter;visibleLimit=24;selectedIds.clear();render();}
  if(button.dataset.emptyFilter){filter=button.dataset.emptyFilter;resetCardFilters();render();notice(`${filterLabels[filter]} ${counts()[filter]}개를 표시합니다.`);}
  if(button.dataset.resetFilters){resetCardFilters();render();notice('검색·분류·가격 필터를 초기화했어요.');}
  if(button.dataset.compare)showComparison(button.dataset.compare);
  if(button.dataset.choice)await chooseComparison(button.dataset.choice);
  if(button.id==='close-comparison')$('#comparison-dialog').close();
  if(button.dataset.status){const {id,status}=button.dataset;await save(id,status,draftNotes.get(id)??model.review.decisions[id].note);}
  if(button.dataset.photo){const c=model.candidates.find(c=>c.id===button.dataset.photo);$('#large-photo').src='/candidate-images/'+c.image.src.split('/').at(-1);$('#large-photo').alt=c.image.alt;$('#photo-caption').textContent=c.title+' · '+c.specification;$('#photo-dialog').showModal();}
  if(button.id==='close-photo')$('#photo-dialog').close();
  if(button.id==='exclude-unreviewed'&&!busy){
    busy=true;render();
    try{const result=await request('/api/exclude-unreviewed',{revision:model.review.revision});model.review=result.review;selectedIds.clear();const message=`미검토 ${result.excludedCount}개를 목록에서 숨겼어요.`;if(!finishReviewIfEmpty(message))notice(message);}
    catch(error){notice(error.message,true);}finally{busy=false;render();}
  }
  if(button.id==='show-more'){visibleLimit+=24;renderCards();}
  if(button.id==='select-ready') {
    for(const c of visibleCandidates().slice(0,visibleLimit))if(model.review.decisions[c.id].status==='unreviewed'&&model.quality?.[c.id]?.ready&&selectedIds.size<100)selectedIds.add(c.id);
    renderCards();renderSelection();
  }
  if(button.id==='clear-selection'){selectedIds.clear();renderCards();renderSelection();}
  if(button.id==='batch-approve')await saveBatch('approved');
  if(button.id==='batch-exclude')await saveBatch('excluded');
  if(button.id==='collect')await startJob('collect');
  if(button.id==='refresh')await startJob('refresh');
  if(button.id==='apply'||button.dataset.apply)await startJob('apply');
});
$('#search').addEventListener('input',()=>{visibleLimit=24;selectedIds.clear();if(model){renderCards();renderSelection();}});
for(const id of ['category','price'])$('#'+id).addEventListener('change',()=>{visibleLimit=24;selectedIds.clear();renderCards();renderSelection();});
$('#collection-mode').addEventListener('change',()=>{
  selectedCollectionPreset=$('#collection-mode').value;
  try{localStorage.setItem('curator-collection-preset',selectedCollectionPreset);}catch{}
  if(model)render();
});
document.addEventListener('input',event=>{
  const id=event.target.dataset.note;if(!id)return;
  draftNotes.set(id,event.target.value);clearTimeout(noteTimers.get(id));
  noteTimers.set(id,setTimeout(()=>save(id,model.review.decisions[id].status,draftNotes.get(id)),600));
});
document.addEventListener('change',event=>{
  const id=event.target.dataset.select;if(!id)return;
  if(event.target.checked && selectedIds.size<100)selectedIds.add(id);
  else {selectedIds.delete(id);event.target.checked=false;}
  renderSelection();
});
try {
  await loadModel();filter=counts().ready?'ready':counts().unreviewed?'unreviewed':counts().approved?'approved':'all';render();
  notice(counts().unreviewed?'비교 근거가 충분한 후보부터 보여요. 사진·규격을 확인하고 여러 개를 선택해 승인하세요. API 계약단가 조회와 가격 적정성 확인은 별개예요.':`미검토 후보를 모두 처리했어요. 승인 ${counts().approved}개 · 보류 ${counts().held}개가 저장되어 있어요.`);
  new IntersectionObserver(entries=>{$('#quick-bar').hidden=entries[0].isIntersecting;}).observe($('.publish'));
  if(model.activeJob){busy=true;render();await followJob(model.activeJob);}
}catch(error){notice(error.message,true);$('#cards').innerHTML='<p class="empty">선별 화면을 새로고침해 주세요.</p>';}
