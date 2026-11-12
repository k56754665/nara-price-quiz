import { MAX_GUESS, ROUND_COUNT, MAX_ATTEMPTS, TOLERANCE_PERCENT, ATTEMPT_SCORES, parseGuess, isCorrect, scoreRound, relativeError, koreanAmount, judge, totalScore, grade, guessHint, rankingSet, createSession, restoreSession, isValidTriviaPool } from './engine.js';
import { LEADERBOARD_CONFIG } from './leaderboard-config.js';
import { buildShareText, loadKakao, shareKakao, shareSystem } from './share.js';
import { NICKNAME_MAX, isConfigured, normalizeNickname, buildSubmission, submitScore, fetchLeaderboard } from './leaderboard.js';
import { createGameEffects } from './effects.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#info-dialog');
// 규칙이 바뀌어(±10% · 3번 추측) 최고 기록은 새 키에 저장합니다. 진행 기록은 규칙 버전이 다르면 버립니다.
const storageKeys = { session: 'nara-price-session-v3', best: 'nara-price-best-v3', ranking: 'nara-price-ranking-v1' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = value => value.toLocaleString('ko-KR');
const money = value => `${number(value)}<span class="currency">원</span>`;
const vatLabel = q => q.vat === '부가가치세포함' ? '부가세 포함' : q.vat === '부가가치세별도' ? '부가세 별도' : q.vat;
// 게임 화면은 쉬운 말로 안내하고, 계약 정보와 원본 데이터는 공식 용어를 보존합니다.
const deliveryLabels = {
  '현장설치도': '배송·설치 포함',
  '납품장소하차도': '배송·하차 포함',
  '납품장소도': '지정 장소 배송',
  '현장도착도': '현장까지 배송',
  '생산공장상차도': '공장 수령·차량 적재 포함',
  '납품장소차상도': '배송 포함·하차 별도',
  '생산공장도(상차제외)': '공장 수령·차량 적재 별도',
  '생산공장공장현장도': '공장 검사 후 수령',
  '납품장소입고도': '배송·입고 포함',
};
const deliveryLabel = q => deliveryLabels[q.delivery.replace(/\s+/g, '')] ?? q.delivery;
const arrow = '<span aria-hidden="true">↗</span>';
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const remove = key => { try { localStorage.removeItem(key); } catch {} };
const usesTouchControls = () => window.matchMedia('(pointer: coarse), (hover: none)').matches;

let data;
let triviaPool;
let state = null;
let screen = 'home';
let soundOn = read('nara-price-sound', true) !== false;
let musicOn = read('nara-price-music', true) !== false;
let guessBusy = false;
const effects = createGameEffects(() => soundOn, () => musicOn);
let toastTimeout;
const MAX_TOTAL = ROUND_COUNT * ATTEMPT_SCORES[0];
let best = read(storageKeys.best, 0);
if (!Number.isInteger(best) || best < 0 || best > MAX_TOTAL) best = 0;
const rankingOn = isConfigured(LEADERBOARD_CONFIG);
let ranking = read(storageKeys.ranking, null);
if (!ranking || typeof ranking !== 'object') ranking = {};
if (typeof ranking.clientId !== 'string') ranking.clientId = null;
if (!ranking.played || typeof ranking.played !== 'object') ranking.played = {};
if (!ranking.submitted || typeof ranking.submitted !== 'object') ranking.submitted = {};
if (typeof ranking.nickname !== 'string') ranking.nickname = '';
let rankingBusy = false;
// Child information windows retain the previous window and its scroll position.
const dialogHistory = [];
function closeDialog() {
  const previous = dialogHistory.pop();
  if (!previous) { dialog.close(); return; }
  dialog.className = previous.className;
  dialog.replaceChildren(...previous.nodes);
  dialog.scrollTop = previous.scroll;
  const content = dialog.querySelector('.dialog-content');
  if (content) content.scrollTop = previous.contentScroll;
  previous.trigger?.focus({ preventScroll: true });
}
dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
dialog.addEventListener('close', () => {
  if (dialog.dataset.rotationClosing) { delete dialog.dataset.rotationClosing; return; }
  dialogHistory.length = 0;
});

const gameQuestions = () => state.questions;
const referenceDate = () => screen !== 'home' && state ? state.referenceDate : data.referenceDate;
const findQuestion = id => (screen !== 'home' && state ? state.questions.find(q => q.id === id) : null) ?? data.questions.find(q => q.id === id);
const scoreList = ATTEMPT_SCORES.map((score, i) => `${i + 1}번째 ${number(score)}`).join(' · ');

function persist() { if (state) write(storageKeys.session, state); }
function notify(text) {
  const toast = document.querySelector('#toast');
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
}

function header() {
  return `<header class="site-header"><button class="brand" data-action="home" aria-label="이게 얼마게? 처음 화면"><span class="brand-mark" aria-hidden="true">₩?</span><span>이게 얼마게<span class="brand-question">?</span></span></button><span class="header-description">나라장터 가격 퀴즈</span><nav class="header-tools" aria-label="게임 도구">${rankingOn ? '<button class="ranking-header-button" data-action="ranking" aria-label="온라인 랭킹 보기"><span aria-hidden="true">🏆</span><span class="ranking-header-label">랭킹</span></button>' : ''}<button class="text-button about-button" data-action="about">데이터 기준 ↗</button><button class="icon-button" data-action="sound" aria-label="${soundOn ? '효과음 끄기' : '효과음 켜기'}" aria-pressed="${soundOn}">${soundOn ? '♫' : '♪'}<span class="sound-state">${soundOn ? 'ON' : 'OFF'}</span></button><button class="icon-button fullscreen-button" data-action="fullscreen" aria-label="전체 화면 전환">⛶</button></nav></header>`;
}

function footer() {
  return `<footer class="site-footer"><span>익숙한 물건에서 발견하는, 뜻밖의 가격.</span><span>조달청 API · ${esc(referenceDate())} 기준 <button data-action="about" class="footer-link">데이터 안내</button></span></footer>`;
}

function imageLabel(q) {
  return q.image.kind === 'product-photo' ? '나라장터 등록 상품 사진' : '나라장터 등록 제품 이미지';
}

function photo(q, className = '', loading = 'eager') {
  return `<img class="product-photo ${className}" src="${esc(q.image.src)}" alt="${esc(q.image.alt)}" decoding="async" loading="${loading}">`;
}

// 랭킹은 문제은행 버전 + 규칙 버전마다 하나입니다.
const rankingKey = () => screen !== 'home' && state ? state.rankingSet : rankingSet(data.bankVersion);
const mySubmission = () => ranking.submitted[rankingKey()] ?? null;
function saveRanking() { write(storageKeys.ranking, ranking); }
function clientId() {
  if (!ranking.clientId) {
    ranking.clientId = crypto.randomUUID();
    saveRanking();
  }
  return ranking.clientId;
}

function rankingRows(rows, mine = null) {
  if (!rows.length) return '<li class="art-ranking-message"><strong>첫 번째 가격 고수를 기다려요!</strong><span>게임을 마치고 나만의 기록을 남겨 보세요.</span></li>';
  return rows.map(r => {
    const isMine = mine && r.nickname === mine.nickname && r.totalScore === mine.totalScore;
    return `<li class="art-ranking-row${isMine ? ' is-mine' : ''}"><span class="art-ranking-place${r.rank <= 3 ? ` is-top-${r.rank}` : ''}" aria-label="${r.rank}위">${r.rank}</span><span class="art-ranking-name" title="${esc(r.nickname)}">${esc(r.nickname)}${isMine ? '<small>내 기록</small>' : ''}</span><span class="art-ranking-correct">${r.perfectCount}<small> / ${r.questionCount}</small></span><strong class="art-ranking-score">${number(r.totalScore)}<small>점</small></strong></li>`;
  }).join('');
}

async function loadRankingList(selector, mine = null) {
  const list = document.querySelector(selector);
  if (!list) return;
  list.setAttribute('aria-busy', 'true');
  list.innerHTML = '<li class="art-ranking-message is-loading"><strong>가격 고수들을 찾고 있어요…</strong><span>잠시만 기다려 주세요.</span></li>';
  try {
    const rows = await fetchLeaderboard(LEADERBOARD_CONFIG, { questionSet: rankingKey(), limit: 20 });
    if (list.isConnected) list.innerHTML = rankingRows(rows, mine);
  } catch (error) {
    if (list.isConnected) list.innerHTML = `<li class="art-ranking-message"><strong>기록을 불러오지 못했어요</strong><span>${esc(error.message)}</span><button type="button" class="art-ranking-retry" data-action="retry-ranking">다시 불러오기</button></li>`;
  } finally {
    if (list.isConnected) list.setAttribute('aria-busy', 'false');
  }
}

function rankingPanel(registration = false) {
  if (!rankingOn) return '';
  const mine = mySubmission();
  // 기기마다 최고 점수 하나만 남습니다. 게임마다 한 번 등록할 수 있고, 더 높을 때만 기록이 바뀝니다.
  const best = mine ? `<div class="art-ranking-best"><span>내 최고 기록<strong>${number(mine.totalScore)}<small>점</small></strong></span><p>등록 당시 ${number(mine.rank)}위${registration && state.rankSubmitted ? '<br>기록 등록 완료!' : '<br>더 높은 점수에 도전해 보세요!'}</p></div>` : '';
  const form = registration && state.rankEligible && !state.rankSubmitted ? `<form id="ranking-form" class="art-ranking-form"><label for="ranking-nickname">이번 기록 <strong>${number(totalScore(state.rounds))}점</strong><span>닉네임을 정하고 기록을 남겨 보세요.</span></label><div class="art-ranking-entry"><input id="ranking-nickname" name="nickname" maxlength="${NICKNAME_MAX}" autocomplete="nickname" placeholder="닉네임 · 최대 ${NICKNAME_MAX}자" aria-describedby="ranking-error" value="${esc(ranking.nickname)}" required><button type="submit" class="art-ranking-submit">랭킹에 등록하기</button></div><p id="ranking-error" class="art-ranking-error" role="alert"></p></form>` : '';
  return `<section class="art-ranking-screen"><div class="art-ranking-stage">
    <img class="art-ranking-mascot art-ranking-bird" src="./assets/designer/result-bird.png" alt="" aria-hidden="true" draggable="false">
    <img class="art-ranking-mascot art-ranking-squirrel" src="./assets/designer/result-backpack.png" alt="" aria-hidden="true" draggable="false">
    <div class="art-ranking-panel">
      <header class="art-ranking-header"><div><p>나라장터 가격 퀴즈</p><h2 id="dialog-title">온라인 랭킹</h2></div><button type="button" class="art-ranking-close" data-action="close-dialog" aria-label="랭킹 닫기" autofocus>×</button></header>
      <p class="art-ranking-intro">오늘의 가격 고수 <strong>TOP 20</strong></p>
      ${best}${form}
      <div class="art-ranking-columns" aria-hidden="true"><span>순위</span><span>닉네임</span><span>정답</span><span>점수</span></div>
      <ol id="ranking-list" class="art-ranking-list" aria-label="온라인 랭킹 상위 20명" aria-live="polite" tabindex="0"></ol>
    </div>
  </div></section>`;
}

async function submitRanking() {
  if (rankingBusy || !state?.rankEligible || state.rankSubmitted || state.phase !== 'results') return;
  const input = document.querySelector('#ranking-nickname');
  const error = document.querySelector('#ranking-error');
  const nickname = normalizeNickname(input?.value);
  if (!nickname) { error.textContent = `닉네임은 1~${NICKNAME_MAX}자로 입력해 주세요.`; input?.focus(); return; }
  error.textContent = '';
  rankingBusy = true;
  const button = document.querySelector('#ranking-form button');
  if (button) { button.disabled = true; button.textContent = '등록하는 중…'; }
  try {
    const result = await submitScore(LEADERBOARD_CONFIG, buildSubmission({ questionSet: state.questionSet, clientId: clientId(), nickname, rounds: state.rounds }));
    const previous = mySubmission();
    const total = totalScore(state.rounds);
    ranking.nickname = nickname;
    // 서버는 이 기기의 최고 기록을 돌려줍니다. 이번 점수가 더 낮으면 예전 기록(닉네임 포함)이 그대로입니다.
    const kept = result.totalScore > total;
    ranking.submitted[rankingKey()] = { nickname: kept ? previous?.nickname ?? nickname : nickname, rank: result.rank, totalScore: result.totalScore };
    state.rankSubmitted = true;
    saveRanking(); persist();
    render({ focus: false });
    showRanking(true);
    notify(kept ? `최고 기록 ${number(result.totalScore)}점(${number(result.rank)}위)이 그대로 유지돼요.` : previous ? `최고 기록 갱신! ${number(result.rank)}위예요.` : `${number(result.rank)}위로 등록했어요!`);
  } catch (e) {
    if (e.code === 'already_submitted') { state.rankSubmitted = true; persist(); render({ focus: false }); showRanking(true); notify(e.message); return; }
    if (button?.isConnected) { button.disabled = false; button.textContent = '랭킹에 등록하기'; }
    if (error?.isConnected) error.textContent = e.message;
  } finally {
    rankingBusy = false;
  }
}

function showRanking(registration = false) {
  dialogHistory.length = 0;
  dialog.className = 'art-ranking-dialog';
  dialog.innerHTML = rankingPanel(registration);
  if (!dialog.open) dialog.showModal();
  loadRankingList('#ranking-list', mySubmission());
}

function render({ focus = true, keepFeedback = false } = {}) {
  effects.reset({ keepFeedback });
  guessBusy = false;
  dialogHistory.length = 0;
  if (dialog.open) dialog.close();
  const content = screen === 'home' ? home() : state.phase === 'question' ? question() : state.phase === 'reveal' ? reveal() : results();
  app.innerHTML = (LEADERBOARD_CONFIG.preview ? '<div class="preview-banner">로컬 미리보기 · 랭킹은 이 PC의 테스트 기록이에요.</div>' : '') + header() + `<main id="main-content" tabindex="-1">${content}</main>` + footer();
  document.body.classList.toggle('game-active', screen !== 'home');
  document.body.classList.toggle('question-art', screen !== 'home' && state.phase === 'question');
  document.body.classList.toggle('title-art', screen === 'home');
  document.body.classList.toggle('result-art', screen !== 'home' && state.phase === 'results');
  document.body.classList.toggle('reveal-art', screen !== 'home' && state.phase === 'reveal');
  if (screen !== 'home' && state.phase === 'question') {
    if (focus && !usesTouchControls()) document.querySelector('#guess')?.focus({ preventScroll: true });
  } else if (focus) document.querySelector('#screen-heading')?.focus({ preventScroll: true });
  if (screen !== 'home' && state.phase === 'results') loadKakao();
  effects.idle();
  effects.syncMusic();
  app.dispatchEvent(new Event('game-rendered'));
}

function musicControl() {
  return `<button type="button" data-action="music" aria-pressed="${musicOn}" aria-label="${musicOn ? '배경음악 끄기' : '배경음악 켜기'}">BGM <span class="sound-state">${musicOn ? 'ON' : 'OFF'}</span></button>`;
}

function home() {
  const hasResume = Boolean(state);
  const label = (text, tone) => `<span class="art-title-label ${tone}" data-label="${text}" aria-hidden="true">${text}</span>`;
  return `<section class="art-title-screen" aria-label="처음 화면"><div class="art-title-stage">
    <h1 id="screen-heading" class="art-main-title" tabindex="-1"><span>맨날 보던 물건,</span><span>이게 얼마게?</span></h1>
    <img class="art-title-podium" src="./assets/designer/title-podium.png" alt="" aria-hidden="true" draggable="false">
    <form id="setup-form" aria-label="새 게임 시작">
      <button type="submit" class="art-title-action art-title-start" aria-label="${hasResume ? '새 게임 시작하기' : '게임 시작하기'}">${label('게임시작', 'title-blue')}</button>
    </form>
    <button type="button" class="art-title-action art-title-ranking" data-action="ranking" aria-label="온라인 랭킹 보기" ${rankingOn ? '' : 'disabled title="온라인 랭킹 준비 중"'}>${label('랭킹', 'title-orange')}</button>
    <button type="button" class="art-title-action art-title-exit" data-action="exit" aria-label="게임 종료">${label('게임종료', 'title-red')}</button>
    <details class="art-menu art-popover art-title-menu"><summary>메뉴</summary><nav class="art-popover-content art-menu-content" aria-label="게임 안내">
      ${hasResume ? `<button type="button" class="art-title-resume" data-action="resume">${state.phase === 'results' ? '지난 결과 다시 보기' : `${state.index + 1}번째 문제부터 이어하기`}</button>` : ''}
      <button type="button" data-action="rules">점수 안내</button><button type="button" data-action="about">데이터 기준</button>
      <button type="button" data-action="sound" aria-label="${soundOn ? '효과음 끄기' : '효과음 켜기'}" aria-pressed="${soundOn}">효과음 <span class="sound-state">${soundOn ? 'ON' : 'OFF'}</span></button>${musicControl()}
      <button type="button" data-action="fullscreen" aria-label="전체 화면 전환">전체 화면</button>
      <p>${ROUND_COUNT}라운드 · ${MAX_ATTEMPTS}번의 기회 · 정답 ±${TOLERANCE_PERCENT}%<br>${scoreList}점${best > 0 ? `<br>이 기기 최고 기록 ${number(best)} / ${number(MAX_TOTAL)}점` : ''}</p>
    </nav></details>
  </div></section>`;
}

function progress() {
  const questions = gameQuestions();
  return `<div class="round-progress"><div class="round-counter"><span>ROUND</span><strong>${String(state.index + 1).padStart(2, '0')}</strong><span>/ ${questions.length}</span></div><div class="progress-dots" aria-label="${state.index + 1} / ${questions.length} 라운드">${questions.map((_, i) => `<span class="${i < state.index ? 'done' : i === state.index ? 'current' : ''}"></span>`).join('')}</div><div class="game-score"><span>누적 점수</span><strong>${number(totalScore(state.rounds))}<small>점</small></strong></div></div>`;
}

function productFigure(q, small = false) {
  return `<figure class="product-figure real-photo-figure ${small ? 'figure-small' : ''}"><span class="figure-index">ITEM ${String(state.index + 1).padStart(2, '0')}</span><button class="photo-enlarge" data-action="photo" data-id="${q.id}" aria-label="${esc(q.title)} 이미지 크게 보기">${photo(q)}</button><figcaption class="figure-bottom"><span>${esc(q.quantity)} 기준</span><small>${imageLabel(q)}<br><span>눌러서 크게 보기 ↗</span></small></figcaption></figure>`;
}

function conditions(q) {
  return `<div class="art-tags"><span>#${esc(q.quantity)} 기준</span><span>#${esc(deliveryLabel(q))}</span><span>#${esc(vatLabel(q))}</span></div>${q.pricePolicy?.notice ? `<p class="basis-note price-policy-note">${esc(q.pricePolicy.notice)}</p>` : ''}`;
}

function retryFeedback(q) {
  if (!state.attempts.length) return '';
  const last = state.attempts.at(-1);
  const hint = guessHint(last, q.answer);
  const history = state.attempts.map((value, i) => `${i + 1}차 ${number(value)}원 ${guessHint(value, q.answer).direction === 'UP' ? '↗' : '↘'}`).join('<br>');
  return `<div class="retry-feedback ${hint.direction.toLowerCase()}" role="status"><div class="retry-direction">${hint.direction}<span aria-hidden="true">${hint.direction === 'UP' ? '↗' : '↘'}</span></div><div><strong>${hint.label}</strong><p>${hint.instruction}</p><small>${history}</small></div></div>`;
}

function question() {
  const q = gameQuestions()[state.index];
  const attempt = state.attempts.length + 1;
  const retry = attempt > 1;
  const last = attempt === MAX_ATTEMPTS;
  const left = MAX_ATTEMPTS - state.attempts.length;
  const hint = retry ? guessHint(state.attempts.at(-1), q.answer) : null;
  const art = name => `./assets/designer/${name}.png`;
  const decoration = (name, cls) => `<img class="art-decoration ${cls}" src="${art(name)}" alt="" aria-hidden="true" draggable="false">`;
  const bubble = (tail = 'left') => `<span class="art-bubble-body" aria-hidden="true"></span><img class="art-bubble-tail" src="${art(`bubble-tail-${tail}`)}" alt="">`;
  const audience = ['left', 'center', 'right', 'left', 'center', 'right', 'left'].map((name, i) => decoration(`audience-${name}`, `art-audience art-person-${i + 1}`)).join('');
  return `<section class="art-game" aria-label="가격 맞히기 게임"><form id="guess-form" novalidate>
    <div class="art-stage">
      <details class="art-menu art-popover"><summary>메뉴</summary><nav class="art-popover-content art-menu-content" aria-label="게임 도구"><button type="button" data-action="home">처음 화면</button><button type="button" data-action="rules">점수 안내</button>${rankingOn ? '<button type="button" data-action="ranking" aria-label="온라인 랭킹 보기">온라인 랭킹</button>' : ''}<button type="button" data-action="about">데이터 기준</button><button type="button" data-action="sound" aria-label="${soundOn ? '효과음 끄기' : '효과음 켜기'}" aria-pressed="${soundOn}">효과음 <span class="sound-state">${soundOn ? 'ON' : 'OFF'}</span></button>${musicControl()}<button type="button" data-action="fullscreen" aria-label="전체 화면 전환">전체 화면</button><p>${esc(referenceDate())} 조사 기준<br>정답 ±${TOLERANCE_PERCENT}% · 최대 ${MAX_ATTEMPTS}번 추측</p></nav></details>
      ${decoration('product-frame', 'art-frame')}
      ${decoration('judge-nareumi', 'art-judge-left')}
      ${decoration('judge-dali', 'art-judge-right')}
      <div class="art-board-content">
        <h1 id="screen-heading" class="art-title" tabindex="-1"><span class="art-product-name">${esc(q.title)}</span> <span class="art-question-prompt">얼마일까요?</span></h1>
        <figure class="art-product">${photo(q)}</figure>
        <div class="art-board-footer"><div class="art-conditions" role="group" aria-label="가격 기준">${conditions(q)}</div></div>
      </div>
      <div class="art-round" aria-label="${state.index + 1} / ${state.questionCount} 라운드">Round ${state.index + 1}<span class="art-sr-only"> / ${state.questionCount}</span></div>
      <div class="art-hint retry-feedback ${hint ? hint.direction.toLowerCase() : 'neutral'}" role="status" aria-label="${hint ? esc(`${hint.direction}. ${hint.label}. ${hint.instruction}`) : '첫 번째 가격을 추측해 보세요'}">${bubble()}<span class="art-hint-word" aria-hidden="true">${hint ? `${hint.direction}!` : '?'}</span></div>
      <span class="art-score-label" id="art-score-label">현재스코어</span>
      <div class="art-score">${bubble()}<output aria-labelledby="art-score-label">${number(totalScore(state.rounds))}</output></div>
      ${decoration('wooden-front', 'art-wood')}${audience}
      <div class="art-lower">
      ${retry ? `<div class="art-feedback" tabindex="0" aria-label="가격 힌트">${retryFeedback(q)}</div>` : ''}
      <div class="art-controls">
      <span id="art-attempt" class="art-attempt"><span>${last ? '마지막 기회' : `${attempt}번째 추측`} · ${attempt} / ${MAX_ATTEMPTS}</span><span>성공 시 ${number(ATTEMPT_SCORES[attempt - 1])}점</span></span>
      <div class="art-price-bubble">${bubble('center')}
        <label for="guess" class="art-sr-only">${last ? '마지막 예상 등록 계약단가' : '예상 등록 계약단가'}</label>
        <div class="art-price-entry"><input id="guess" name="guess" type="text" inputmode="numeric" autocomplete="off" maxlength="15" value="${esc(state.draft || '')}" placeholder="0" style="--amount-chars:${Math.max(7, (state.draft || '').length)}" aria-describedby="guess-error art-attempt"><span class="art-currency">원</span></div>
        <button class="guess-submit" type="submit" aria-label="${last ? '마지막 추측! 정답 확인하기' : `${attempt}번째 추측 제출하기`}">${last ? '마지막 제출' : '추측 제출'}</button>
        <p class="art-guess-error" id="guess-error" role="alert"></p>
        <div class="art-quick" role="group" aria-label="예상 가격 조절">${QUICK_STEPS.map(([amount, label]) => `<button type="button" data-action="add" data-amount="${amount}" aria-label="${label}원 더하기">+${label.replace(',', '')}</button>`).join('')}<button type="button" data-action="clear" class="art-clear" aria-label="예상 가격 지우기">↺</button></div>
      </div>
      </div>
      <div class="art-lives" role="img" aria-label="남은 추측 기회 ${left} / ${MAX_ATTEMPTS}">${Array.from({ length: MAX_ATTEMPTS }, (_, i) => `<img src="${art('heart')}" alt="" class="${i >= left ? 'spent' : ''}">`).join('')}</div>
      </div>
    </div>
  </form></section>`;
}

function formatError(guess, answer) {
  const error = relativeError(guess, answer);
  if (Math.abs(error) < .00001) return '정확히 일치';
  const percent = Math.abs(error).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
  return `정답보다 ${percent}% ${error > 0 ? '높게' : '낮게'}`;
}

function knowledge(index, compact = false) {
  const card = state.triviaRounds[index];
  const source = card.sources[0];
  const sourceControl = `<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">출처 · ${esc(source.publisher)} ↗</a>`;
  return `<aside class="inline-knowledge ${compact ? 'compact-knowledge' : ''}" data-trivia-id="${esc(card.id)}" aria-label="${index + 1}라운드 틈새 지식"><div class="knowledge-mark" aria-hidden="true">✦</div><div class="knowledge-copy"><span class="eyebrow">알아두면 쓸모있는 틈새 지식</span><h${compact ? '4' : '2'}>${esc(card.title)}</h${compact ? '4' : '2'}><p class="knowledge-text">${esc(card.text)}</p><div class="knowledge-source"><span>기준 · ${esc(card.period)}</span>${sourceControl}</div></div></aside>`;
}

// 정답을 먼저 보여 주고 마지막 추측과 오차를 보조 정보로 표시한다.
function priceCompare(q, round) {
  const guess = round.attempts.at(-1);
  const error = Math.abs(relativeError(guess, q.answer));
  const matched = round.score > 0;
  const label = matched ? (error < .00001 ? '오차 0% · 정확히 맞혔어요' : `오차 ${error.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%로 맞혔어요`) : `마지막 추측은 ${formatError(guess, q.answer)}`;
  const cell = (title, value, cls) => `<div class="compare-cell ${cls}" style="--digits:${number(value).length + 1}"><span>${title}</span><strong>${money(value)}</strong></div>`;
  return `<div class="price-compare">${cell('정답 · 등록 계약단가', q.answer, 'actual')}${cell(`내 추측 · ${round.attempts.length}번째`, guess, 'mine')}</div><p class="error-badge">${matched ? '✓ ' : ''}${label}</p>`;
}

function reveal() {
  const q = gameQuestions()[state.index];
  const round = state.rounds[state.index];
  const verdict = judge(round.score);
  const matched = round.score > 0;
  const knowledgeContent = knowledge(state.index);
  return `<section class="art-reveal-screen" aria-label="라운드 정답 공개"><div class="art-reveal-stage">
    <img class="art-reveal-nareumi" src="./assets/designer/judge-nareumi.png" alt="" aria-hidden="true" draggable="false"><img class="art-reveal-dali" src="./assets/designer/judge-dali.png" alt="" aria-hidden="true" draggable="false">
    <div class="art-reveal-topline">
        <details class="art-reveal-menu"><summary>메뉴</summary><nav class="art-popover-content art-menu-content" aria-label="정답 화면 도구"><button type="button" data-action="home">처음 화면</button><button type="button" data-action="rules">점수 안내</button><button type="button" data-action="about">데이터 기준</button><button type="button" data-action="source" data-id="${q.id}">계약 정보·출처</button><button type="button" data-action="sound" aria-label="${soundOn ? '효과음 끄기' : '효과음 켜기'}" aria-pressed="${soundOn}">효과음 <span class="sound-state">${soundOn ? 'ON' : 'OFF'}</span></button>${musicControl()}<button type="button" data-action="fullscreen" aria-label="전체 화면 전환">전체 화면</button></nav></details>
        <div class="art-reveal-total"><div class="art-reveal-total-surface"><span>현재 스코어</span><strong style="--digits:${number(totalScore(state.rounds)).length + 1}">${number(totalScore(state.rounds))}<small>점</small></strong></div></div>
    </div>
    <div class="art-reveal-board ${matched ? 'is-correct' : 'is-missed'}">
      <header class="art-reveal-header"><div class="art-reveal-counter"><span>Round</span><strong>${state.index + 1}<small> / ${state.questionCount}</small></strong></div><p class="art-reveal-tag">${matched ? verdict.tag : `${MAX_ATTEMPTS}번 모두 틀렸어요`}</p><h1 id="screen-heading" tabindex="-1">${verdict.title}</h1><div class="art-reveal-earned"><span>획득 점수</span><strong>${matched ? '+' : ''}${number(round.score)}점</strong></div></header>
      <div class="art-reveal-answer" aria-label="정답과 내 추측 비교">
        <section class="art-reveal-product"><button type="button" class="art-reveal-photo" data-action="photo" data-id="${q.id}" aria-label="${esc(q.title)} 이미지 크게 보기">${photo(q)}</button><h2>${esc(q.title)}</h2><div class="art-reveal-conditions"><span>${esc(q.quantity)}</span><span>${esc(deliveryLabel(q))}</span><span>${esc(vatLabel(q))}</span></div></section>
        <div class="art-reveal-prices">${priceCompare(q, round)}</div>
      </div>
    </div>
    <footer class="art-reveal-footer"><aside class="art-reveal-info" aria-label="나라장터 상식">${knowledgeContent}</aside><button type="button" class="art-reveal-next" data-action="next">${state.index === state.questionCount - 1 ? '최종 결과 확인하기' : '다음 물건 만나러 가기'} <span aria-hidden="true">→</span></button></footer>
  </div></section>`;
}

function results() {
  const questions = gameQuestions();
  const total = totalScore(state.rounds);
  const verdict = grade(total, questions.length);
  const correct = state.rounds.filter(r => r.score > 0).length;
  const firstTry = state.rounds.filter(r => r.score === ATTEMPT_SCORES[0]).length;
  const mine = mySubmission();
  const rankLabel = state.rankSubmitted && mine ? `내 최고 기록 · 등록 당시 ${number(mine.rank)}위!` : '랭킹에 등록하기';
  const honor = total === MAX_TOTAL ? `${number(MAX_TOTAL)}점 만점!` : state.newBest ? '이 기기 최고 기록!' : '';
  return `<section class="art-result-screen" aria-label="최종 결과"><div class="art-result-stage">
    <img class="art-result-bird" src="./assets/designer/result-bird.png" alt="" aria-hidden="true" draggable="false">
    <img class="art-result-backpack" src="./assets/designer/result-backpack.png" alt="" aria-hidden="true" draggable="false">
    <div class="art-result-panel">
      <output class="art-result-score" style="--score-length:${number(total).length + 1}" aria-label="최종 점수 ${number(total)}점">${number(total)}점</output>
      <div class="art-result-identity"><p class="art-result-prompt${honor ? ' fx-result-honor' : ''}">${honor || '당신은...'}</p><h1 id="screen-heading" class="art-result-grade" tabindex="-1" style="--grade-length:${verdict.title.length}">${esc(verdict.title)}</h1></div>
      <img class="art-result-wave" src="./assets/designer/result-wave.png" alt="" aria-hidden="true" draggable="false">
      ${rankingOn ? `<button type="button" class="art-result-rank" data-action="result-ranking">${rankLabel}</button>` : `<p class="art-result-rank">최고 기록 ${number(Math.max(best, total))}점</p>`}
      <div class="art-result-actions"><button type="button" class="art-result-kakao" data-action="share-kakao">카카오톡 공유</button><div class="art-result-primary"><button type="button" class="art-result-share" data-action="share-system">공유하기</button><button type="button" class="art-result-replay" data-action="replay">다시하기</button></div></div>
    </div>
    <details class="art-menu art-popover art-result-menu"><summary>메뉴</summary><nav class="art-popover-content art-menu-content" aria-label="결과 도구">
      <button type="button" data-action="result-details">결과 자세히</button>${rankingOn ? '<button type="button" data-action="result-ranking">랭킹 등록·조회</button>' : ''}
      <button type="button" data-action="share">결과 복사</button>
      <button type="button" data-action="home">처음 화면</button><button type="button" data-action="about">데이터 기준</button>
      <button type="button" data-action="sound" aria-label="${soundOn ? '효과음 끄기' : '효과음 켜기'}" aria-pressed="${soundOn}">효과음 <span class="sound-state">${soundOn ? 'ON' : 'OFF'}</span></button>${musicControl()}<button type="button" data-action="fullscreen" aria-label="전체 화면 전환">전체 화면</button>
    </nav></details>
  </div><template id="result-details-template"><section class="art-result-summary"><h2>${esc(verdict.title)}</h2><p>${esc(verdict.subtitle)}</p><div class="final-metrics"><span>맞힌 문제 <strong>${correct}개</strong></span><span>한 번에 맞힌 문제 <strong>${firstTry}개</strong></span><span>최고 기록 <strong>${number(Math.max(best, total))}점</strong></span></div></section><div class="recap-heading"><div><span class="eyebrow">가격과 틈새 지식, 함께 돌아보기</span><h2>오늘 만난 물건들</h2></div><button class="text-button" data-action="download">결과 저장 ↓</button></div><div class="recap-list">${questions.map((q, i) => {
    const round = state.rounds[i];
    return `<article class="recap-entry"><div class="recap-row"><span class="recap-number">${String(i + 1).padStart(2, '0')}</span><button class="recap-art" data-action="photo" data-id="${q.id}" aria-label="${esc(q.title)} 이미지 크게 보기">${photo(q, '', 'lazy')}</button><div class="recap-item"><h3>${esc(q.title)}</h3><span>${esc(q.quantity)} · ${esc(deliveryLabel(q))}</span><button class="source-link" data-action="source" data-id="${q.id}">출처 ↗</button></div><div class="recap-answer"><small>등록 계약단가</small><strong>${number(q.answer)}<span>원</span></strong><div class="recap-guesses">${round.attempts.map((value, attempt) => `<span>${attempt + 1}차 ${number(value)}원</span>`).join('')}<b>+${number(round.score)}점</b></div></div></div>${knowledge(i, true)}</article>`;
  }).join('')}</div><div class="result-bottom"><p>모든 정답은 ${esc(referenceDate())} 기준 등록 계약단가입니다.<br>실제 지급총액과 다르며, 계약·할인·인도조건에 따라 달라질 수 있습니다.</p><button class="text-button" data-action="home">처음 화면으로 돌아가기 →</button></div></template></section>`;
}

function presentQuestion({ curtain = false } = {}) {
  const session = state;
  const stage = document.querySelector('.art-stage');
  effects.enterRound({ curtain }).then(completed => {
    if (completed && state === session && stage?.isConnected && screen === 'game' && !usesTouchControls() && !app.inert && !dialog.open) {
      document.querySelector('#guess')?.focus({ preventScroll: true });
    }
  });
}

function startGame() {
  effects.unlock();
  // 매 게임 랭킹에 등록할 수 있습니다. 기기마다 최고 점수만 남습니다.
  state = createSession(data, triviaPool, rankingOn);
  screen = 'game';
  persist();
  render({ focus: false });
  presentQuestion({ curtain: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function submitGuess() {
  if (guessBusy || effects.isSceneBusy() || screen !== 'game' || state.phase !== 'question') return;
  const value = parseGuess(document.querySelector('#guess').value);
  if (value === null) {
    document.querySelector('#guess-error').textContent = '1원 이상 숫자로 입력해 주세요.';
    document.querySelector('#guess').setAttribute('aria-invalid', 'true');
    document.querySelector('#guess').focus();
    effects.invalid();
    return;
  }
  const q = gameQuestions()[state.index];
  const correct = isCorrect(value, q.answer);
  const previousTotal = totalScore(state.rounds);
  const submittedSession = state;
  const submittedStage = document.querySelector('.art-stage');
  guessBusy = true;
  state.attempts.push(value);
  state.draft = '';
  // 틀렸고 기회가 남았으면 힌트를 보여주고 다시 추측합니다.
  const retry = !correct && state.attempts.length < MAX_ATTEMPTS;
  const spentIndex = MAX_ATTEMPTS - state.attempts.length;
  if (!retry) {
    state.rounds.push({ candidateId: q.id, attempts: [...state.attempts], score: scoreRound(state.attempts, q.answer) });
    state.attempts = [];
    state.phase = 'reveal';
  }
  // Save the valid result immediately; animation never owns game progress.
  persist();
  const completed = await effects.react({ correct, spentIndex, retry });
  if (!completed || state !== submittedSession || !submittedStage.isConnected || screen !== 'game') return;
  render({ keepFeedback: true });
  if (retry) effects.retry({ lastChance: state.attempts.length === MAX_ATTEMPTS - 1 });
  else effects.reveal(state.rounds[state.index].score, previousTotal);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function nextQuestion() {
  if (effects.isSceneBusy() || state.phase !== 'reveal') return;
  const session = state;
  const stage = document.querySelector('.art-reveal-stage');
  if (state.index === state.questionCount - 1) {
    const total = totalScore(state.rounds);
    state.phase = 'results';
    state.newBest = total > best;
    best = Math.max(best, total);
    write(storageKeys.best, best);
  } else {
    state.index++;
    state.phase = 'question';
    state.draft = '';
  }
  persist();
  const completed = await effects.exitReveal();
  if (!completed || state !== session || !stage?.isConnected || screen !== 'game') return;
  render({ focus: state.phase !== 'question' });
  if (state.phase === 'question') presentQuestion();
  else effects.announceResults({ total: totalScore(state.rounds), maxScore: MAX_TOTAL, newBest: !!state.newBest });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function openDialog(title, body, wide = false) {
  if (dialog.open) dialogHistory.push({ nodes: [...dialog.childNodes], className: dialog.className, scroll: dialog.scrollTop, contentScroll: dialog.querySelector('.dialog-content')?.scrollTop ?? 0, trigger: document.activeElement });
  dialog.classList.remove('art-ranking-dialog');
  dialog.classList.toggle('wide-dialog', wide);
  dialog.innerHTML = `<div class="dialog-heading">${dialogHistory.length ? '<button type="button" class="dialog-back" data-action="close-dialog" aria-label="이전 창으로 돌아가기">←</button>' : ''}<h2 id="dialog-title">${title}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="${dialogHistory.length ? '닫고 이전 창으로' : '닫기'}" autofocus>×</button></div><div class="dialog-content" tabindex="0">${body}</div>`;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  dialog.querySelector('[autofocus]')?.focus({ preventScroll: true });
}

function showPhoto(id) {
  const q = findQuestion(id);
  if (!q) return;
  openDialog(esc(q.title), `<div class="photo-viewer">${photo(q)}</div><p class="photo-caption">${imageLabel(q)} · 물품식별번호 ${esc(q.productId)}</p><p class="dialog-small">${esc(q.specification)}</p><a class="external-link" href="${esc(q.image.sourceUrl)}" target="_blank" rel="noopener noreferrer">나라장터 원본 이미지 보기 ↗</a>`, true);
}

function showAbout() {
  openDialog('가격표의 기준을 알려드려요', `<span class="dialog-badge">${esc(referenceDate())} 조사 스냅샷</span><p>이 게임은 <strong>나라장터쇼핑몰에 실제 등록된 물품</strong>의 계약단가를 맞히는 퀴즈입니다.</p><dl class="info-definitions"><div><dt>어떤 가격인가요?</dt><dd>해당 모델의 계약단위 한 단위에 대한 등록 계약단가입니다. 실제 구매·지급총액을 뜻하지 않습니다. 문제의 규격·수량·인도조건·부가세를 함께 확인해 주세요.</dd></div><div><dt>지금 가격과 같나요?</dt><dd>${esc(referenceDate())}에 확인한 가격입니다. 이후 계약·할인·등록 상태가 달라질 수 있습니다. 물건별 등록 계약단가를 기준으로 출제하며, 할인 정보는 정답 계산에 반영하지 않습니다.</dd></div><div><dt>상품 이미지에 관하여</dt><dd>각 물품식별번호에 연결된 나라장터 공식 상품 이미지를 사용합니다. 원본을 수정하지 않았으며, 그네와 조합놀이대는 공급업체가 등록한 제품 이미지입니다. 이미지 크게 보기에서 출처를 확인할 수 있습니다.</dd></div><div><dt>힌트와 틈새 지식</dt><dd>추측이 정답의 ±${TOLERANCE_PERCENT}% 밖이면 UP/DOWN과 대략적인 차이를 알려드리고, 물건마다 최대 ${MAX_ATTEMPTS}번 추측할 수 있습니다. 틈새 지식은 물건과 별도로 매 게임 10개를 중복 없이 배정하며, 정답·점수 화면과 최종 결과표에 표시합니다. 이어하기에도 같은 지식이 유지됩니다.</dd></div></dl><p class="dialog-small">본 게임은 조달청 공식 서비스가 아닌 공모전 준비용 프로토타입입니다. 기록은 이 브라우저에 저장됩니다.</p><a class="external-link" href="${esc(data.catalogUrl)}" target="_blank" rel="noopener noreferrer">공식 API 안내 확인하기 ↗</a>`);
}

function showRules() {
  openDialog('힌트를 보고 범위 안으로 좁혀요', `<p>매 게임 문제은행에서 <strong>${ROUND_COUNT}문제</strong>가 무작위로 나와요. 물건마다 <strong>최대 ${MAX_ATTEMPTS}번</strong> 추측할 수 있고, 추측이 <strong>정답의 ±${TOLERANCE_PERCENT}% 안</strong>이면 성공이에요.</p><div class="score-examples"><div><span>UP ↗</span><strong>예상보다 더 비싸요</strong></div><div><span>DOWN ↘</span><strong>예상보다 더 저렴해요</strong></div><div><span>차이의 정도</span><strong>조금 · 꽤 · 많이 · 아주 많이</strong></div></div><p class="rules-paragraph"><strong>빨리 맞힐수록 높은 점수</strong>를 받아요. ${scoreList}점이고, ${MAX_ATTEMPTS}번 모두 틀리면 0점이에요. 범위 안이면 정답과 얼마나 가까운지는 점수에 영향이 없어요.</p><p class="rules-paragraph">시간 제한은 없어요. ${ROUND_COUNT}문제를 모두 한 번에 맞히면 최고 ${number(MAX_TOTAL)}점이에요.</p><details class="formula"><summary>힌트 기준 보기</summary><code>조금: 1.5배 이내 · 꽤: 2배 이내 · 많이: 5배 이내 · 아주 많이: 5배 초과</code></details>`);
}

function showSource(id) {
  const q = findQuestion(id);
  if (!q) return;
  openDialog('이 물건의 계약 정보', `<span class="dialog-badge">공식 API 확인 · ${esc(referenceDate())}</span><h3 class="source-title">${esc(q.title)}</h3><div class="source-price">${money(q.answer)} <small>/ ${esc(q.unit)}</small></div><dl class="source-table"><div><dt>규격 원문</dt><dd>${esc(q.specification)}</dd></div><div><dt>물품식별번호</dt><dd>${esc(q.productId)}</dd></div><div><dt>계약번호 / 순번</dt><dd>${esc(q.contractNumber)} / ${esc(q.contractLine)}</dd></div><div><dt>공급업체</dt><dd>${esc(q.supplier)}</dd></div><div><dt>계약기간</dt><dd>${esc(q.contractStart)} ~ ${esc(q.contractEnd)}</dd></div><div><dt>인도조건 / 부가세</dt><dd>${esc(q.delivery)} / ${esc(q.vat)}</dd></div><div><dt>조회 시각</dt><dd>${esc(q.checkedAt)}</dd></div><div><dt>API</dt><dd class="api-operation">${esc(q.endpoint)}</dd></div></dl><p class="dialog-small">${esc(q.scope)}<br>이 금액은 품목 계약단가이며 실제 지급총액은 확인하지 않았습니다.</p><a class="external-link" href="${esc(q.image.sourceUrl)}" target="_blank" rel="noopener noreferrer">${imageLabel(q)} 원본 ↗</a><a class="external-link" href="${esc(data.catalogUrl)}" target="_blank" rel="noopener noreferrer">공공데이터포털에서 API 설명 보기 ↗</a><a class="download-link" href="./data.json" download="나라장터_가격퀴즈_검증데이터.json">출제 데이터 JSON 내려받기 ↓</a>`, true);
}

function shareResult() {
  const total = totalScore(state.rounds);
  return { total, maxScore: MAX_TOTAL, title: grade(total, state.questionCount).title, rounds: state.rounds, best: Math.max(best, total), newBest: !!state.newBest };
}

async function copyResults() {
  const text = buildShareText(shareResult());
  try { await navigator.clipboard.writeText(text); notify('결과를 복사했어요!'); }
  catch { openDialog('결과 복사', `<p>아래 내용을 선택해 복사해 주세요.</p><textarea class="share-fallback" aria-label="복사할 결과" readonly>${esc(text)}</textarea>`); dialog.querySelector('textarea')?.select(); }
}

function downloadResults() {
  const payload = { game: data.title, price_reference_date: referenceDate(), question_set: state.questionSet, played_at: new Date().toISOString(), question_count: state.questionCount, total_score: totalScore(state.rounds), rounds: gameQuestions().map((q, i) => ({ round: i + 1, title: q.title, product_id: q.productId, registered_contract_unit_price_krw: q.answer, quantity: q.quantity, delivery: q.delivery, attempts_krw: state.rounds[i].attempts, score: state.rounds[i].score, trivia: state.triviaRounds[i] })) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = '이게얼마게_플레이결과.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('submit', event => {
  if (event.target.id === 'setup-form') { event.preventDefault(); startGame(); }
  if (event.target.id === 'guess-form') { event.preventDefault(); submitGuess(); }
  if (event.target.id === 'ranking-form') { event.preventDefault(); submitRanking(); }
});

document.addEventListener('input', event => {
  if (event.target.id !== 'guess' || guessBusy) return;
  const input = event.target;
  const digits = input.value.replace(/\D/g, '').slice(0, 12);
  input.value = digits ? number(Number(digits)) : '';
  input.style.setProperty('--amount-chars', Math.max(7, input.value.length));
  document.querySelector('#guess-error').textContent = '';
  input.removeAttribute('aria-invalid');
  state.draft = input.value;
  persist();
});

document.addEventListener('error', event => {
  if (!(event.target instanceof HTMLImageElement) || !event.target.classList.contains('product-photo')) return;
  event.target.classList.add('image-unavailable');
  const canEnlarge = !event.target.closest('.art-product');
  event.target.alt = '상품 이미지를 불러오지 못했어요.' + (canEnlarge ? ' 이미지 크게 보기에서 원본 링크를 확인해 주세요.' : '');
  event.target.hidden = true;
  if (event.target.nextElementSibling?.classList.contains('product-photo-fallback')) return;
  const fallback = document.createElement('div');
  fallback.className = 'product-photo-fallback';
  fallback.setAttribute('role', 'img');
  fallback.setAttribute('aria-label', event.target.alt);
  fallback.innerHTML = '<span class="photo-fallback-mark" aria-hidden="true">▧</span><strong>상품 사진을 불러오지 못했어요</strong>' + (canEnlarge ? '<span>사진 정보에서 원본 링크를 확인해 주세요.</span>' : '');
  event.target.after(fallback);
}, true);

// 예상 가격 버튼: 윗줄은 더하기, 아랫줄은 빼기
const QUICK_STEPS = [[10000, '1만'], [100000, '10만'], [1000000, '100만'], [10000000, '1,000만'], [100000000, '1억']];
const quickAmountButtons = () => [1, -1].map(sign => QUICK_STEPS.map(([amount, label]) => `<button type="button" data-action="add" data-amount="${sign * amount}" class="${sign > 0 ? 'plus' : 'minus'}" aria-label="${label}원 ${sign > 0 ? '더하기' : '빼기'}">${sign > 0 ? '+' : '−'} ${label}</button>`).join('')).join('');

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (button.disabled) return;
  if (action === 'home') { screen = 'home'; render(); window.scrollTo({ top: 0, behavior: 'instant' }); }
  if (action === 'resume' && state) { screen = 'game'; render(); }
  if (action === 'exit') { if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); openDialog('게임 종료', `<p>게임을 마치려면 현재 브라우저 탭이나 창을 닫아 주세요.</p>${state && state.phase !== 'results' ? '<p>진행 기록은 이 브라우저에 저장되어 있어요. 다음에 열면 이어하기로 계속할 수 있어요.</p>' : ''}`); }
  if (action === 'add') {
    const input = document.querySelector('#guess'); if (!input) return;
    const next = Math.min(MAX_GUESS, (parseGuess(input.value) ?? 0) + Number(button.dataset.amount));
    input.value = next > 0 ? number(next) : '';
    input.dispatchEvent(new Event('input', { bubbles: true })); if (!usesTouchControls()) input.focus({ preventScroll: true });
  }
  if (action === 'clear') { const input = document.querySelector('#guess'); if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); if (!usesTouchControls()) input.focus({ preventScroll: true }); } }
  if (action === 'next' && state?.phase === 'reveal') nextQuestion();
  if (action === 'replay') startGame();
  if (action === 'about') showAbout();
  if (action === 'rules') showRules();
  if (action === 'ranking') showRanking();
  if (action === 'result-ranking') showRanking(true);
  if (action === 'retry-ranking') loadRankingList('#ranking-list', mySubmission());
  if (action === 'result-details') openDialog('오늘 만난 물건들', document.querySelector('#result-details-template').innerHTML, true);
  if (action === 'source') showSource(button.dataset.id);
  if (action === 'photo') showPhoto(button.dataset.id);
  if (action === 'close-dialog') closeDialog();
  // 공유는 사용자 제스처 안에서 불려야 하므로 await 없이 바로 부른다.
  if (action === 'share-kakao') shareKakao(shareResult(), notify);
  if (action === 'share-system') shareSystem(shareResult(), notify, copyResults);
  if (action === 'share') await copyResults();
  if (action === 'download') downloadResults();
  if (action === 'music') {
    musicOn = !musicOn;
    write('nara-price-music', musicOn);
    button.setAttribute('aria-pressed', String(musicOn));
    button.setAttribute('aria-label', musicOn ? '배경음악 끄기' : '배경음악 켜기');
    button.innerHTML = `BGM <span class="sound-state">${musicOn ? 'ON' : 'OFF'}</span>`;
    if (musicOn) effects.unlock(); else effects.syncMusic();
  }
  if (action === 'sound') { soundOn = !soundOn; write('nara-price-sound', soundOn); button.setAttribute('aria-pressed', String(soundOn)); button.setAttribute('aria-label', soundOn ? '효과음 끄기' : '효과음 켜기'); button.innerHTML = `효과음 <span class="sound-state">${soundOn ? 'ON' : 'OFF'}</span>`; if (soundOn) { effects.press(button); effects.click(); } else effects.stopAudio(); }
  if (action === 'fullscreen') { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { notify('이 브라우저에서는 전체 화면 전환을 지원하지 않아요.'); } }
});

// Default to one click sound for every button, including menus and modal controls.
// Keep the existing press motion on the art buttons; sound does not depend on it.
document.addEventListener('click', event => {
  const button = event.target.closest('button, summary, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]');
  if (!button || button.matches(':disabled, [aria-disabled="true"]') || button.closest('[inert]')) return;
  if (button.matches('.art-title-action, .guess-submit, .art-quick button, .art-reveal-next, [data-action=replay]')) effects.press(button);
  // Guess submission has answer/error audio; the sound toggle responds after enabling.
  if (!button.matches('.guess-submit, [data-action="sound"]')) effects.click();
}, true);

// Browsers permit music after a real user gesture; never autoplay on page load.
document.addEventListener('pointerdown', () => effects.unlock(), { once: true });
document.addEventListener('keydown', () => effects.unlock(), { once: true });

dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeDialog(); } });

try {
  const responses = await Promise.all([fetch('./data.json'), fetch('./trivia.json')]);
  if (responses.some(response => !response.ok)) throw new Error('data unavailable');
  [data, triviaPool] = await Promise.all(responses.map(response => response.json()));
  if (!Array.isArray(data.questions) || data.questions.length < ROUND_COUNT || data.questions.some(q => !q.image?.src) || !isValidTriviaPool(triviaPool)) throw new Error('invalid game data');
  // 예전 규칙(두 번 추측)으로 하던 게임 기록은 지웁니다.
  remove('nara-price-session-v2');
  state = restoreSession(read(storageKeys.session, null), triviaPool);
  if (state) persist();
  if (!state) remove(storageKeys.session);
  render({ focus: false });
} catch {
  app.innerHTML = `<main class="loading"><span class="brand-mark">₩?</span><h1>게임 정보를 불러오지 못했어요.</h1><p>인터넷 연결을 확인한 뒤 다시 열어 주세요.</p><button class="button button-blue" id="reload-button">다시 불러오기</button></main>`;
  document.querySelector('#reload-button').addEventListener('click', () => location.reload());
}
