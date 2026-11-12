// Browser audit. Run manually with `node tests/ui.browser.mjs`.
// External writes/shares are intercepted; the served game files stay unchanged.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, scoreRound } from '../dist/engine.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.UI_AUDIT_OUTPUT ? path.resolve(project, process.env.UI_AUDIT_OUTPUT) : path.join(project, '.artifacts/ui-audit');
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
const bank = JSON.parse(await readFile(path.join(project, 'dist/data.json')));
const trivia = JSON.parse(await readFile(path.join(project, 'dist/trivia.json')));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.otf': 'font/otf', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(project, 'dist', pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
    if (!file.startsWith(path.join(project, 'dist') + path.sep)) throw Error('outside root');
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const key = 'nara-price-session-v3';
const results = [], errors = [], screenshots = [], typography = [];
const record = (item, detail = '') => { results.push({ item, status: '통과', detail }); console.log('PASS ' + item); };
let browser;
try {
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.UI_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1920, height: 1080 }, hasTouch: true });
  let rankingMode = 'full', submissionMode = 'error', dataMode = 'normal', releaseLoading, releaseRankingLoading, submitRequests = 0;
  let submissionGate = Promise.resolve();
  const loading = new Promise(resolve => { releaseLoading = resolve; });
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.endsWith('/data.json') && dataMode === 'failure') return route.fulfill({ status: 503, body: 'unavailable' });
    if (url.endsWith('/data.json') && dataMode === 'loading') { await loading; return route.continue(); }
    if (url.includes('/rest/v1/rpc/get_leaderboard')) {
      if (rankingMode === 'loading') await new Promise(resolve => { releaseRankingLoading = resolve; });
      if (rankingMode === 'error') return route.fulfill({ status: 503, json: { message: 'network' } });
      return route.fulfill({ json: rankingMode === 'empty' ? [] : Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, nickname: i === 0 ? '열두글자닉네임테스트중임' : `가격탐정 ${i + 1}`, total_score: 10000 - i * 300, perfect_count: 10 - Math.floor(i / 2), question_count: 10 })) });
    }
    if (url.includes('/rest/v1/rpc/submit_score')) {
      submitRequests++;
      await submissionGate;
      if (submissionMode === 'error') return route.fulfill({ status: 503, json: { message: 'network' } });
      const submitted = route.request().postDataJSON();
      const rounds = submitted.p_attempts.map(r => ({ score: scoreRound(r.attempts, bank.questions.find(q => q.id === r.question_id).answer) }));
      return route.fulfill({ json: [{ rank: 4, total_score: rounds.reduce((s, r) => s + r.score, 0), perfect_count: rounds.filter(r => r.score).length }] });
    }
    if (url.startsWith(origin)) return route.continue();
    return route.abort(); // SDK and all unrelated external requests cannot send anything.
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { if (window.__clipboardFail) throw Error('denied'); window.__copied = text; } } });
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const ready = async () => page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(i => { i.loading = 'eager'; return i.decode().catch(() => {}); }));
    await Promise.all(['result-panel', 'bubble-box', 'stage-background'].map(name => { const image = new Image(); image.src = `./assets/designer/${name}.png`; return image.decode().catch(() => {}); }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const capture = async name => {
    await ready();
    const layout = await page.evaluate(() => {
      const dialog = document.querySelector('dialog');
      const heading = dialog.open && dialog.querySelector('.dialog-heading');
      const visibleGame = !document.documentElement.classList.contains('needs-rotation');
      const lives = visibleGame && !dialog.open && document.querySelector('.art-lives');
      const panel = visibleGame ? document.querySelector('.art-result-panel') : null;
      const rect = e => e.getBoundingClientRect();
      const wave = panel?.querySelector('.art-result-wave');
      const backpack = document.querySelector('.art-result-backpack');
      const revealBoard = visibleGame && !dialog.open && document.querySelector('.art-reveal-board');
      const rankingList = visibleGame && dialog.open && dialog.querySelector('.art-ranking-list');
      const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const stage = visibleGame && !dialog.open && document.querySelector('.art-stage');
      let question = null;
      if (stage) {
        const title = stage.querySelector('.art-title'), photo = stage.querySelector('.art-product');
        const input = stage.querySelector('#guess'), bubble = stage.querySelector('.art-price-bubble');
        const quick = stage.querySelector('.art-quick'), submit = stage.querySelector('.guess-submit');
        const attempt = stage.querySelector('.art-attempt');
        const hint = stage.querySelector('.art-feedback');
        const style = getComputedStyle(input), canvas = document.createElement('canvas').getContext('2d');
        canvas.font = style.font;
        const contained = e => rect(e).left >= rect(bubble).left && rect(e).right <= rect(bubble).right + 1 && rect(e).bottom <= rect(bubble).bottom + 1;
        question = {
          stageWidth: rect(stage).width, mode: document.documentElement.dataset.stageLayout,
          title: parseFloat(getComputedStyle(title).fontSize), status: parseFloat(getComputedStyle(attempt).fontSize),
          submit: parseFloat(getComputedStyle(submit).fontSize), quick: parseFloat(getComputedStyle(quick.firstElementChild).fontSize),
          amount: parseFloat(style.fontSize),
          titleInside: rect(title).top >= rect(stage).top + rect(stage).height * .08,
          titlePhotoSeparate: rect(photo).top >= rect(title).bottom,
          controlsInside: [input, submit, quick].every(contained),
          rowsSeparate: rect(quick).top >= Math.max(rect(input).bottom, rect(submit).bottom) - 1,
          amountFits: canvas.measureText(input.value).width <= input.clientWidth + 1,
          livesGap: rect(lives).top - rect(bubble).bottom,
          hintGap: hint ? rect(bubble).left - rect(hint).right : null,
          hintInside: hint ? rect(hint).left >= rect(stage).left && rect(hint).bottom <= rect(stage).bottom + 1 && hint.scrollWidth <= hint.clientWidth + 1 : true,
        };
      }
      return {
        headingInset: heading ? rect(heading).top - rect(dialog).top : 20,
        heartsInside: lives ? rect(lives).bottom <= rect(lives.closest('.art-stage')).bottom + 1 : true,
        mascotsSeparate: panel && !dialog.open ? !intersects(rect(wave), rect(backpack)) : true,
        resultActionsInside: panel && !dialog.open ? rect(panel.querySelector('.art-result-actions')).bottom <= rect(panel).bottom - 12 : true,
        desktopRevealFits: revealBoard && document.documentElement.dataset.stageLayout === 'desktop' ? revealBoard.scrollHeight <= revealBoard.clientHeight + 1 : true,
        desktopRankingRowsVisible: rankingList && rect(rankingList.closest('.art-ranking-stage')).width > 900 ? rect(rankingList).height >= 88 : true,
        question,
      };
    });
    assert(layout.headingInset >= 14, name + ': modal heading touches frame');
    assert(layout.heartsInside, name + ': hearts clipped');
    assert(layout.mascotsSeparate, name + ': mascots overlap');
    assert(layout.resultActionsInside, name + ': result actions touch frame');
    assert(layout.desktopRevealFits, name + ': desktop reveal content obscured by frame');
    assert(layout.desktopRankingRowsVisible, name + ': desktop ranking list squeezed by form');
    if (layout.question) {
      const q = layout.question;
      assert(q.titleInside && q.titlePhotoSeparate && q.controlsInside && q.rowsSeparate && q.amountFits, name + ': ' + JSON.stringify(q));
      assert(q.livesGap >= 2 && q.livesGap <= 28, name + ': excessive/overlapping lives gap');
      assert(q.hintInside && (q.hintGap === null || q.hintGap >= 11.9), name + ': hint overlaps controls or stage boundary: ' + JSON.stringify(q));
      assert(q.stageWidth <= 900 ? q.mode === 'compact' && q.status >= 10 && q.title >= 16 : q.mode === 'desktop' && q.title >= 24 && q.status >= 12 && q.submit >= 16, name + ': wrong typography mode');
      typography.push({ name, ...q });
    }
    await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' }); screenshots.push(name + '.png');
  };
  const saved = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
  const close = () => page.locator('#info-dialog [data-action=close-dialog]').last().click();
  const menu = async action => { const details = page.locator('details').filter({ has: page.locator('nav.art-menu-content') }); if (!await details.evaluate(e => e.open)) await details.locator('summary').click(); await page.locator(`.art-menu-content [data-action="${action}"]`).click(); };
  const resume = async () => { await menu('resume'); };
  const guess = async value => {
    await page.locator('#guess').fill(String(value));
    await page.locator('.guess-submit').click();
    await page.locator('.fx-reacting').waitFor({ state: 'detached' });
  };
  const fit = async selector => {
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
    const metrics = await page.locator(selector).evaluate(e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth }; });
    assert(Math.abs(metrics.w / metrics.h - 16 / 9) < .005, JSON.stringify(metrics));
    assert(metrics.x >= -.5 && metrics.y >= -.5 && metrics.x + metrics.w <= metrics.vw + .5 && metrics.y + metrics.h <= metrics.vh + .5, JSON.stringify(metrics));
    assert(!metrics.overflow);
  };
  const targets = async selector => {
    const bad = await page.locator(selector).evaluateAll(elements => elements.filter(e => { const b = e.getBoundingClientRect(); return b.width < 43.9 || b.height < 43.9; }).map(e => ({ text: e.textContent, w: e.offsetWidth, h: e.offsetHeight })));
    assert.deepEqual(bad, []);
  };
  const seed = async session => { await page.evaluate(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key, session }); await page.reload(); await page.locator('.art-title-stage').waitFor(); await resume(); };
  dataMode = 'loading';
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('.loading').waitFor(); await capture('loading');
  dataMode = 'normal'; releaseLoading(); await page.locator('.art-title-stage').waitFor();
  record('로딩 화면');
  await page.locator('.art-title-start').hover(); await capture('title-hover');
  await page.locator('.art-title-exit').hover(); await page.mouse.down(); await capture('title-pressed'); await page.mouse.move(1, 1); await page.mouse.up();
  for (const action of ['rules', 'about']) {
    await menu(action); await capture(action + '-1920');
    if (action === 'rules') { await page.locator('.formula summary').click(); assert(await page.locator('.formula').getAttribute('open') !== null); }
    await page.keyboard.press('Escape'); assert(!await page.locator('dialog').evaluate(e => e.open));
  }
  const initialSound = await page.locator('.art-menu-content [data-action=sound]').getAttribute('aria-pressed');
  await menu('sound'); assert.notEqual(await page.locator('.art-menu-content [data-action=sound]').getAttribute('aria-pressed'), initialSound);
  await page.locator('.art-menu-content [data-action=sound]').click();
  assert.equal(await page.locator('.art-menu-content [data-action=sound]').getAttribute('aria-pressed'), initialSound);
  await page.locator('.art-menu-content [data-action=fullscreen]').click();
  assert(await page.evaluate(() => !!document.fullscreenElement));
  await page.locator('.art-menu-content [data-action=fullscreen]').click();
  await page.locator('.art-title-menu summary').click();
  await page.locator('[data-action=exit]').click(); await capture('exit'); await close();
  record('점수·힌트 기준·데이터·종료 안내, Escape 닫기, 효과음 상태, 전체 화면 전환');
  await page.locator('#setup-form button').click();
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'guess');
  await page.locator('.guess-submit').click(); assert.equal(await page.locator('#guess').getAttribute('aria-invalid'), 'true');
  await capture('input-error-1920');
  for (const button of await page.locator('.art-quick [data-action=add]').all()) await button.tap();
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'guess');
  assert.equal((await saved()).draft, '111,110,000');
  await page.locator('[data-action=clear]').click(); assert.equal((await saved()).draft, '');
  await page.locator('#guess').fill('999999999999'); assert.equal((await saved()).draft, '999,999,999,999');
  await page.reload(); await resume(); assert.equal(await page.locator('#guess').inputValue(), '999,999,999,999');
  record('빈 입력 오류·가격 가산 5종·지우기·최대 12자리 입력·새로고침 복원');
  const game = await saved();
  for (let i = 0; i < 10; i++) {
    const a = game.questions[i].answer;
    const values = i === 0 ? [Math.round(a * 1.05)] : i === 1 ? [1, a] : i === 2 ? [999999999999, 1, a] : i === 3 ? [1, 1, 1] : [a];
    for (let j = 0; j < values.length; j++) {
      await guess(values[j]);
      if (i === 1 && j === 0) { await capture('retry-up'); assert.equal(await page.locator('.art-lives .spent').count(), 1); }
      if (i === 2 && j === 0) await capture('retry-down');
      if (i === 2 && j === 1) { await capture('last-attempt'); assert.equal(await page.locator('.art-lives .spent').count(), 2); }
    }
    assert.equal((await saved()).phase, 'reveal');
    if (i <= 3) await capture(['reveal-first', 'reveal-second', 'reveal-third', 'reveal-failure'][i]);
    if (i === 0) {
      await page.locator('.art-reveal-photo').click(); await capture('photo-1920'); await close();
      await menu('source'); await capture('source-1920'); await close();
    }
    await page.locator('[data-action=next]').click();
    await page.locator('.fx-scene-busy').waitFor({ state: 'detached' });
  }
  const completed = await saved();
  assert.deepEqual(completed.rounds.map(r => r.score), [1000, 800, 500, 0, 1000, 1000, 1000, 1000, 1000, 1000]);
  assert.equal(completed.phase, 'results');
  await capture('result-mixed-1920');
  record('실제 10라운드: 1·2·3회 정답/3회 실패/허용오차 5%/8,300점 합산/최종 결과');
  await menu('result-details');
  assert.equal(await page.locator('.recap-entry').count(), 10);
  await page.locator('.recap-art').nth(7).click(); await capture('nested-photo');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.recap-entry').count(), 10);
  await page.locator('.recap-item .source-link').nth(7).click();
  const sourceDownload = page.waitForEvent('download'); await page.locator('.download-link').click();
  assert((await sourceDownload).suggestedFilename().includes('검증데이터'));
  await page.locator('.dialog-back').click();
  const download = page.waitForEvent('download'); await page.locator('[data-action=download]').click();
  const downloaded = await download; const downloadPath = path.join(output, 'downloaded-result.json'); await downloaded.saveAs(downloadPath);
  assert.equal(JSON.parse(await readFile(downloadPath)).rounds.length, 10);
  await capture('result-details-1920'); await close();
  record('상세 결과 10개·중첩 사진/계약 창·이전 창 및 스크롤 복귀·결과 JSON/출제 데이터 다운로드');
  await menu('share'); assert((await page.evaluate(() => window.__copied)).includes('8,300'));
  await page.evaluate(() => { window.__clipboardFail = true; });
  await menu('share'); await capture('copy-fallback'); assert(await page.locator('.share-fallback').isVisible()); await close();
  await page.evaluate(() => { window.__clipboardFail = false; });
  await page.locator('.art-result-share').click(); assert((await page.evaluate(() => window.__copied)).includes('8,300'));
  await page.locator('.art-result-kakao').click(); await capture('kakao-unavailable');
  record('결과 복사·복사 권한 거부 대체 창·시스템 공유 미지원 대체·카카오 SDK 실패 안내 (실제 발송 없음)');
  await page.locator('.art-result-rank').click();
  await page.locator('#ranking-list[aria-busy=false]').waitFor(); assert.equal(await page.locator('.art-ranking-row').count(), 20);
  await page.locator('#ranking-nickname').fill('<>'); await page.locator('.art-ranking-submit').click();
  assert((await page.locator('#ranking-error').textContent()).length > 0);
  let releaseSubmit;
  submissionGate = new Promise(resolve => { releaseSubmit = resolve; });
  await page.locator('#ranking-nickname').fill('테스트가격탐정'); await page.locator('.art-ranking-submit').click();
  assert(await page.locator('.art-ranking-submit').isDisabled());
  assert.equal(await page.locator('#ranking-error').textContent(), '');
  await capture('ranking-submitting'); releaseSubmit();
  await page.locator('.art-ranking-submit:not([disabled])').waitFor(); await capture('ranking-submit-error');
  submissionMode = 'success'; submissionGate = Promise.resolve(); await page.locator('.art-ranking-submit').click();
  await page.locator('.art-ranking-best').waitFor(); await page.locator('#ranking-list[aria-busy=false]').waitFor(); await capture('ranking-registered');
  assert.equal(submitRequests, 2); await close();
  record('랭킹 20명·긴 닉네임·등록 입력 검증·전송중 비활성·오류 복구·등록 완료 (모의 서버)');
  for (const [width, height] of [[1920, 1080], [1366, 768], [1062, 728], [1024, 768], [1920, 600], [901, 600], [900, 600], [844, 390], [667, 375], [844, 360], [844, 320]]) {
    await page.setViewportSize({ width, height });
    const tag = `${width}x${height}`;
    await seed(completed); await fit('.art-result-stage'); await targets('.art-result-actions button, .art-result-rank, .art-result-menu summary'); await capture('result-' + tag);
    await menu('result-details'); await capture('details-' + tag);
    await page.locator('.recap-art').last().click(); await close(); assert.equal(await page.locator('.recap-entry').count(), 10); await close();
    await page.locator('.art-result-rank').click(); await page.locator('#ranking-list[aria-busy=false]').waitFor(); await fit('.art-ranking-stage'); await capture('ranking-' + tag); await close();
    const session = createSession(bank, trivia, true);
    // Exercise the longest real title/spec and trivia without changing source data.
    session.questions[0] = structuredClone(bank.questions.reduce((a, b) => a.title.length + a.specification.length > b.title.length + b.specification.length ? a : b));
    session.questions = [session.questions[0], ...bank.questions.filter(q => q.id !== session.questions[0].id).slice(0, 9)];
    session.questionIds = session.questions.map(q => q.id);
    session.triviaRounds.sort((a, b) => b.text.length - a.text.length);
    await seed(session); await fit('.art-stage'); await targets('.art-quick button, .guess-submit, .art-menu summary'); await capture('question-' + tag);
    assert.equal(await page.locator('.art-specs').count(), 0);
    assert.equal(await page.locator('.art-title').innerText(), `${session.questions[0].title} 얼마일까요?`);
    assert(await page.locator('.art-product-name').evaluate(name => getComputedStyle(name).color !== getComputedStyle(name.parentElement).color));
    const conditionTags = page.locator('.art-conditions .art-tags span');
    assert.deepEqual(await conditionTags.allTextContents(), [`#${session.questions[0].quantity} 기준`, '#배송·하차 포함', '#부가세 포함']);
    assert(await conditionTags.evaluateAll(tags => tags.every(tag => {
      const box = tag.getBoundingClientRect();
      const board = tag.closest('.art-board-content').getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.left >= board.left - 1 && box.right <= board.right + 1 && box.bottom <= board.bottom + 1;
    })));
    await page.locator('#guess').fill('999999999999'); await capture('amount-max-' + tag); await page.locator('[data-action=clear]').tap();
    await page.locator('.guess-submit').click(); await capture('error-' + tag);
    await guess(999999999999); await capture('retry-' + tag);
    await guess(1); await capture('last-attempt-' + tag);
    await guess(session.questions[0].answer); await fit('.art-reveal-stage'); await capture('reveal-' + tag);
    const footer = await page.locator('.art-reveal-footer').boundingBox(); assert(footer.y + footer.height <= height + 1);
    const knowledgeCard = page.locator('.art-reveal-info .inline-knowledge');
    await knowledgeCard.evaluate(e => { e.scrollTop = e.scrollHeight; });
    const sourceRect = await knowledgeCard.locator('.knowledge-source a').boundingBox();
    assert(sourceRect.y + sourceRect.height <= height + 1);
    await capture('knowledge-source-' + tag);
    await page.locator('.art-reveal-photo').click(); await capture('photo-' + tag); await close();
    await menu('source'); await capture('source-' + tag); await close();
    await menu('rules'); await capture('rules-' + tag); await close();
    await menu('about'); await capture('about-' + tag); await close();
    await menu('home'); await fit('.art-title-stage'); await targets('.art-title-action, .art-title-menu summary'); await capture('title-' + tag);
    record(`${tag}: 5개 무대 비율·레터박스·가로 넘침·주요 터치 영역·보조 창·긴 콘텐츠`);
  }
  await page.locator('#setup-form button').click(); await guess(1);
  const beforeRotate = JSON.stringify(await saved());
  await page.locator('.art-menu summary').click(); await page.locator('.art-menu-content [data-action=rules]').click();
  for (const [width, height] of [[390, 844], [375, 667]]) {
    await page.setViewportSize({ width, height }); await page.waitForFunction(() => document.querySelector('#app').inert); assert(await page.locator('#rotation-guide').isVisible());
    assert(await page.locator('#app').evaluate(e => e.inert)); assert(!await page.locator('dialog').isVisible());
    await capture(`rotation-${width}x${height}`);
    await page.setViewportSize({ width: 844, height: 390 }); await page.locator('dialog[open]').waitFor({ state: 'visible' });
    assert.equal(JSON.stringify(await saved()), beforeRotate);
  }
  await close(); record('세로 390×844/375×667 회전 안내·입력 차단·가로 복귀 시 오답/팝업/점수 보존');
  for (const mode of ['empty', 'error', 'loading', 'full']) {
    rankingMode = mode; await menu('ranking');
    if (mode === 'loading') { await page.locator('.art-ranking-message.is-loading').waitFor(); await capture('ranking-loading'); releaseRankingLoading(); }
    await page.locator('#ranking-list[aria-busy=false]').waitFor(); await capture(mode === 'loading' ? 'ranking-loading-complete' : 'ranking-' + mode);
    if (mode === 'error') { rankingMode = 'full'; await page.locator('[data-action=retry-ranking]').click(); await page.locator('.art-ranking-row').first().waitFor(); }
    await close();
  }
  record('랭킹 비어 있음·연결 실패·다시 불러오기·로딩·정상 목록');
  for (const score of [0, 10000]) {
    const session = createSession(bank, trivia, true);
    session.phase = 'results'; session.index = 9;
    session.rounds = session.questions.map(q => ({ candidateId: q.id, attempts: score ? [q.answer] : [1, 1, 1], score: score ? 1000 : 0 }));
    await seed(session); await capture('result-' + score + '-mobile'); await page.setViewportSize({ width: 1920, height: 1080 }); await capture('result-' + score + '-desktop'); await page.setViewportSize({ width: 844, height: 390 });
  }
  record('0점·10,000점 결과, 등급 및 긴 점수 표시');
  await page.locator('[data-action=replay]').click(); const restarted = await saved();
  assert.equal(restarted.index, 0); assert.equal(restarted.rounds.length, 0); assert.equal(restarted.draft, '');
  record('다시하기: 첫 문제·0점·빈 입력으로 초기화');
  await context.route('**/leaderboard-config.js', route => route.fulfill({ contentType: 'text/javascript', body: 'export const LEADERBOARD_CONFIG = {};' }));
  await page.reload(); await page.locator('.art-title-stage').waitFor(); assert(await page.locator('.art-title-ranking').isDisabled()); await capture('ranking-disabled');
  await context.unroute('**/leaderboard-config.js');
  record('랭킹 미설정 시 비활성 버튼');
  await context.route('**/assets/products/*', route => route.abort());
  await page.reload(); await resume(); await capture('image-unavailable'); assert(await page.locator('.image-unavailable').count());
  assert(await page.locator('.product-photo-fallback').isVisible());
  await context.unroute('**/assets/products/*');
  dataMode = 'failure'; await page.reload(); await page.locator('#reload-button').waitFor(); await capture('load-failure');
  dataMode = 'normal'; await page.locator('#reload-button').click(); await page.locator('.art-title-stage').waitFor();
  record('상품 이미지 실패 대체 설명·데이터 로딩 실패·다시 불러오기 복구');
  await page.emulateMedia({ reducedMotion: 'reduce' }); await menu('rules'); assert.equal(await page.locator('dialog').evaluate(e => getComputedStyle(e).animationName), 'none'); await close();
  assert.deepEqual(errors, []); record('브라우저 JavaScript 오류 0건·동작 줄이기 설정');
  // Second browser smoke check, without touching the main user profile.
  const edge = await playwright.chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const edgePage = await edge.newPage({ viewport: { width: 667, height: 375 } });
  await edgePage.goto(origin); await edgePage.locator('.art-title-stage').waitFor(); await edgePage.locator('#setup-form button').click(); await edgePage.locator('.guess-submit').click();
  assert.equal(await edgePage.locator('#guess').getAttribute('aria-invalid'), 'true'); await edge.close(); record('Microsoft Edge: 667×375 시작·입력 오류 표시');
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results, errors, screenshots, typography, network: '랭킹 쓰기·공유·SDK는 인터셉트. 실제 외부 쓰기 없음.', browsers: ['Chrome (full)', 'Edge (smoke)'] }, null, 2));
  console.log(`DONE ${results.length} checks; ${screenshots.length} screenshots`);
} catch (error) {
  await writeFile(path.join(output, 'verification-failure.json'), JSON.stringify({ results, errors, failure: error.stack }, null, 2));
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
