import { MAX_GUESS, parseGuess, scoreGuess, relativeError, koreanAmount, judge, totalScore, grade, guessHint, isValidSession } from './engine.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#info-dialog');
const storageKeys = { session: 'nara-price-session-v2', best: 'nara-price-best-v1', settings: 'nara-price-settings-v2' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = value => value.toLocaleString('ko-KR');
const money = value => `${number(value)}<span class="currency">원</span>`;
const arrow = '<span aria-hidden="true">↗</span>';
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const remove = key => { try { localStorage.removeItem(key); } catch {} };
const revealNotes = {
  C01: '3인용 벤치 한 개의 현장설치도 계약단가예요. 같은 모델도 납품 조건에 따라 등록 가격이 달라질 수 있어요.',
  C22: 'WS-MIL-SG-001 전투용 보안경 한 개의 계약단가예요. 이름만으로 예상했던 가격과 얼마나 가까웠나요?',
  C26: '규격 140×280×220mm인 CRC-789 감성교감로봇 한 대의 계약단가예요.',
  C04: '규격 5200×8000×3000mm, 2인용 그네 한 대의 현장설치도 계약단가예요. 전체 크기도 중요한 단서였어요.',
  C13: 'SCA123SC 화생방용 두건형 방독면 한 개의 계약단가예요.',
  C27: 'ARVO 경비·감시용 로봇 한 대의 현장설치도 계약단가예요. 앞서 만난 감성교감로봇과 비교해 보세요.',
  C29: '1000kg짜리 한 포대의 계약단가예요. 한 포대라는 말도 규격까지 읽으면 무게감이 달라지죠.',
  C03: '길이 11.89m, 10종 조합놀이대 한 조의 현장설치도 계약단가예요.',
  C06: '길이 11.4m인 TE-002 이동식화장실 한 조의 현장설치도 계약단가예요.',
  C28: '용량 6㎥인 RTRS075FC 노면청소차 한 대의 계약단가예요. 인도조건은 생산공장 상차도입니다.',
};

let data;
let state = null;
let screen = 'home';
let interval = null;
let soundOn = false;
let audioContext;
let toastTimeout;
let best = read(storageKeys.best, 0);
if (!Number.isInteger(best) || best < 0 || best > 10000) best = 0;
let preferences = read(storageKeys.settings, { timeLimit: 0 });
if (!preferences || ![0, 45].includes(preferences.timeLimit)) preferences = { timeLimit: 0 };

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
  return `<header class="site-header"><button class="brand" data-action="home" aria-label="이게 얼마게? 처음 화면"><span class="brand-mark" aria-hidden="true">₩?</span><span>이게 얼마게<span class="brand-question">?</span></span></button><span class="header-description">나라장터 가격 퀴즈</span><nav class="header-tools" aria-label="게임 도구"><button class="text-button about-button" data-action="about">데이터 기준 ↗</button><button class="icon-button" data-action="sound" aria-label="${soundOn ? '효과음 끄기' : '효과음 켜기'}" aria-pressed="${soundOn}">${soundOn ? '♫' : '♪'}<span class="sound-state">${soundOn ? 'ON' : 'OFF'}</span></button><button class="icon-button fullscreen-button" data-action="fullscreen" aria-label="전체 화면 전환">⛶</button></nav></header>`;
}

function footer() {
  return `<footer class="site-footer"><span>익숙한 물건에서 발견하는, 뜻밖의 가격.</span><span>조달청 API · ${esc(data.referenceDate)} 기준 <button data-action="about" class="footer-link">데이터 안내</button></span></footer>`;
}

function imageLabel(q) {
  return q.image.kind === 'catalog-render' ? '나라장터 등록 제품 이미지' : '나라장터 등록 상품 사진';
}

function photo(q, className = '', loading = 'eager') {
  return `<img class="product-photo ${className}" src="${esc(q.image.src)}" alt="${esc(q.image.alt)}" decoding="async" loading="${loading}">`;
}

function render({ focus = true } = {}) {
  stopTimer();
  if (dialog.open) dialog.close();
  const content = screen === 'home' ? home() : state.phase === 'question' ? question() : state.phase === 'reveal' ? reveal() : results();
  app.innerHTML = header() + `<main id="main-content" tabindex="-1">${content}</main>` + footer();
  document.body.classList.toggle('game-active', screen !== 'home');
  if (screen !== 'home' && state.phase === 'question') {
    startTimer();
    if (focus && !window.matchMedia('(max-width: 720px)').matches) document.querySelector('#guess')?.focus({ preventScroll: true });
  } else if (focus) document.querySelector('#screen-heading')?.focus({ preventScroll: true });
}

function home() {
  const hasResume = state && state.phase !== 'results';
  const first = data.questions[0];
  return `<section class="home-hero"><div class="hero-copy"><div class="eyebrow"><span class="live-dot" aria-hidden="true"></span>실제 등록 가격으로 플레이하는 퀴즈</div><h1 id="screen-heading" tabindex="-1">맨날 보던 물건,<br>이게 <span class="highlight">얼마게?</span></h1><p class="hero-description">공원 벤치부터 도로의 청소차까지.<br>진짜 물건을 보고 가격을 추측해 보세요.<br>한 번 틀려도, 힌트와 한 번의 기회가 더!</p><div class="hero-facts"><span><strong>10</strong> 라운드</span><span><strong>2</strong> 번의 기회</span><span><strong>10,000</strong> 최고 점수</span></div><form id="setup-form" class="setup-card"><div class="solo-mode-note"><span>UP ↗ / DOWN ↘</span> 첫 추측이 틀리면 방향과 거리 힌트를 알려드려요.</div><div class="time-setting"><span>추측 시간</span><div class="time-options" role="group" aria-label="추측 제한 시간"><button type="button" data-action="time" data-time="0" class="${preferences.timeLimit === 0 ? 'selected' : ''}" aria-pressed="${preferences.timeLimit === 0}">여유롭게</button><button type="button" data-action="time" data-time="45" class="${preferences.timeLimit === 45 ? 'selected' : ''}" aria-pressed="${preferences.timeLimit === 45}">시도마다 45초</button></div></div><button type="submit" class="button button-blue start-button">${hasResume ? '새 게임 시작하기' : '가격 맞히러 가기'} ${arrow}</button>${hasResume ? `<button type="button" class="resume-button" data-action="resume">${state.index + 1}번째 문제부터 이어하기 <span>→</span></button>` : ''}<p class="setup-note">정답에 가까울수록 높은 점수. 마지막 추측으로 계산해요.</p></form><button class="rules-link" data-action="rules">점수는 어떻게 매기나요? ↗</button></div><div class="hero-visual hero-real-photo"><div class="visual-grid"></div><span class="artifact-stamp">물건은 익숙하게<br><strong>가격은 새롭게.</strong></span><span class="doodle-spark" aria-hidden="true">✳</span><button class="hero-photo" data-action="photo" data-id="${first.id}" aria-label="공원 벤치 사진 크게 보기">${photo(first)}</button><div class="floating-label"><span class="label-dot"></span><div><small>첫 번째 물건</small><strong>3인용 공원 벤치</strong></div><span class="label-arrow">↗</span></div><div class="mystery-price"><span>이 벤치 하나에</span><strong>₩ <span>???</span></strong></div><span class="hero-image-credit">사진 · 나라장터 등록 상품</span><div class="corner-note"><span>PRICE DISCOVERY CLUB</span><span>01—10</span></div></div></section><section class="how-it-works" aria-label="게임 방법"><div class="section-label">아는 만큼 보이고,<br>맞힐수록 놀라워요.</div><div><span class="step-number">01</span><strong>진짜 물건을 살펴보고</strong><p>등록 상품 이미지와<br>크기, 단위, 인도조건을 살펴봐요.</p></div><div><span class="step-number">02</span><strong>힌트를 보고 한 번 더</strong><p>틀리면 UP/DOWN과<br>대략적인 차이를 알려드려요.</p></div><div><span class="step-number">03</span><strong>가격과 잡학을 한눈에</strong><p>정답·점수·틈새 지식을<br>결과 화면에서 함께 확인해요.</p></div></section>${best > 0 ? `<div class="local-best"><span>이 기기 최고 기록</span><strong>${number(best)} <small>/ 10,000점</small></strong></div>` : ''}`;
}

function progress() {
  return `<div class="round-progress"><div class="round-counter"><span>ROUND</span><strong>${String(state.index + 1).padStart(2, '0')}</strong><span>/ ${data.questions.length}</span></div><div class="progress-dots" aria-label="${state.index + 1} / ${data.questions.length} 라운드">${data.questions.map((_, i) => `<span class="${i < state.index ? 'done' : i === state.index ? 'current' : ''}"></span>`).join('')}</div><div class="game-score"><span>누적 점수</span><strong>${number(totalScore(state.rounds))}<small>점</small></strong></div></div>`;
}

function productFigure(q, small = false) {
  return `<figure class="product-figure real-photo-figure ${small ? 'figure-small' : ''}"><span class="figure-index">ITEM ${String(q.order).padStart(2, '0')}</span><button class="photo-enlarge" data-action="photo" data-id="${q.id}" aria-label="${esc(q.title)} 이미지 크게 보기">${photo(q)}</button><figcaption class="figure-bottom"><span>${esc(q.quantity)} 기준</span><small>${imageLabel(q)}<br><span>눌러서 크게 보기 ↗</span></small></figcaption></figure>`;
}

function conditions(q) {
  return `<div class="condition-tags"><span>${esc(q.quantity)}</span><span>${esc(q.delivery)}</span><span>부가세 포함</span></div><p class="specification">${esc(q.specification)}</p>`;
}

function retryFeedback(q) {
  if (!state.attempts.length) return '';
  const first = state.attempts[0];
  const hint = guessHint(first, q.answer);
  if (!hint) return `<div class="retry-feedback timeout-feedback" role="status"><div class="retry-direction">한 번 더!</div><div><strong>첫 추측의 시간이 끝났어요.</strong><p>마지막 기회가 남았어요. 다시 추측해 보세요.</p></div></div>`;
  return `<div class="retry-feedback ${hint.direction.toLowerCase()}" role="status"><div class="retry-direction">${hint.direction}<span aria-hidden="true">${hint.direction === 'UP' ? '↗' : '↘'}</span></div><div><strong>${hint.label}</strong><p>${hint.instruction}</p><small>첫 추측 ${number(first)}원 · 한 번의 기회가 더 남았어요</small></div></div>`;
}

function question() {
  const q = data.questions[state.index];
  const retry = state.attempts.length === 1;
  return `<section class="game-shell">${progress()}<div class="question-grid">${productFigure(q)}<div class="question-panel"><div class="eyebrow">${esc(q.category)}</div><h1 id="screen-heading" tabindex="-1">${esc(q.title)}<br><span>얼마일까요?</span></h1>${conditions(q)}<div class="guess-zone">${retryFeedback(q)}<form id="guess-form" novalidate><div class="guess-label"><label for="guess">${retry ? '마지막 예상 등록 계약단가' : '예상 등록 계약단가'}</label><div class="attempt-tools"><span class="attempt-count ${retry ? 'last' : ''}">${retry ? '마지막 기회 · 2 / 2' : '첫 번째 추측 · 1 / 2'}</span><span id="countdown" class="countdown" ${!state.timeLimit ? 'hidden' : ''} aria-label="남은 시간">00:45</span></div></div><div class="amount-input"><span class="won-symbol" aria-hidden="true">₩</span><input id="guess" name="guess" type="text" inputmode="numeric" autocomplete="off" maxlength="15" value="${esc(state.draft || '')}" placeholder="${retry ? '힌트 보고 다시 입력' : '얼마일까요?'}" aria-describedby="amount-hint guess-error"><span>원</span></div><p id="amount-hint" class="amount-hint">${koreanAmount(parseGuess(state.draft || ''))}</p><div class="quick-amounts" aria-label="예상 가격 더하기"><button type="button" data-action="add" data-amount="10000">+ 1만</button><button type="button" data-action="add" data-amount="100000">+ 10만</button><button type="button" data-action="add" data-amount="1000000">+ 100만</button><button type="button" data-action="add" data-amount="10000000">+ 1,000만</button><button type="button" data-action="clear" class="clear-amount" aria-label="예상 가격 지우기">↺</button></div><p class="form-error" id="guess-error" role="alert"></p><button class="button button-blue guess-submit" type="submit">${retry ? '마지막 추측! 정답 확인하기' : '첫 번째 추측 제출하기'} <span aria-hidden="true">→</span></button></form><p class="basis-note">${esc(q.quantity)}의 계약단가 · ${esc(data.referenceDate)} 기준 · ${retry ? '이번 추측으로 점수를 계산해요.' : '틀리면 정답을 숨긴 채 힌트를 드려요.'}</p></div></div></div><div class="game-bottom"><button class="text-button" data-action="home">← 처음 화면</button><span>물건의 규격과 인도조건까지 살펴보세요.</span><button class="text-button" data-action="rules">점수 안내 ↗</button></div></section>`;
}

function formatError(guess, answer) {
  if (guess === null) return '입력 시간 종료';
  const error = relativeError(guess, answer);
  if (Math.abs(error) < .00001) return '정확히 일치';
  const percent = Math.abs(error).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
  return `정답보다 ${percent}% ${error > 0 ? '높게' : '낮게'}`;
}

function knowledge(q, compact = false) {
  const card = data.trivia.find(t => t.id === q.triviaId);
  if (!card) return '';
  const source = card.sources[0];
  const sourceControl = source.url.startsWith('https://apis.data.go.kr/')
    ? `<button class="fact-source-button" data-action="source" data-id="${q.id}">출처 · ${esc(source.publisher)} 검증 정보 ↗</button>`
    : `<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">출처 · ${esc(source.publisher)} ↗</a>`;
  return `<aside class="inline-knowledge ${compact ? 'compact-knowledge' : ''}" aria-label="${esc(q.title)} 틈새 지식"><div class="knowledge-mark" aria-hidden="true">✦</div><div class="knowledge-copy"><span class="eyebrow">알아두면 쓸모있는 틈새 지식</span><h${compact ? '4' : '2'}>${esc(card.title)}</h${compact ? '4' : '2'}><p class="knowledge-text">${esc(card.text)}</p><div class="knowledge-source"><span>기준 · ${esc(card.period)}</span>${sourceControl}</div></div></aside>`;
}

function reveal() {
  const q = data.questions[state.index];
  const round = state.rounds[state.index];
  const verdict = judge(round.score);
  const attempts = round.attempts.map((value, i) => `<div class="guess-result"><div class="attempt-result-label">${i + 1}차 추측${i === round.attempts.length - 1 ? '<small>점수 반영</small>' : ''}</div><div class="result-guess"><span>${value === null ? '시간 초과' : `${number(value)}원`}</span><small>${formatError(value, q.answer)}</small></div>${i === round.attempts.length - 1 ? `<strong class="earned-score">+${number(round.score)}<small>점</small></strong>` : ''}</div>`).join('');
  return `<section class="game-shell">${progress()}<div class="reveal-heading"><span class="reveal-label ${verdict.tone}">✦ ${verdict.tag}</span><h1 id="screen-heading" tabindex="-1">${verdict.title}</h1></div><div class="reveal-grid"><div>${productFigure(q, true)}<div class="revealed-product"><h2>${esc(q.title)}</h2>${conditions(q)}</div></div><div class="answer-panel"><span class="eyebrow">실제 등록 계약단가 · ${esc(q.quantity)}</span><div class="answer-price">${money(q.answer)}</div><p class="answer-korean">${koreanAmount(q.answer)}</p><div class="answer-condition"><span>${esc(q.delivery)}</span><span>부가세 포함</span><span>${esc(data.referenceDate)} 기준</span></div><div class="guess-results">${attempts}</div><p class="scope-note">${esc(revealNotes[q.id])}</p><button class="source-link" data-action="source" data-id="${q.id}">계약 정보와 출처 확인하기 ↗</button></div></div>${knowledge(q)}<div class="reveal-navigation"><button class="button button-blue next-button" data-action="next">${state.index === data.questions.length - 1 ? '최종 결과 확인하기' : '다음 물건 만나러 가기'} <span aria-hidden="true">→</span></button></div></section>`;
}

function results() {
  const total = totalScore(state.rounds);
  const verdict = grade(total);
  const perfect = state.rounds.filter(r => r.attempts.at(-1) === data.questions.find(q => q.id === r.candidateId).answer).length;
  return `<section class="results-shell"><div class="results-banner"><div class="result-sticker" aria-hidden="true">${verdict.symbol}</div><span class="eyebrow">10개의 가격, 10개의 새로운 발견</span><h1 id="screen-heading" tabindex="-1">${verdict.title}</h1><p>${verdict.subtitle}</p><div class="final-score">${number(total)}<span> / 10,000점</span></div><div class="final-metrics"><span>정확히 맞힌 문제 <strong>${perfect}개</strong></span><span>최고 기록 <strong>${number(Math.max(best, total))}점</strong></span></div><div class="result-actions"><button class="button button-blue" data-action="replay">다시 도전하기 ↗</button><button class="button button-white" data-action="share">결과 복사하기</button></div></div><div class="recap-heading"><div><span class="eyebrow">가격과 틈새 지식, 함께 돌아보기</span><h2>오늘 만난 물건들</h2></div><button class="text-button" data-action="download">결과 저장 ↓</button></div><div class="recap-list">${data.questions.map((q, i) => {
    const round = state.rounds[i];
    return `<article class="recap-entry"><div class="recap-row"><span class="recap-number">${String(i + 1).padStart(2, '0')}</span><button class="recap-art" data-action="photo" data-id="${q.id}" aria-label="${esc(q.title)} 이미지 크게 보기">${photo(q, '', 'lazy')}</button><div class="recap-item"><h3>${esc(q.title)}</h3><span>${esc(q.quantity)} · ${esc(q.delivery)}</span><button class="source-link" data-action="source" data-id="${q.id}">출처 ↗</button></div><div class="recap-answer"><small>등록 계약단가</small><strong>${number(q.answer)}<span>원</span></strong><div class="recap-guesses">${round.attempts.map((value, attempt) => `<span>${attempt + 1}차 ${value === null ? '시간 초과' : `${number(value)}원`}</span>`).join('')}<b>+${number(round.score)}점</b></div></div></div>${knowledge(q, true)}</article>`;
  }).join('')}</div><div class="result-bottom"><p>모든 정답은 ${esc(data.referenceDate)} 기준 등록 계약단가입니다.<br>실제 지급총액과 다르며, 계약·할인·인도조건에 따라 달라질 수 있습니다.</p><button class="text-button" data-action="home">처음 화면으로 돌아가기 →</button></div></section>`;
}

function startGame() {
  state = { version: 2, phase: 'question', index: 0, attempts: [], rounds: [], draft: '', deadline: null, timeLimit: preferences.timeLimit };
  screen = 'game';
  persist();
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function submitGuess(timedOut = false) {
  if (screen !== 'game' || state.phase !== 'question') return;
  const value = timedOut ? null : parseGuess(document.querySelector('#guess').value);
  if (!timedOut && value === null) {
    document.querySelector('#guess-error').textContent = '1원 이상의 금액을 숫자로 입력해 주세요.';
    document.querySelector('#guess').setAttribute('aria-invalid', 'true');
    document.querySelector('#guess').focus();
    return;
  }
  stopTimer();
  const q = data.questions[state.index];
  state.attempts.push(value);
  state.deadline = null;
  state.draft = '';
  if (state.attempts.length === 1 && value !== q.answer) {
    persist();
    render();
    tone('hint');
    document.querySelector('.retry-feedback')?.scrollIntoView({ block: 'center', behavior: 'instant' });
    return;
  }
  state.rounds.push({ candidateId: q.id, attempts: [...state.attempts], score: scoreGuess(value, q.answer) });
  state.attempts = [];
  state.phase = 'reveal';
  persist();
  render();
  tone('reveal');
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function nextQuestion() {
  if (state.phase !== 'reveal') return;
  if (state.index === data.questions.length - 1) {
    state.phase = 'results';
    best = Math.max(best, totalScore(state.rounds));
    write(storageKeys.best, best);
  } else {
    state.index++;
    state.phase = 'question';
    state.deadline = null;
    state.draft = '';
  }
  persist();
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function stopTimer() { if (interval) clearInterval(interval); interval = null; }
function startTimer() {
  if (!state.timeLimit) return;
  state.deadline ??= Date.now() + state.timeLimit * 1000;
  persist();
  const tick = () => {
    if (screen !== 'game' || state.phase !== 'question') return;
    const seconds = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    const counter = document.querySelector('#countdown');
    if (counter) { counter.textContent = `00:${String(seconds).padStart(2, '0')}`; counter.classList.toggle('urgent', seconds <= 10); }
    if (seconds === 0) submitGuess(true);
  };
  interval = setInterval(tick, 250);
  setTimeout(tick, 0);
}

function openDialog(title, body, wide = false) {
  dialog.classList.toggle('wide-dialog', wide);
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="닫기">×</button></div><div class="dialog-content">${body}</div>`;
  dialog.showModal();
}

function showPhoto(id) {
  const q = data.questions.find(q => q.id === id);
  if (!q) return;
  openDialog(esc(q.title), `<div class="photo-viewer">${photo(q)}</div><p class="photo-caption">${imageLabel(q)} · 물품식별번호 ${esc(q.productId)}</p><p class="dialog-small">${esc(q.specification)}</p><a class="external-link" href="${esc(q.image.sourceUrl)}" target="_blank" rel="noopener noreferrer">나라장터 원본 이미지 보기 ↗</a>`, true);
}

function showAbout() {
  openDialog('가격표의 기준을 알려드려요', `<span class="dialog-badge">${esc(data.referenceDate)} 조사 스냅샷</span><p>이 게임은 <strong>나라장터쇼핑몰에 실제 등록된 물품</strong>의 계약단가를 맞히는 퀴즈입니다.</p><dl class="info-definitions"><div><dt>어떤 가격인가요?</dt><dd>해당 모델의 계약단위 한 단위에 대한 등록 계약단가입니다. 실제 구매·지급총액을 뜻하지 않습니다. 문제의 규격·수량·인도조건·부가세를 함께 확인해 주세요.</dd></div><div><dt>지금 가격과 같나요?</dt><dd>${esc(data.referenceDate)}에 확인한 가격입니다. 이후 계약·할인·등록 상태가 달라질 수 있습니다. 당시 활성 할인 정보가 있던 후보는 제외했습니다.</dd></div><div><dt>상품 이미지에 관하여</dt><dd>각 물품식별번호에 연결된 나라장터 공식 상품 이미지를 사용합니다. 원본을 수정하지 않았으며, 그네와 조합놀이대는 공급업체가 등록한 제품 이미지입니다. 이미지 크게 보기에서 출처를 확인할 수 있습니다.</dd></div><div><dt>힌트와 틈새 지식</dt><dd>첫 추측이 틀리면 UP/DOWN과 대략적인 차이를 알려드리고, 한 번 더 추측할 수 있습니다. 틈새 지식은 정답·점수 화면과 최종 결과표에 바로 표시합니다.</dd></div></dl><p class="dialog-small">본 게임은 조달청 공식 서비스가 아닌 공모전 준비용 프로토타입입니다. 기록은 이 브라우저에 저장됩니다.</p><a class="external-link" href="${esc(data.catalogUrl)}" target="_blank" rel="noopener noreferrer">공식 API 안내 확인하기 ↗</a>`);
}

function showRules() {
  openDialog('힌트를 보고 한 번 더 도전해요', `<p>물건마다 <strong>최대 두 번</strong> 추측할 수 있습니다. 첫 추측이 정답이면 바로 결과를 보여드리고, 틀리면 정답을 숨긴 채 힌트를 드려요.</p><div class="score-examples"><div><span>UP ↗</span><strong>예상보다 더 비싸요</strong></div><div><span>DOWN ↘</span><strong>예상보다 더 저렴해요</strong></div><div><span>차이의 정도</span><strong>아주 조금 · 조금 · 꽤 · 많이 · 아주 많이</strong></div></div><p class="rules-paragraph"><strong>점수는 마지막 추측으로 계산</strong>하며, 정답이면 1,000점입니다. 한 번에 맞혀도, 두 번째에 맞혀도 1,000점이에요. 두 번째도 틀리면 정답과 가까운 정도에 따라 점수를 받습니다.</p><p class="rules-paragraph">45초 모드에서는 <strong>각 시도마다 45초</strong>입니다. 첫 시간초과에는 방향 힌트 없이 한 번 더 기회를 드리고, 두 번째 시간초과에는 0점으로 마칩니다.</p><details class="formula"><summary>점수 계산식 보기</summary><code>반올림(1000 × exp(−1.5 × |ln(마지막 예상가 ÷ 정답)|))</code></details>`);
}

function showSource(id) {
  const q = data.questions.find(q => q.id === id);
  if (!q) return;
  openDialog('이 물건의 계약 정보', `<span class="dialog-badge">공식 API 확인 · ${esc(data.referenceDate)}</span><h3 class="source-title">${esc(q.title)}</h3><div class="source-price">${money(q.answer)} <small>/ ${esc(q.unit)}</small></div><dl class="source-table"><div><dt>규격 원문</dt><dd>${esc(q.specification)}</dd></div><div><dt>물품식별번호</dt><dd>${esc(q.productId)}</dd></div><div><dt>계약번호 / 순번</dt><dd>${esc(q.contractNumber)} / ${esc(q.contractLine)}</dd></div><div><dt>공급업체</dt><dd>${esc(q.supplier)}</dd></div><div><dt>계약기간</dt><dd>${esc(q.contractStart)} ~ ${esc(q.contractEnd)}</dd></div><div><dt>인도조건 / 부가세</dt><dd>${esc(q.delivery)} / ${esc(q.vat)}</dd></div><div><dt>조회 시각</dt><dd>${esc(q.checkedAt)}</dd></div><div><dt>API</dt><dd class="api-operation">${esc(q.endpoint)}</dd></div></dl><p class="dialog-small">${esc(q.scope)}<br>이 금액은 품목 계약단가이며 실제 지급총액은 확인하지 않았습니다.</p><a class="external-link" href="${esc(q.image.sourceUrl)}" target="_blank" rel="noopener noreferrer">${imageLabel(q)} 원본 ↗</a><a class="external-link" href="${esc(data.catalogUrl)}" target="_blank" rel="noopener noreferrer">공공데이터포털에서 API 설명 보기 ↗</a><a class="download-link" href="./data.json" download="나라장터_가격퀴즈_검증데이터.json">출제 데이터 JSON 내려받기 ↓</a>`, true);
}

async function copyResults() {
  const total = totalScore(state.rounds);
  const text = `이게 얼마게? · 나라장터 가격 퀴즈\n${number(total)} / 10,000점\n${grade(total).title}\n힌트와 함께 10개 물건의 가격에 도전!\n가격 기준일 ${data.referenceDate}`;
  try { await navigator.clipboard.writeText(text); notify('결과를 복사했어요!'); }
  catch { openDialog('결과 복사', `<p>아래 내용을 선택해 복사해 주세요.</p><textarea class="share-fallback" aria-label="복사할 결과" readonly>${esc(text)}</textarea>`); dialog.querySelector('textarea')?.select(); }
}

function downloadResults() {
  const payload = { game: data.title, price_reference_date: data.referenceDate, played_at: new Date().toISOString(), total_score: totalScore(state.rounds), rounds: data.questions.map((q, i) => ({ round: i + 1, title: q.title, product_id: q.productId, registered_contract_unit_price_krw: q.answer, quantity: q.quantity, delivery: q.delivery, attempts_krw: state.rounds[i].attempts, score: state.rounds[i].score, trivia: data.trivia.find(t => t.id === q.triviaId) ?? null })) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = '이게얼마게_플레이결과.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('submit', event => {
  if (event.target.id === 'setup-form') { event.preventDefault(); startGame(); }
  if (event.target.id === 'guess-form') { event.preventDefault(); submitGuess(); }
});

document.addEventListener('input', event => {
  if (event.target.id !== 'guess') return;
  const input = event.target;
  const digits = input.value.replace(/\D/g, '').slice(0, 12);
  input.value = digits ? number(Number(digits)) : '';
  document.querySelector('#amount-hint').textContent = koreanAmount(parseGuess(input.value));
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

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'home') { if (screen !== 'home') { state.deadline = null; persist(); } screen = 'home'; render(); window.scrollTo({ top: 0, behavior: 'instant' }); }
  if (action === 'time') { preferences.timeLimit = Number(button.dataset.time); write(storageKeys.settings, preferences); render({ focus: false }); }
  if (action === 'resume' && state) { screen = 'game'; render(); }
  if (action === 'add') {
    const input = document.querySelector('#guess'); if (!input) return;
    input.value = number(Math.min(MAX_GUESS, (parseGuess(input.value) ?? 0) + Number(button.dataset.amount)));
    input.dispatchEvent(new Event('input', { bubbles: true })); input.focus({ preventScroll: true });
  }
  if (action === 'clear') { const input = document.querySelector('#guess'); if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus({ preventScroll: true }); } }
  if (action === 'next' && state?.phase === 'reveal') nextQuestion();
  if (action === 'replay') startGame();
  if (action === 'about') showAbout();
  if (action === 'rules') showRules();
  if (action === 'source') showSource(button.dataset.id);
  if (action === 'photo') showPhoto(button.dataset.id);
  if (action === 'close-dialog') dialog.close();
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
  if (!Array.isArray(data.questions) || data.questions.length !== 10 || !Array.isArray(data.trivia) || data.questions.some(q => !q.image?.src)) throw new Error('invalid game data');
  const saved = read(storageKeys.session, null);
  if (isValidSession(saved, data.questions)) state = saved;
  else remove(storageKeys.session);
  render({ focus: false });
} catch {
  app.innerHTML = `<main class="loading"><span class="brand-mark">₩?</span><h1>가격표를 불러오지 못했어요.</h1><p>인터넷 연결을 확인한 뒤 다시 열어 주세요.</p><button class="button button-blue" id="reload-button">다시 불러오기</button></main>`;
  document.querySelector('#reload-button').addEventListener('click', () => location.reload());
}
