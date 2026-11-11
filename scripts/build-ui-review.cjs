// Rebuild the local visual review from the preserved 98 originals and rerun.
const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const root = path.join(project, '.artifacts/ui-visual-review');
const original = JSON.parse(fs.readFileSync(path.join(root, 'inventory.json')));
const rerun = JSON.parse(fs.readFileSync(path.join(root, 'after/verification.json')));
if (original.length !== 98 || new Set(original.map(r => r.file)).size !== 98) throw Error('Original coverage must be exactly 98');
if (rerun.screenshots.length !== 98 || rerun.errors.length) throw Error('Rerun incomplete');
const families = [
  ['title', '메인', '기본·호버·누름·랭킹 비활성'],
  ['question', '문제 · 금액 입력 · 규격', '기본·최대 금액·입력 오류·규격·사진 실패'],
  ['retry', '가격 힌트 · 추측 횟수', 'UP·DOWN·마지막 기회'],
  ['reveal', '정답 공개 · 틈새 지식', '1·2·3회 성공·실패·출처 스크롤'],
  ['result', '최종 결과', '8,300점·0점·10,000점'],
  ['ranking', '온라인 랭킹', '등록 폼·제출 중·등록 완료·로딩·빈 목록·오류'],
  ['details', '상세 결과', '요약·상품 목록·지식·스크롤'],
  ['photo', '사진 확대', '일반 확대·부모 창이 있는 확대'],
  ['source', '계약 정보', '규격·단가·출처·다운로드'],
  ['rules', '점수 안내', '점수·힌트 기준'],
  ['about', '데이터 기준', '조사 스냅샷·가격·이미지 설명'],
  ['share', '공유 · 복사', '복사 권한 거부 대체·카카오 SDK 실패'],
  ['exit', '종료 안내', '탭 종료 안내'],
  ['loading', '로딩 · 데이터 오류', '불러오는 중·실패 후 재시도'],
  ['rotation', '기기 회전 안내', '390×844·375×667 세로'],
];
function classify(file) {
  if (file === 'loading.png') return ['loading', '불러오는 중'];
  if (file === 'load-failure.png') return ['loading', '데이터 실패 · 재시도'];
  if (file === 'exit.png') return ['exit', '종료 안내'];
  if (file.startsWith('rotation-')) return ['rotation', '세로 회전 안내'];
  if (file.startsWith('title-')) return ['title', file.includes('hover') ? '호버' : file.includes('pressed') ? '누름' : '기본'];
  if (file === 'ranking-disabled.png') return ['title', '랭킹 비활성'];
  if (file.startsWith('question-')) return ['question', '기본'];
  if (file.startsWith('amount-max-')) return ['question', '최대 12자리 금액'];
  if (/^(error-|input-error-)/.test(file)) return ['question', '빈 금액 오류'];
  if (file.startsWith('specs-')) return ['question', '규격 펼침 + 입력 오류'];
  if (file === 'image-unavailable.png') return ['question', '상품 이미지 실패'];
  if (file.startsWith('retry-')) return ['retry', file.includes('-up') ? 'UP' : 'DOWN'];
  if (file === 'last-attempt.png') return ['retry', '마지막 기회'];
  if (file.startsWith('knowledge-source-')) return ['reveal', '지식 출처로 스크롤'];
  if (file.startsWith('reveal-')) return ['reveal', file.includes('first') ? '1회 정답' : file.includes('third') ? '3회 정답' : file.includes('failure') ? '3회 실패' : '2회 정답'];
  if (file === 'result-details-1920.png' || file.startsWith('details-')) return ['details', file === 'result-details-1920.png' ? '목록 · 스크롤 후' : '요약 · 목록 시작'];
  if (file.startsWith('result-')) return ['result', file.startsWith('result-0-') ? '0점' : file.includes('10000') ? '10,000점' : '8,300점'];
  if (file === 'nested-photo.png') return ['photo', '중첩 창 · 뒤로 버튼'];
  if (file.startsWith('photo-')) return ['photo', '사진 확대'];
  if (file.startsWith('source-')) return ['source', '계약 정보'];
  if (file.startsWith('rules-')) return ['rules', '점수 안내'];
  if (file.startsWith('about-')) return ['about', '데이터 기준'];
  if (file === 'copy-fallback.png') return ['share', '복사 대체 · 텍스트 선택'];
  if (file === 'kakao-unavailable.png') return ['share', '카카오 SDK 실패'];
  if (file.startsWith('ranking-')) {
    const state = file.includes('submit-error') ? '등록 실패' : file.includes('submitting') ? '등록 중' : file.includes('registered') ? '등록 완료' : file.includes('empty') ? '빈 목록' : file.includes('error') ? '조회 실패' : file === 'ranking-loading.png' ? '로딩 중' : /full|loading-complete/.test(file) ? '정상 목록' : '등록 폼 + 내 기록';
    return ['ranking', state];
  }
  throw Error('Unclassified: ' + file);
}
const findings = [
  { id: 'F1', priority: 1, title: '공통 팝업 제목·닫기 영역의 프레임 침범', file: 'rules-1920.png', detail: '이전 CSS의 음수 top 값이 새 스타일보다 우선해 제목이 프레임 상단에 붙었다. 선택자 적용 범위를 바로잡아 상단 안쪽 여백을 복구했다.', test: '모든 공통 모달 제목의 상단 여백 ≥ 14px 검사' },
  { id: 'F7', priority: 1, title: '입력 오류 문구 겹침·하트 하단 잘림', file: 'error-1366x768.png', detail: '오류 문구를 금액 위에 겹쳐 그리던 방식을 전용 행으로 바꿨다. 오류 상태의 여백과 장식 꼬리 높이를 조절해 기회 표시도 무대 안에 남겼다.', test: '4개 해상도에서 오류·규격 동시 상태의 하트 경계 검사' },
  { id: 'F2', priority: 2, title: '모바일 결과의 두 다람쥐 겹침', file: 'result-667x375.png', detail: '중앙 마스코트를 왼쪽으로 옮긴 규칙을 제거하고 파란 패널 안에 복구했다. 외부 배낭 캐릭터와 분리했다.', test: '결과 캐릭터의 bounding box 교차 없음 검사' },
  { id: 'F3', priority: 2, title: '랭킹 제출 중 이전 입력 오류 잔존', file: 'ranking-submitting.png', detail: '유효한 닉네임으로 다시 제출할 때 이전 오류 문구를 지웠다. 응답을 보류한 상태로 제출 중 캡처를 다시 검증했다.', test: '등록 중 버튼 비활성 + 오류 문구 빈 값 확인' },
  { id: 'F4', priority: 2, title: '모바일 상세 결과의 첫 상품이 아래로 밀림', file: 'details-667x375.png', detail: '요약·통계·중복 제목 사이의 큰 여백을 줄였다. 처음 열었을 때 첫 상품 사진과 이름을 바로 볼 수 있다.', test: '667×375·844×390 실제 캡처 확대 검수' },
  { id: 'F5', priority: 2, title: '상품 사진 실패 시 브라우저 기본 깨진 이미지 노출', file: 'image-unavailable.png', detail: '게임 색상의 안내 카드와 그림 아이콘으로 대체했다. 원본 이미지 안내와 사진 확대 기능은 유지한다.', test: '실제 이미지 요청 차단 후 대체 카드 표시 확인' },
  { id: 'F6', priority: 2, title: '데이터 오류의 옛 브랜드 아이콘과 배경 로고 충돌', file: 'load-failure.png', detail: '로딩·오류 화면에서 이전 웹 UI의 ₩? 배지를 제거했다. 로딩은 같은 글꼴의 점 표시로 정리했다.', test: '로딩·데이터 실패 캡처 확대 검수' },
];
const decisions = [
  { id: 'D1', priority: 3, title: '메인 제목: 시안 계열의 연회색 유지 / 더 진하게', file: 'title-667x375.png', option: 'decisions/title-contrast-option.png', detail: '밝은 배경 위 회색 제목이 모바일에서 흐리게 보인다. 기존 색상은 유지했고, 남색 계열로 진하게 한 미적용 후보를 함께 제공한다.', recommendation: '읽기 쉬운 진한 후보를 권장. 원본 완성 시안 3장 전체 재대조는 미검증이다.' },
  { id: 'D2', priority: 3, title: '모바일 틈새 지식: 카드 스크롤 유지 / 확대 읽기 추가', file: 'reveal-667x375.png', detail: '가로 비율과 주 버튼 크기를 지키면 긴 지식과 출처는 작은 카드 안에서 스크롤해야 한다. 잘림 오류는 아니며 전체 내용에 접근할 수 있다.', recommendation: '빠른 게임 흐름이면 현재 스크롤 유지. 지식 읽기를 강조하려면 별도 확대 읽기 창을 추가하는 방향이 적합하다.' },
];
const genericModal = new Set(['details', 'photo', 'source', 'rules', 'about', 'exit']);
const errorLayout = new Set(['error-1366x768.png', 'specs-1366x768.png', 'error-844x390.png', 'specs-844x390.png', 'error-667x375.png', 'specs-667x375.png']);
const smallReveals = new Set(['reveal-667x375.png', 'reveal-844x390.png', 'knowledge-source-667x375.png', 'knowledge-source-844x390.png']);
const records = original.map(row => {
  const [family, state] = classify(row.file), issues = [], choices = [];
  if (genericModal.has(family) || row.file === 'copy-fallback.png') issues.push('F1');
  if (errorLayout.has(row.file)) issues.push('F7');
  if (family === 'result' && (row.width <= 900)) issues.push('F2');
  if (row.file === 'ranking-submitting.png') issues.push('F3');
  if (family === 'details' && row.width <= 900) issues.push('F4');
  if (row.file === 'image-unavailable.png') issues.push('F5');
  if (row.file === 'load-failure.png') issues.push('F6');
  if (family === 'title') choices.push('D1');
  if (smallReveals.has(row.file)) choices.push('D2');
  const expectedError = /^(error-|input-error-|specs-)|^(ranking-error|ranking-submit-error|image-unavailable|load-failure|kakao-unavailable|copy-fallback)\.png$/.test(row.file);
  if (!rerun.screenshots.includes(row.file) || !fs.existsSync(path.join(root, 'after', row.file))) throw Error('Missing after: ' + row.file);
  return { ...row, family, state, issues, choices, expectedError, visuallyReviewed: true, sheet: Math.ceil(row.id / 6), status: issues.length ? '수정 후 통과' : choices.length ? '선택 검토' : '시각 통과' };
});
const counts = families.map(([id, title, detail]) => ({ id, title, detail, count: records.filter(r => r.family === id).length, states: [...new Set(records.filter(r => r.family === id).map(r => r.state))].length }));
const summary = { originals: records.length, families: counts.length, states: counts.reduce((s, g) => s + g.states, 0), issueTypes: findings.length, correctedScreens: records.filter(r => r.issues.length).length, choiceScreens: records.filter(r => r.choices.length).length, expectedErrorScreens: records.filter(r => r.expectedError).length, rerunGroups: rerun.results.length };
const extraFile = path.join(root, 'extra/verification.json');
const extras = fs.existsSync(extraFile) ? JSON.parse(fs.readFileSync(extraFile)).screenshots : [];
const data = { generatedAt: new Date().toISOString(), summary, families: counts, findings: findings.map(f => ({ ...f, affected: records.filter(r => r.issues.includes(f.id)).map(r => r.id) })), decisions, extras, records };
fs.writeFileSync(path.join(root, 'visual-review.json'), JSON.stringify(data, null, 2));
const payload = JSON.stringify(data).replace(/</g, '\\u003c');
const page = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>게임 UI 시각 검수 · 98장 분류</title><style>
:root{font-family:system-ui,'Malgun Gothic',sans-serif;color:#253357;background:#f3f5fb;font-size:15px}*{box-sizing:border-box}body{margin:0}header,main{max-width:1440px;margin:auto;padding:24px}header{padding-bottom:16px}h1{margin:0 0 10px;font-size:28px;letter-spacing:-.04em}h2{font-size:22px}h3{font-size:17px}p{line-height:1.7}a{color:#344eff}button,input,select{font:inherit}button{cursor:pointer}button,input{min-height:44px;border:1px solid #cdd6ef;border-radius:10px;background:white;padding:8px 12px;color:inherit}button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible{outline:3px solid #344eff;outline-offset:3px}button.active{background:#344eff;color:white;border-color:#344eff}.stats,.links,.toolbar,.badges{display:flex;gap:8px;flex-wrap:wrap}.stats span,.badge{padding:6px 10px;border-radius:9px;background:#e8edfc;font-size:13px}.stats{margin:16px 0}.links a{padding:8px 12px;background:#fff;border-radius:8px}.toolbar{position:sticky;top:0;z-index:10;background:#f3f5fbf5;padding:12px 0;border-bottom:1px solid #dce3f2;backdrop-filter:blur(12px)}input{flex:1;min-width:220px}.review,.family{background:white;border:1px solid #dce3f2;border-radius:16px;padding:20px;margin-bottom:18px}.review h3{margin:0 0 8px}.priority{font-weight:800;color:#b33b49}.priority.p2{color:#9d651f}.priority.p3{color:#6f4db6}.note{font-size:13px;color:#5c6781}.pair,.representatives{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.family>h2{margin:0 0 8px}.state{border-top:1px solid #e0e6f2;margin-top:20px;padding-top:12px}.state h3{margin:0 0 10px}figure{margin:0;min-width:0;border:1px solid #dce3f2;border-radius:12px;overflow:hidden;background:#fafbff}figure button{display:block;padding:0;width:100%;border:0;border-radius:0;background:#251039}figure img{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#251039}figcaption{padding:10px;font-size:13px;overflow-wrap:anywhere}.variants{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin:14px 0}.badge.fixed{background:#e4f4ec;color:#24674b}.badge.choice{background:#f1eaff;color:#7448a7}.badge.error{background:#fff0df;color:#8c5a20}details{margin:12px 0}summary{cursor:pointer;padding:12px;background:#f0f3fc;border-radius:10px;line-height:1.5}.issue-list summary{font-weight:650}.review:target,.family:target{outline:3px solid #b6c4ff}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:10px;border-bottom:1px solid #e0e6f2;text-align:left}dialog{width:min(1500px,96vw);height:94dvh;border:0;border-radius:16px;padding:16px;background:#edf2ff}dialog::backdrop{background:#131c39c9}dialog img{width:100%;height:calc(100% - 70px);object-fit:contain;background:#251039}.viewerbar{display:flex;gap:8px;align-items:center;margin-bottom:12px}.viewerbar span{flex:1;overflow-wrap:anywhere}.empty{padding:32px;text-align:center;color:#63708e}[hidden]{display:none!important}@media(max-width:750px){header,main{padding:16px}.pair,.representatives{grid-template-columns:1fr}.toolbar{position:static}h1{font-size:24px}.review,.family{padding:14px}.stats span{font-size:12px}.viewerbar{flex-wrap:wrap}}
</style></head><body><header><h1>게임 UI 시각 검수</h1><p>98장 전체를 보존하고 화면·기능·상태별로 묶었습니다. PC와 모바일은 각각 대표를 표시하며, 나머지 해상도와 상품 차이는 펼쳐 볼 수 있습니다.</p><div class="stats" id="stats"></div><nav class="links"><a href="#decisions">판단할 디자인 2건</a><a href="#issues">수정한 문제 7종</a><a href="#catalog">화면별 전체 분류</a><a href="../ui-visual-review/visual-review.json">98장 개별 검수 기록</a><a href="../../UI_VISUAL_REVIEW.md">검수 보고서</a></nav><p class="note">공유·랭킹의 실패 화면은 의도적으로 만든 테스트 상태입니다. 오류 문구가 있다는 이유로 디자인 불량으로 분류하지 않았습니다. 완성 시안 원본 3장 전체의 직접 대조는 미검증이며, 기존 적용 화면·아트 에셋·보존된 게임 시안 비교 이미지를 기준으로 검수했습니다.</p></header><main><section id="decisions"><h2>사용자 판단이 필요한 디자인</h2></section><section id="issues" class="issue-list"><h2>심각도순 수정 완료</h2></section><section class="review"><h2>98장 검증 범위</h2><div id="scope"></div><p class="note">모든 원본은 수정 전 파일로 남겨 두었습니다. 기본 표시는 수정 후 캡처이며 전환 버튼으로 원본과 비교할 수 있습니다. 아래 분류의 개별 캡처 수는 중복 없이 98장입니다.</p></section><div class="toolbar"><button data-mode="all" class="active">전체 98장</button><button data-mode="fixed">수정 대상</button><button data-mode="choice">디자인 선택</button><button data-mode="errors">오류·대체 상태</button><input id="search" type="search" aria-label="캡처 검색" placeholder="화면, 상태, 해상도 또는 파일명 검색"><button id="stage">수정 전 보기</button></div><p id="match-count"></p><section id="catalog"></section></main><dialog id="viewer"><div class="viewerbar"><span id="viewer-title"></span><button id="viewer-stage">수정 전/후 전환</button><button id="viewer-close" aria-label="이미지 닫기">닫기 ×</button></div><img id="viewer-image" alt="확대 캡처"></dialog><script>
const data=${payload};let mode='all',stage='after',query='';const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const url=(file,version='after')=>'../ui-visual-review/'+version+'/'+file;const label=r=>r.width+'×'+r.height;const badge=r=>'<span class="badge '+(r.issues.length?'fixed':r.choices.length?'choice':'')+'">'+r.status+'</span>'+(r.expectedError?'<span class="badge error">의도적 오류·대체 상태</span>':'');
function figure(r,version=stage,caption=''){const badges=version==='before'&&r.issues.length?'<span class="badge error">수정 전 문제 · '+r.issues.join(', ')+'</span>':badge(r);return '<figure data-capture-id="'+r.id+'"><button data-open="'+r.file+'" data-version="'+version+'" aria-label="'+esc(r.state+' '+label(r)+' 원본 크기로 보기')+'"><img loading="lazy" src="'+url(r.file,version)+'" alt="'+esc(r.state+' '+label(r))+'"></button><figcaption><div class="badges">'+badges+'</div><p>#'+r.id+' · '+label(r)+' · '+esc(caption||r.state)+'<br>'+r.file+'</p></figcaption></figure>'}
document.querySelector('#stats').innerHTML=['원본 '+data.summary.originals+'장',data.summary.families+'개 화면·기능',data.summary.states+'개 상태 묶음','직접 수정 '+data.summary.issueTypes+'종','UI 재검증 '+data.summary.rerunGroups+'묶음 통과'].map(s=>'<span>'+s+'</span>').join('');
document.querySelector('#scope').innerHTML='<table><thead><tr><th>화면·기능</th><th>원본</th><th>상태 묶음</th><th>범위</th></tr></thead><tbody>'+data.families.map(g=>'<tr><td><a href="#family-'+g.id+'">'+g.title+'</a></td><td>'+g.count+'장</td><td>'+g.states+'개</td><td>'+g.detail+'</td></tr>').join('')+'</tbody></table>';
if(data.extras.length)document.querySelector('#scope').insertAdjacentHTML('afterend','<details><summary>원본 98장에 없던 추가 상태 '+data.extras.length+'장 · 메뉴 4종 / 효과음 ON / 힌트 펼침 / 닉네임 오류</summary><div class="variants">'+data.extras.map(file=>'<figure><button data-open="extra/'+file+'" data-version="option"><img loading="lazy" src="../ui-visual-review/extra/'+file+'" alt="추가 검증 '+file+'"></button><figcaption>추가 검증 · '+file+'</figcaption></figure>').join('')+'</div></details>');
document.querySelector('#decisions').insertAdjacentHTML('beforeend',data.decisions.map(d=>{const r=data.records.find(r=>r.file===d.file);return '<article class="review" id="'+d.id+'"><h3><span class="priority p3">선택 '+d.id+' · P3</span> '+d.title+'</h3><p>'+d.detail+'</p><p><strong>검수 의견:</strong> '+d.recommendation+'</p><div class="pair">'+figure(r,'after','현재 적용')+(d.option?'<figure><button data-open="'+d.option+'" data-version="option"><img loading="lazy" src="../ui-visual-review/'+d.option+'" alt="미적용 제목 색상 후보"></button><figcaption>제목을 진하게 한 후보 · 미적용</figcaption></figure>':figure(data.records.find(r=>r.file==='knowledge-source-667x375.png'),'after','같은 카드의 출처까지 스크롤'))+'</div></article>'}).join(''));
document.querySelector('#issues').insertAdjacentHTML('beforeend',data.findings.map(f=>{const r=data.records.find(r=>r.file===f.file);return '<details class="review" id="'+f.id+'"><summary><span class="priority p'+f.priority+'">P'+f.priority+' · '+f.id+'</span> '+f.title+' · 관련 '+f.affected.length+'장 · 수정 완료</summary><p>'+f.detail+'</p><p class="note">재검증: '+f.test+'</p><div class="pair">'+figure(r,'before','수정 전')+figure(r,'after','수정 후')+'</div><p class="note">원본 번호: '+f.affected.join(', ')+'</p></details>'}).join(''));
function render(){const rows=data.records.filter(r=>(mode==='all'||mode==='fixed'&&r.issues.length||mode==='choice'&&r.choices.length||mode==='errors'&&r.expectedError)&&(!query||[r.file,r.state,label(r),data.families.find(g=>g.id===r.family).title].join(' ').toLowerCase().includes(query)));document.querySelector('#match-count').textContent=rows.length+' / 98장 · '+(stage==='after'?'수정 후':'보존된 원본');document.querySelector('#catalog').innerHTML=data.families.map(g=>{const list=rows.filter(r=>r.family===g.id);if(!list.length)return '';const states=[...new Set(list.map(r=>r.state))];return '<article class="family" id="family-'+g.id+'"><h2>'+g.title+' · '+list.length+'장</h2><p class="note">'+g.detail+'</p>'+states.map(state=>{const variants=list.filter(r=>r.state===state);const desktop=variants.find(r=>r.width>=1200);const small=variants.find(r=>r.width<=900&&r.height<r.width);const portraits=variants.filter(r=>r.height>r.width);const reps=[...new Set([desktop,small,...portraits].filter(Boolean))];if(!reps.length)reps.push(variants[0]);const rest=variants.filter(r=>!reps.includes(r));return '<section class="state"><h3>'+state+' · '+variants.length+'장</h3><div class="representatives">'+reps.map(r=>figure(r)).join('')+'</div>'+(rest.length?'<details><summary>같은 상태의 다른 해상도·상품·스크롤 위치 '+rest.length+'장 펼치기</summary><div class="variants">'+rest.map(r=>figure(r)).join('')+'</div></details>':'')+'</section>'}).join('')+'</article>'}).join('')||'<p class="empty">일치하는 캡처가 없습니다.</p>';}
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.mode;document.querySelectorAll('[data-mode]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b))});render();document.querySelector('#catalog').scrollIntoView({block:'start'})}));document.querySelector('#search').addEventListener('input',e=>{query=e.target.value.toLowerCase();render()});document.querySelector('#stage').addEventListener('click',e=>{stage=stage==='after'?'before':'after';e.target.textContent=stage==='after'?'수정 전 보기':'수정 후 보기';render()});let currentFile='',currentVersion='after';const viewer=document.querySelector('#viewer');function show(){document.querySelector('#viewer-image').src=currentVersion==='option'?'../ui-visual-review/'+currentFile:url(currentFile,currentVersion);document.querySelector('#viewer-title').textContent=currentFile+' · '+(currentVersion==='before'?'원본':currentVersion==='option'?'미적용 후보':'수정 후');document.querySelector('#viewer-stage').hidden=currentVersion==='option'}document.addEventListener('click',e=>{const b=e.target.closest('[data-open]');if(!b)return;currentFile=b.dataset.open;currentVersion=b.dataset.version;show();viewer.showModal()});document.querySelector('#viewer-stage').addEventListener('click',()=>{currentVersion=currentVersion==='after'?'before':'after';show()});document.querySelector('#viewer-close').addEventListener('click',()=>viewer.close());render();
</script></body></html>`;
const finalPage = page.replace('.family>h2', '#catalog,.family{scroll-margin-top:96px}.family>h2');
fs.writeFileSync(path.join(project, '.artifacts/ui-audit/gallery.html'), finalPage);
fs.writeFileSync(path.join(root, 'index.html'), finalPage.replaceAll('../ui-visual-review/', './'));
console.log(JSON.stringify({ summary, families: counts }, null, 2));
