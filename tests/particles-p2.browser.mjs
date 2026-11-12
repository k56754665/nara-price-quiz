// P2 in real desktop/touch Chromium contexts. Every ranking RPC is fulfilled locally.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, scoreRound, MAX_GUESS } from '../dist/engine.js';

const project = fileURLToPath(new URL('../', import.meta.url)), root = path.join(project, 'dist');
const output = path.join(project, '.artifacts/particles-p2');
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
const bank = JSON.parse(await readFile(path.join(root, 'data.json'))), trivia = JSON.parse(await readFile(path.join(root, 'trivia.json')));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.otf': 'font/otf', '.woff2': 'font/woff2' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    assert(file.startsWith(root + path.sep));
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, key = 'nara-price-session-v3';
const checks = [], errors = [], geometry = [];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
let browser;
try {
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.UI_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  for (const profile of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 844, height: 390, mobile: true }, { width: 667, height: 375, mobile: true }]) {
    const label = `${profile.width}x${profile.height}`;
    const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, hasTouch: !!profile.mobile, isMobile: !!profile.mobile, deviceScaleFactor: profile.mobile ? 2 : 1, reducedMotion: 'no-preference' });
    let mode = 'success', release, submitted = 0;
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/leaderboard-config.js')) return route.fulfill({ contentType: 'text/javascript', body: 'export const LEADERBOARD_CONFIG = {url:"https://ranking.invalid",anonKey:"public-local-test-key-never-sent"};' });
      if (url.startsWith('https://ranking.invalid/rest/v1/rpc/')) {
        if (url.endsWith('/get_leaderboard')) return route.fulfill({ json: [{ rank: 4, nickname: '가격탐정', total_score: 9800, perfect_count: 10, question_count: 10 }] });
        assert(url.endsWith('/submit_score_v4'));
        submitted++;
        if (mode === 'pending') await new Promise(resolve => { release = resolve; });
        if (mode === 'error' || mode === 'duplicate') return route.fulfill({ status: 400, json: { message: mode === 'duplicate' ? 'already_submitted' : 'network' } });
        return route.fulfill({ json: [{ rank: 4, total_score: mode === 'kept' ? 10000 : 9800, perfect_count: 10 }] });
      }
      return url.startsWith(origin) ? route.continue() : route.abort();
    });
    await context.addInitScript(() => {
      localStorage.setItem('nara-price-sound', 'false'); localStorage.setItem('nara-price-music', 'false');
      window.__events = []; window.__freeze = false;
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) if (node.matches?.('.fx-particles')) {
          window.__events.push({ effect: node.dataset.effect, count: node.childElementCount });
          if (window.__freeze) for (const animation of node.getAnimations({ subtree: true })) {
            animation.pause(); const timing = animation.effect.getTiming(); animation.currentTime = timing.delay + timing.duration * .45;
          }
        }
      }).observe(document, { subtree: true, childList: true });
    });
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    const events = () => page.evaluate(() => window.__events);
    const saved = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    async function seed(results = false, previous = null) {
      const session = createSession(bank, trivia, true, () => .25);
      if (results) {
        session.phase = 'results'; session.index = 9;
        session.rounds = session.questions.map((q, i) => { const attempts = i ? [q.answer] : [1, q.answer]; return { candidateId: q.id, attempts, score: scoreRound(attempts, q.answer) }; });
      }
      await page.evaluate(({ key, session, previous }) => {
        localStorage.setItem(key, JSON.stringify(session));
        localStorage.setItem('nara-price-ranking-v1', JSON.stringify({ clientId: '00000000-0000-4000-8000-000000000001', nickname: '가격탐정', submitted: previous ? { [session.rankingSet]: { nickname: '가격탐정', totalScore: previous, rank: 4 } } : {}, played: {} }));
      }, { key, session, previous });
      await page.reload(); await page.locator('.art-title-menu > summary').click(); await page.locator('[data-action=resume]').click();
      await page.locator(results ? '.art-result-stage' : '#guess').waitFor();
      if (results) { await page.locator('[data-action=result-ranking]').first().click(); await page.locator('#ranking-form').waitFor(); }
      return session.questions[0];
    }
    async function sample(effect, expected, selectors, suffix = effect) {
      const layer = page.locator(`.fx-particles[data-effect=${effect}]`); await layer.waitFor();
      if (effect === 'registration') await page.locator('#info-dialog').evaluate(async modal => { await Promise.allSettled(modal.getAnimations().map(animation => animation.finished)); });
      const report = await layer.evaluate((layer, selectors) => {
        const bounds = layer.parentElement.getBoundingClientRect(), animations = layer.getAnimations({ subtree: true });
        const overlaps = new Set(), escaped = [];
        const motions = [];
        for (const progress of [.15, .45, .8]) {
          for (const animation of animations) { animation.pause(); const timing = animation.effect.getTiming(); animation.currentTime = timing.delay + timing.duration * progress; }
          motions.push(layer.firstElementChild.getBoundingClientRect().top);
          for (const piece of layer.children) {
            const box = piece.getBoundingClientRect();
            if (box.left < bounds.left - 1 || box.right > bounds.right + 1 || box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1) escaped.push(progress);
            for (const selector of selectors) for (const target of layer.parentElement.querySelectorAll(selector)) {
              let rect = target.getBoundingClientRect();
              if (target.matches('.art-quick button')) { const text = document.createRange(); text.selectNodeContents(target); rect = text.getBoundingClientRect(); }
              if (box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top) overlaps.add(selector);
            }
          }
        }
        for (const animation of animations) { const timing = animation.effect.getTiming(); animation.currentTime = timing.delay + timing.duration * .45; }
        return { count: layer.childElementCount, direction: layer.dataset.direction, motions, overlaps: [...overlaps], escaped, hidden: layer.getAttribute('aria-hidden'), pointerEvents: getComputedStyle(layer).pointerEvents, inModal: !!layer.closest('dialog[open]') };
      }, selectors);
      geometry.push({ profile: label, effect, ...report });
      await page.screenshot({ path: path.join(output, `${label}-${suffix}.png`) });
      assert.equal(report.count, expected); assert.equal(report.hidden, 'true'); assert.equal(report.pointerEvents, 'none');
      assert.deepEqual(report.overlaps, [], `${label} ${effect} obscures content`); assert.deepEqual(report.escaped, []);
      await layer.evaluateAll(layers => layers.forEach(layer => layer.getAnimations({ subtree: true }).forEach(animation => animation.play())));
      await layer.waitFor({ state: 'detached' });
      return report;
    }
    await page.goto(origin);
    for (const direction of ['up', 'down']) {
      const q = await seed(); await page.evaluate(() => { window.__freeze = true; });
      await page.locator('#guess').fill(String(direction === 'up' ? 1 : Math.round(q.answer * 2)));
      await page.locator('.guess-submit').click();
      const report = await sample('hint', profile.mobile ? 2 : 3, ['.art-hint-word', '.art-product', '.art-score', '.art-feedback', '#guess'], `hint-${direction}`);
      assert.equal(report.direction, direction);
      assert(direction === 'up' ? report.motions[2] < report.motions[0] : report.motions[2] > report.motions[0]);
      assert.equal((await saved()).attempts.length, 1);
    }
    pass(`${label}: UP/DOWN streaks follow the hint direction without obscuring text or product`);
    await seed(); await page.evaluate(() => { window.__freeze = true; });
    await page.locator('[data-action=add]').first().evaluate(button => { for (let i = 0; i < 8; i++) button.click(); });
    assert.equal((await saved()).draft, '80,000'); assert.equal((await events()).filter(e => e.effect === 'amount').length, 1);
    await sample('amount', 3, ['.art-price-entry', '.guess-submit', '.art-quick button', '.art-lives']);
    for (const button of await page.locator('[data-action=add]').all()) {
      const amount = Number(await button.getAttribute('data-amount'));
      if (amount <= 0) continue;
      if (profile.mobile) await button.tap(); else await button.click();
      await sample('amount', 3, ['.art-price-entry', '.guess-submit', '.art-quick button', '.art-lives'], `amount-${amount}`);
    }
    const amountEvents = (await events()).filter(e => e.effect === 'amount').length;
    await page.locator('#guess').fill('123'); await page.locator('[data-action=clear]').click();
    assert.equal((await events()).filter(e => e.effect === 'amount').length, amountEvents);
    await page.locator('#guess').fill(String(MAX_GUESS)); await page.locator('[data-action=add]').first().click();
    assert.equal((await events()).filter(e => e.effect === 'amount').length, amountEvents);
    pass(`${label}: burst throttle preserves eight amount changes; typing/clear/clamped value emit no particles`);
    for (const previous of [null, 1000]) {
      mode = 'success'; await seed(true, previous); await page.evaluate(() => { window.__freeze = true; });
      await page.locator('#ranking-nickname').fill('가격탐정'); await page.locator('.art-ranking-submit').click();
      const report = await sample('registration', 4, ['.art-ranking-best', '.art-ranking-header', '.art-ranking-row', '.art-ranking-columns'], previous ? 'registration-improved' : 'registration-first');
      assert(report.inModal); assert.equal((await saved()).rankSubmitted, true);
      await page.locator('[data-action=close-dialog]').click(); await page.locator('[data-action=result-ranking]').first().click();
      assert.equal((await events()).filter(e => e.effect === 'registration').length, 1);
    }
    pass(`${label}: successful first/improved registration sparkles once inside the native modal`);
    for (const [nextMode, previous] of [['kept', 10000], ['success', 9800], ['error', null], ['duplicate', null]]) {
      mode = nextMode; await seed(true, previous);
      await page.locator('#ranking-nickname').fill('가격탐정'); await page.locator('.art-ranking-submit').click();
      if (mode === 'error') await page.locator('#ranking-error').filter({ hasText: '연결' }).waitFor();
      else await page.locator('#ranking-form').waitFor({ state: 'detached' });
      await page.waitForTimeout(450);
      assert.equal((await events()).filter(e => e.effect === 'registration').length, 0);
      if (mode === 'kept' || previous === 9800) assert.equal(await page.locator('.fx-ranking-confirmed').count(), 1);
    }
    pass(`${label}: retained/tied records only confirm; failed or duplicate registrations never celebrate`);
    mode = 'pending'; await seed(true); const before = submitted;
    await page.locator('#ranking-nickname').fill('가격탐정'); await page.locator('.art-ranking-submit').click();
    await page.waitForFunction(() => document.querySelector('.art-ranking-submit')?.disabled);
    assert.equal((await events()).filter(e => e.effect === 'registration').length, 0);
    await page.locator('[data-action=close-dialog]').click();
    const deadline = Date.now() + 7000;
    while (!release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert(release, 'mock submission did not arrive');
    const complete = release; release = null; mode = 'success'; complete();
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).rankSubmitted, key);
    assert.equal(submitted, before + 1); assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal((await events()).filter(e => e.effect === 'registration').length, 0);
    pass(`${label}: pending registration is quiet and a late response does not reopen the closed dialog`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const q = await seed(); await page.locator('[data-action=add]').first().click();
    await page.locator('#guess').fill('1'); await page.locator('.guess-submit').click();
    await page.waitForFunction(() => document.querySelector('.art-hint-word')?.textContent === 'UP!');
    mode = 'success'; await seed(true); await page.locator('#ranking-nickname').fill('가격탐정'); await page.locator('.art-ranking-submit').click();
    await page.locator('.fx-ranking-confirmed').waitFor();
    assert.equal((await events()).filter(e => ['hint', 'amount', 'registration'].includes(e.effect)).length, 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    pass(`${label}: reduced motion retains input, hints and registration confirmation without particles`);
    if (profile.mobile) {
      mode = 'success'; await seed(true); await page.evaluate(() => { window.__freeze = true; });
      await page.locator('#ranking-nickname').fill('가격탐정'); await page.locator('.art-ranking-submit').click();
      await page.locator('.fx-particles[data-effect=registration]').waitFor();
      await page.setViewportSize({ width: profile.height, height: profile.width });
      await page.locator('#rotation-guide').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('#app').inert && !document.querySelector('#info-dialog').open && !document.querySelector('.fx-particles'));
      assert.equal(await page.locator('.fx-particles').count(), 0);
      await page.setViewportSize({ width: profile.width, height: profile.height });
      await page.locator('#info-dialog[open]').waitFor();
      assert.equal((await saved()).rankSubmitted, true);
      assert.equal(await page.locator('.fx-particles').count(), 0);
      pass(`${label}: rotation cleans modal particles, preserves registration and restores the dialog`);
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ checks, errors, geometry }, null, 2));
  console.log(`${checks.length} P2 particle checks passed`);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
