import { MAX_GUESS, ROUND_COUNT, MAX_ATTEMPTS, TOLERANCE_PERCENT, ATTEMPT_SCORES, parseGuess, isCorrect, scoreRound, relativeError, koreanAmount, judge, totalScore, grade, guessHint, rankingSet, createSession, restoreSession } from './engine.js';
import { LEADERBOARD_CONFIG } from './leaderboard-config.js';
import { buildShareText, loadKakao, shareKakao, shareSystem } from './share.js';
import { NICKNAME_MAX, isConfigured, normalizeNickname, buildSubmission, submitScore, fetchLeaderboard } from './leaderboard.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#info-dialog');
// 규칙이 바뀌어(±10% · 3번 추측) 최고 기록은 새 키에 저장합니다. 진행 기록은 규칙 버전이 다르면 버립니다.
const storageKeys = { session: 'nara-price-session-v3', best: 'nara-price-best-v3', ranking: 'nara-price-ranking-v1' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = value => value.toLocaleString('ko-KR');
const money = value => `${number(value)}<span class="currency">원</span>`;
const vatLabel = q => q.vat === '부가가치세포함' ? '부가세 포함' : q.vat === '부가가치세별도' ? '부가세 별도' : q.vat;
const arrow = '<span aria-hidden="true">↗</span>';
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const remove = key => { try { localStorage.removeItem(key); } catch {} };

let data;
let state = null;
let screen = 'home';
let soundOn = false;
let audioContext;
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

function tone(type = 'reveal') {
  if (!soundOn) return;
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume().catch(() => {});
    (type === 'reveal' ? [440, 554, 659] : [440, 554]).forEach((frequency, i) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + i * .095;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(.055, start + .015);
      gain.gain.exponentialRampToValueAtTime(.001, start + .25);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + .26);
    });
  } catch {}
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
  if (!rows.length) return '<li class="ranking-empty">아직 등록된 기록이 없어요. 첫 번째 주인공이 되어 보세요!</li>';
  return rows.map(r => `<li class="${mine && r.nickname === mine.nickname && r.totalScore === mine.totalScore ? 'mine' : ''}"><span class="ranking-rank">${r.rank}</span><span class="ranking-name">${esc(r.nickname)}</span><span class="ranking-perfect">정답 ${r.perfectCount}개</span><strong>${number(r.totalScore)}<small>점</small></strong></li>`).join('');
}

async function loadRankingList(selector, mine = null) {
  const list = document.querySelector(selector);
  if (!list) return;
  list.innerHTML = '<li class="ranking-empty">랭킹을 불러오고 있어요…</li>';
  try {
    const rows = await fetchLeaderboard(LEADERBOARD_CONFIG, { questionSet: rankingKey(), limit: 20 });
    if (list.isConnected) list.innerHTML = rankingRows(rows, mine);
  } catch (error) {
    if (list.isConnected) list.innerHTML = `<li class="ranking-empty">${esc(error.message)}</li>`;
  }
}

function rankingPanel() {
  if (!rankingOn) return '';
  const mine = mySubmission();
  // 기기마다 최고 점수 하나만 남습니다. 게임마다 한 번 등록할 수 있고, 더 높을 때만 기록이 바뀝니다.
  const best = mine ? `<p class="ranking-status">내 최고 기록 <strong>${number(mine.totalScore)}점</strong> · 등록 당시 <strong>${number(mine.rank)}위</strong>${state.rankSubmitted ? '' : ' · 이번 점수가 더 높으면 바뀌어요'}</p>` : '';
  let top;
  if (state.rankSubmitted) top = best;
  else if (state.rankEligible) top = best + `<form id="ranking-form" class="ranking-form"><label for="ranking-nickname">닉네임</label><input id="ranking-nickname" name="nickname" maxlength="${NICKNAME_MAX}" autocomplete="nickname" placeholder="최대 ${NICKNAME_MAX}자" value="${esc(ranking.nickname)}" required><button type="submit" class="button button-blue">랭킹에 등록하기</button><p id="ranking-error" class="ranking-error" role="alert"></p></form>`;
  else top = best;
  return `<section class="ranking-panel" aria-labelledby="ranking-heading"><div class="ranking-heading"><span class="eyebrow">온라인 랭킹 · 10문제 합산</span><h2 id="ranking-heading">다른 사람들은 몇 점일까?</h2></div>${top}<ol id="ranking-list" class="ranking-list"></ol></section>`;
}

async function submitRanking() {
  if (rankingBusy || !state?.rankEligible || state.rankSubmitted || state.phase !== 'results') return;
  const input = document.querySelector('#ranking-nickname');
  const error = document.querySelector('#ranking-error');
  const nickname = normalizeNickname(input?.value);
  if (!nickname) { error.textContent = `닉네임은 1~${NICKNAME_MAX}자로 입력해 주세요.`; input?.focus(); return; }
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
    notify(kept ? `최고 기록 ${number(result.totalScore)}점(${number(result.rank)}위)이 그대로 유지돼요.` : previous ? `최고 기록 갱신! ${number(result.rank)}위예요.` : `${number(result.rank)}위로 등록했어요!`);
  } catch (e) {
    if (e.code === 'already_submitted') { state.rankSubmitted = true; persist(); render({ focus: false }); notify(e.message); return; }
    if (button?.isConnected) { button.disabled = false; button.textContent = '랭킹에 등록하기'; }
    if (error?.isConnected) error.textContent = e.message;
  } finally {
    rankingBusy = false;
  }
}

function showRanking() {
  openDialog('온라인 랭킹', `<p class="dialog-small">${esc(referenceDate())} 문제은행 · 10문제 합산 점수 순위예요. 기기마다 최고 점수 하나만 남아요.</p><ol id="dialog-ranking-list" class="ranking-list"></ol>`, true);
  loadRankingList('#dialog-ranking-list', mySubmission());
}

function render({ focus = true } = {}) {
  if (dialog.open) dialog.close();
  const content = screen === 'home' ? home() : state.phase === 'question' ? question() : state.phase === 'reveal' ? reveal() : results();
  app.innerHTML = (LEADERBOARD_CONFIG.preview ? '<div class="preview-banner">로컬 미리보기 · 랭킹은 이 PC의 테스트 기록이에요.</div>' : '') + header() + `<main id="main-content" tabindex="-1">${content}</main>` + footer();
  document.body.classList.toggle('game-active', screen !== 'home');
  document.body.classList.toggle('question-art', screen !== 'home' && state.phase === 'question');
  document.body.classList.toggle('title-art', screen === 'home');
  document.body.classList.toggle('result-art', screen !== 'home' && state.phase === 'results');
  if (screen !== 'home' && state.phase === 'question') {
    if (focus && !window.matchMedia('(max-width: 720px)').matches) document.querySelector('#guess')?.focus({ preventScroll: true });
  } else if (focus) document.querySelector('#screen-heading')?.focus({ preventScroll: true });
  if (screen !== 'home' && state.phase === 'results') loadKakao();
  if (rankingOn && screen !== 'home' && state.phase === 'results') loadRankingList('#ranking-list', mySubmission());
}

function home() {
  const hasResume = state && state.phase !== 'results';
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
      ${hasResume ? `<button type="button" class="art-title-resume" data-action="resume">${state.index + 1}번째 문제부터 이어하기</button>` : ''}
      <button type="button" data-action="rules">점수 안내</button><button type="button" data-action="about">데이터 기준</button>
      <button type="button" data-action="sound" aria-label="${soundOn ? '효과음 끄기' : '효과음 켜기'}" aria-pressed="${soundOn}">${soundOn ? '♫' : '♪'}<span class="sound-state">${soundOn ? 'ON' : 'OFF'}</span></button>
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
  return `<div class="condition-tags"><span>${esc(q.quantity)}</span><span>${esc(q.delivery)}</span><span>${esc(vatLabel(q))}</span></div><p class="specification">${esc(q.specification)}</p>${q.pricePolicy?.notice ? `<p class="basis-note price-policy-note">${esc(q.pricePolicy.notice)}</p>` : ''}`;
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
      <details class="art-menu art-popover"><summary>메뉴</summary><nav class="art-popover-content art-menu-content" aria-label="게임 도구"><button type="button" data-action="home">처음 화면</button><button type="button" data-action="rules">점수 안내</button>${rankingOn ? '<button type="button" data-action="ranking" aria-label="온라인 랭킹 보기">온라인 랭킹</button>' : ''}<button type="button" data-action="about">데이터 기준</button><button type="button" data-action="sound" aria-label="${soundOn ? '효과음 끄기' : '효과음 켜기'}" aria-pressed="${soundOn}">${soundOn ? '♫' : '♪'}<span class="sound-state">${soundOn ? 'ON' : 'OFF'}</span></button><button type="button" data-action="fullscreen" aria-label="전체 화면 전환">전체 화면</button><p>${esc(referenceDate())} 조사 기준<br>정답 ±${TOLERANCE_PERCENT}% · 최대 ${MAX_ATTEMPTS}번 추측</p></nav></details>
      ${decoration('product-frame', 'art-frame')}
      ${decoration('judge-nareumi', 'art-judge-left')}
      ${decoration('judge-dali', 'art-judge-right')}
      <div class="art-board-content">
        <h1 id="screen-heading" class="art-title" tabindex="-1"><span class="art-sr-only">${esc(q.title)}, </span>얼마일까요?</h1>
        <button type="button" class="art-product" data-action="photo" data-id="${q.id}" aria-label="${esc(q.title)} 이미지 크게 보기">${photo(q)}</button>
        <div class="art-board-footer"><div class="art-tags"><span>#${esc(q.title)}</span><span>#${esc(q.specification.split(',')[0])}</span><span>#${esc(q.supplier)}</span></div><details class="art-specs art-popover"><summary>규격 보기</summary><div class="art-popover-content art-conditions"><h2>${esc(q.title)}</h2>${conditions(q)}<p>${imageLabel(q)} · 상품 이미지를 누르면 크게 볼 수 있어요.</p><p>${esc(q.quantity)}의 등록 계약단가 · ${esc(referenceDate())} 기준</p></div></details></div>
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

function knowledge(q, compact = false) {
  const card = (state?.trivia ?? data.trivia).find(t => t.id === q.triviaId);
  if (!card) return '';
  const source = card.sources[0];
  const sourceControl = source.url.startsWith('https://apis.data.go.kr/')
    ? `<button class="fact-source-button" data-action="source" data-id="${q.id}">출처 · ${esc(source.publisher)} 검증 정보 ↗</button>`
    : `<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">출처 · ${esc(source.publisher)} ↗</a>`;
  return `<aside class="inline-knowledge ${compact ? 'compact-knowledge' : ''}" aria-label="${esc(q.title)} 틈새 지식"><div class="knowledge-mark" aria-hidden="true">✦</div><div class="knowledge-copy"><span class="eyebrow">알아두면 쓸모있는 틈새 지식</span><h${compact ? '4' : '2'}>${esc(card.title)}</h${compact ? '4' : '2'}><p class="knowledge-text">${esc(card.text)}</p><div class="knowledge-source"><span>기준 · ${esc(card.period)}</span>${sourceControl}</div></div></aside>`;
}

// 맞힌 라운드: 실제 가격과 맞힌 추측을 같은 크기로 나란히 보여 주고 오차율을 붙인다.
function priceCompare(q, round) {
  const guess = round.attempts.at(-1);
  // 두 금액 중 긴 쪽 자릿수에 맞춰 글자 크기를 정해 둘이 항상 같은 크기로 한 줄에 들어가게 한다.
  const length = Math.max(number(q.answer).length, number(guess).length) + 1;
  const error = Math.abs(relativeError(guess, q.answer));
  const label = error < .00001 ? '오차 0% · 정확히 맞혔어요' : `오차 ${error.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%로 맞혔어요`;
  const cell = (title, value, cls) => `<div class="compare-cell ${cls}"><span>${title}</span><strong>${money(value)}</strong><small>${koreanAmount(value)}</small></div>`;
  return `<div class="price-compare" style="--digits:${length}">${cell('실제 가격', q.answer, 'actual')}${cell(`내 추측 · ${round.attempts.length}번째`, guess, 'mine')}</div><p class="error-badge">✓ ${label}</p>`;
}

function reveal() {
  const q = gameQuestions()[state.index];
  const round = state.rounds[state.index];
  const verdict = judge(round.score);
  const attempts = round.attempts.map((value, i) => `<div class="guess-result"><div class="attempt-result-label">${i + 1}차 추측${isCorrect(value, q.answer) ? '<small>정답 범위 ✓</small>' : ''}</div><div class="result-guess"><span>${number(value)}원</span><small>${formatError(value, q.answer)}</small></div>${i === round.attempts.length - 1 ? `<strong class="earned-score">+${number(round.score)}<small>점</small></strong>` : ''}</div>`).join('');
  return `<section class="game-shell">${progress()}<div class="reveal-heading"><span class="reveal-label ${verdict.tone}">✦ ${verdict.tag}</span><h1 id="screen-heading" tabindex="-1">${verdict.title}</h1></div><div class="reveal-grid"><div>${productFigure(q, true)}<div class="revealed-product"><h2>${esc(q.title)}</h2>${conditions(q)}</div></div><div class="answer-panel"><span class="eyebrow">실제 등록 계약단가 · ${esc(q.quantity)}</span>${round.score > 0 ? priceCompare(q, round) : `<div class="answer-price">${money(q.answer)}</div><p class="answer-korean">${koreanAmount(q.answer)}</p>`}<div class="answer-condition"><span>${esc(q.delivery)}</span><span>${esc(vatLabel(q))}</span><span>${esc(referenceDate())} 기준</span></div><div class="guess-results">${attempts}</div><p class="scope-note">${esc(q.revealNote || q.scope)}</p><button class="source-link" data-action="source" data-id="${q.id}">계약 정보와 출처 확인하기 ↗</button></div></div>${knowledge(q)}<div class="reveal-navigation"><button class="button button-blue next-button" data-action="next">${state.index === state.questionCount - 1 ? '최종 결과 확인하기' : '다음 물건 만나러 가기'} <span aria-hidden="true">→</span></button></div></section>`;
}

function results() {
  const questions = gameQuestions();
  const total = totalScore(state.rounds);
  const verdict = grade(total, questions.length);
  const correct = state.rounds.filter(r => r.score > 0).length;
  const firstTry = state.rounds.filter(r => r.score === ATTEMPT_SCORES[0]).length;
  const mine = mySubmission();
  const rankLabel = state.rankSubmitted && mine ? `내 최고 기록 · 등록 당시 ${number(mine.rank)}위!` : '랭킹에 등록하기';
  return `<section class="art-result-screen" aria-label="최종 결과"><div class="art-result-stage">
    <img class="art-result-bird" src="./assets/designer/result-bird.png" alt="" aria-hidden="true" draggable="false">
    <img class="art-result-backpack" src="./assets/designer/result-backpack.png" alt="" aria-hidden="true" draggable="false">
    <div class="art-result-panel">
      <output class="art-result-score" style="--score-length:${number(total).length + 1}" aria-label="최종 점수 ${number(total)}점">${number(total)}점</output>
      <div class="art-result-identity"><p class="art-result-prompt">당신은...</p><h1 id="screen-heading" class="art-result-grade" tabindex="-1" style="--grade-length:${verdict.title.length}">${esc(verdict.title)}</h1></div>
      <img class="art-result-wave" src="./assets/designer/result-wave.png" alt="" aria-hidden="true" draggable="false">
      ${rankingOn ? `<button type="button" class="art-result-rank" data-action="result-ranking">${rankLabel}</button>` : `<p class="art-result-rank">최고 기록 ${number(Math.max(best, total))}점</p>`}
      <div class="art-result-actions"><button type="button" class="art-result-kakao" data-action="share-kakao">카카오톡 공유</button><div class="art-result-primary"><button type="button" class="art-result-share" data-action="share-system">공유하기</button><button type="button" class="art-result-replay" data-action="replay">다시하기</button></div></div>
    </div>
    <details class="art-menu art-popover art-result-menu"><summary>메뉴</summary><nav class="art-popover-content art-menu-content" aria-label="결과 도구">
      <button type="button" data-action="result-details">결과 자세히</button>${rankingOn ? '<button type="button" data-action="result-ranking">랭킹 등록·조회</button>' : ''}
      <button type="button" data-action="share">결과 복사</button>
      <button type="button" data-action="home">처음 화면</button><button type="button" data-action="about">데이터 기준</button>
      <button type="button" data-action="sound" aria-label="${soundOn ? '효과음 끄기' : '효과음 켜기'}" aria-pressed="${soundOn}">${soundOn ? '♫' : '♪'}<span class="sound-state">${soundOn ? 'ON' : 'OFF'}</span></button><button type="button" data-action="fullscreen" aria-label="전체 화면 전환">전체 화면</button>
    </nav></details>
  </div><template id="result-ranking-template">${rankingPanel()}</template><template id="result-details-template"><section class="art-result-summary"><h2>${esc(verdict.title)}</h2><p>${esc(verdict.subtitle)}</p><div class="final-metrics"><span>맞힌 문제 <strong>${correct}개</strong></span><span>한 번에 맞힌 문제 <strong>${firstTry}개</strong></span><span>최고 기록 <strong>${number(Math.max(best, total))}점</strong></span></div></section><div class="recap-heading"><div><span class="eyebrow">가격과 틈새 지식, 함께 돌아보기</span><h2>오늘 만난 물건들</h2></div><button class="text-button" data-action="download">결과 저장 ↓</button></div><div class="recap-list">${questions.map((q, i) => {
    const round = state.rounds[i];
    return `<article class="recap-entry"><div class="recap-row"><span class="recap-number">${String(i + 1).padStart(2, '0')}</span><button class="recap-art" data-action="photo" data-id="${q.id}" aria-label="${esc(q.title)} 이미지 크게 보기">${photo(q, '', 'lazy')}</button><div class="recap-item"><h3>${esc(q.title)}</h3><span>${esc(q.quantity)} · ${esc(q.delivery)}</span><button class="source-link" data-action="source" data-id="${q.id}">출처 ↗</button></div><div class="recap-answer"><small>등록 계약단가</small><strong>${number(q.answer)}<span>원</span></strong><div class="recap-guesses">${round.attempts.map((value, attempt) => `<span>${attempt + 1}차 ${number(value)}원</span>`).join('')}<b>+${number(round.score)}점</b></div></div></div>${knowledge(q, true)}</article>`;
  }).join('')}</div><div class="result-bottom"><p>모든 정답은 ${esc(referenceDate())} 기준 등록 계약단가입니다.<br>실제 지급총액과 다르며, 계약·할인·인도조건에 따라 달라질 수 있습니다.</p><button class="text-button" data-action="home">처음 화면으로 돌아가기 →</button></div></template></section>`;
}

function startGame() {
  // 매 게임 랭킹에 등록할 수 있습니다. 기기마다 최고 점수만 남습니다.
  state = createSession(data, rankingOn);
  screen = 'game';
  persist();
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function submitGuess() {
  if (screen !== 'game' || state.phase !== 'question') return;
  const value = parseGuess(document.querySelector('#guess').value);
  if (value === null) {
    document.querySelector('#guess-error').textContent = '1원 이상의 금액을 숫자로 입력해 주세요.';
    document.querySelector('#guess').setAttribute('aria-invalid', 'true');
    document.querySelector('#guess').focus();
    return;
  }
  const q = gameQuestions()[state.index];
  state.attempts.push(value);
  state.draft = '';
  // 틀렸고 기회가 남았으면 힌트를 보여주고 다시 추측합니다.
  if (!isCorrect(value, q.answer) && state.attempts.length < MAX_ATTEMPTS) {
    persist();
    render();
    tone('hint');
    document.querySelector('.retry-feedback')?.scrollIntoView({ block: 'center', behavior: 'instant' });
    return;
  }
  state.rounds.push({ candidateId: q.id, attempts: [...state.attempts], score: scoreRound(state.attempts, q.answer) });
  state.attempts = [];
  state.phase = 'reveal';
  persist();
  render();
  tone('reveal');
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function nextQuestion() {
  if (state.phase !== 'reveal') return;
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
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function openDialog(title, body, wide = false) {
  dialog.classList.toggle('wide-dialog', wide);
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="닫기">×</button></div><div class="dialog-content">${body}</div>`;
  dialog.showModal();
}

function showPhoto(id) {
  const q = findQuestion(id);
  if (!q) return;
  openDialog(esc(q.title), `<div class="photo-viewer">${photo(q)}</div><p class="photo-caption">${imageLabel(q)} · 물품식별번호 ${esc(q.productId)}</p><p class="dialog-small">${esc(q.specification)}</p><a class="external-link" href="${esc(q.image.sourceUrl)}" target="_blank" rel="noopener noreferrer">나라장터 원본 이미지 보기 ↗</a>`, true);
}

function showAbout() {
  openDialog('가격표의 기준을 알려드려요', `<span class="dialog-badge">${esc(referenceDate())} 조사 스냅샷</span><p>이 게임은 <strong>나라장터쇼핑몰에 실제 등록된 물품</strong>의 계약단가를 맞히는 퀴즈입니다.</p><dl class="info-definitions"><div><dt>어떤 가격인가요?</dt><dd>해당 모델의 계약단위 한 단위에 대한 등록 계약단가입니다. 실제 구매·지급총액을 뜻하지 않습니다. 문제의 규격·수량·인도조건·부가세를 함께 확인해 주세요.</dd></div><div><dt>지금 가격과 같나요?</dt><dd>${esc(referenceDate())}에 확인한 가격입니다. 이후 계약·할인·등록 상태가 달라질 수 있습니다. 물건별 등록 계약단가를 기준으로 출제하며, 할인 정보는 정답 계산에 반영하지 않습니다.</dd></div><div><dt>상품 이미지에 관하여</dt><dd>각 물품식별번호에 연결된 나라장터 공식 상품 이미지를 사용합니다. 원본을 수정하지 않았으며, 그네와 조합놀이대는 공급업체가 등록한 제품 이미지입니다. 이미지 크게 보기에서 출처를 확인할 수 있습니다.</dd></div><div><dt>힌트와 틈새 지식</dt><dd>추측이 정답의 ±${TOLERANCE_PERCENT}% 밖이면 UP/DOWN과 대략적인 차이를 알려드리고, 물건마다 최대 ${MAX_ATTEMPTS}번 추측할 수 있습니다. 틈새 지식은 정답·점수 화면과 최종 결과표에 바로 표시합니다.</dd></div></dl><p class="dialog-small">본 게임은 조달청 공식 서비스가 아닌 공모전 준비용 프로토타입입니다. 기록은 이 브라우저에 저장됩니다.</p><a class="external-link" href="${esc(data.catalogUrl)}" target="_blank" rel="noopener noreferrer">공식 API 안내 확인하기 ↗</a>`);
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
  const payload = { game: data.title, price_reference_date: referenceDate(), question_set: state.questionSet, played_at: new Date().toISOString(), question_count: state.questionCount, total_score: totalScore(state.rounds), rounds: gameQuestions().map((q, i) => ({ round: i + 1, title: q.title, product_id: q.productId, registered_contract_unit_price_krw: q.answer, quantity: q.quantity, delivery: q.delivery, attempts_krw: state.rounds[i].attempts, score: state.rounds[i].score, trivia: state.trivia.find(t => t.id === q.triviaId) ?? null })) };
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
  if (event.target.id !== 'guess') return;
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
  event.target.alt = '상품 이미지를 불러오지 못했어요. 이미지 크게 보기에서 원본 링크를 확인해 주세요.';
}, true);

// 예상 가격 버튼: 윗줄은 더하기, 아랫줄은 빼기
const QUICK_STEPS = [[10000, '1만'], [100000, '10만'], [1000000, '100만'], [10000000, '1,000만'], [100000000, '1억']];
const quickAmountButtons = () => [1, -1].map(sign => QUICK_STEPS.map(([amount, label]) => `<button type="button" data-action="add" data-amount="${sign * amount}" class="${sign > 0 ? 'plus' : 'minus'}" aria-label="${label}원 ${sign > 0 ? '더하기' : '빼기'}">${sign > 0 ? '+' : '−'} ${label}</button>`).join('')).join('');

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'home') { screen = 'home'; render(); window.scrollTo({ top: 0, behavior: 'instant' }); }
  if (action === 'resume' && state) { screen = 'game'; render(); }
  if (action === 'exit') { if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); openDialog('게임 종료', `<p>게임을 마치려면 현재 브라우저 탭이나 창을 닫아 주세요.</p>${state && state.phase !== 'results' ? '<p>진행 기록은 이 브라우저에 저장되어 있어요. 다음에 열면 이어하기로 계속할 수 있어요.</p>' : ''}`); }
  if (action === 'add') {
    const input = document.querySelector('#guess'); if (!input) return;
    const next = Math.min(MAX_GUESS, (parseGuess(input.value) ?? 0) + Number(button.dataset.amount));
    input.value = next > 0 ? number(next) : '';
    input.dispatchEvent(new Event('input', { bubbles: true })); input.focus({ preventScroll: true });
  }
  if (action === 'clear') { const input = document.querySelector('#guess'); if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus({ preventScroll: true }); } }
  if (action === 'next' && state?.phase === 'reveal') nextQuestion();
  if (action === 'replay') startGame();
  if (action === 'about') showAbout();
  if (action === 'rules') showRules();
  if (action === 'ranking') showRanking();
  if (action === 'result-ranking') { openDialog('온라인 랭킹', document.querySelector('#result-ranking-template').innerHTML, true); loadRankingList('#ranking-list', mySubmission()); }
  if (action === 'result-details') openDialog('오늘 만난 물건들', document.querySelector('#result-details-template').innerHTML, true);
  if (action === 'source') showSource(button.dataset.id);
  if (action === 'photo') showPhoto(button.dataset.id);
  if (action === 'close-dialog') dialog.close();
  // 공유는 사용자 제스처 안에서 불려야 하므로 await 없이 바로 부른다.
  if (action === 'share-kakao') shareKakao(shareResult(), notify);
  if (action === 'share-system') shareSystem(shareResult(), notify, copyResults);
  if (action === 'share') await copyResults();
  if (action === 'download') downloadResults();
  if (action === 'sound') { soundOn = !soundOn; button.setAttribute('aria-pressed', String(soundOn)); button.setAttribute('aria-label', soundOn ? '효과음 끄기' : '효과음 켜기'); button.innerHTML = `${soundOn ? '♫' : '♪'}<span class="sound-state">${soundOn ? 'ON' : 'OFF'}</span>`; if (soundOn) tone('hint'); }
  if (action === 'fullscreen') { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { notify('이 브라우저에서는 전체 화면 전환을 지원하지 않아요.'); } }
});

dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });

try {
  const response = await fetch('./data.json');
  if (!response.ok) throw new Error('data unavailable');
  data = await response.json();
  if (!Array.isArray(data.questions) || data.questions.length < ROUND_COUNT || !Array.isArray(data.trivia) || data.questions.some(q => !q.image?.src)) throw new Error('invalid game data');
  // 예전 규칙(두 번 추측)으로 하던 게임 기록은 지웁니다.
  remove('nara-price-session-v2');
  state = restoreSession(read(storageKeys.session, null));
  if (!state) remove(storageKeys.session);
  render({ focus: false });
} catch {
  app.innerHTML = `<main class="loading"><span class="brand-mark">₩?</span><h1>가격표를 불러오지 못했어요.</h1><p>인터넷 연결을 확인한 뒤 다시 열어 주세요.</p><button class="button button-blue" id="reload-button">다시 불러오기</button></main>`;
  document.querySelector('#reload-button').addEventListener('click', () => location.reload());
}
