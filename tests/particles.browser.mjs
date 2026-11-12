// Exercise the real gameplay on desktop and touch/mobile viewports. No live writes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, scoreRound } from '../dist/engine.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(project, 'dist'), output = path.join(project, '.artifacts/particles');
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
const bank = JSON.parse(await readFile(path.join(root, 'data.json')));
const trivia = JSON.parse(await readFile(path.join(root, 'trivia.json')));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.otf': 'font/otf', '.woff2': 'font/woff2' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    assert(file.startsWith(root + path.sep));
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, key = 'nara-price-session-v3';
const checks = [], errors = [], geometry = [], scoreLandings = [];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
let browser;
try {
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.UI_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const profiles = [
    { width: 1920, height: 1080 }, { width: 1366, height: 768 },
    { width: 844, height: 390, mobile: true }, { width: 667, height: 375, mobile: true },
  ];
  for (const profile of profiles) {
    const label = `${profile.width}x${profile.height}`;
    const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, hasTouch: !!profile.mobile, isMobile: !!profile.mobile, deviceScaleFactor: profile.mobile ? 2 : 1, reducedMotion: 'no-preference' });
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await context.addInitScript(() => {
      localStorage.setItem('nara-price-sound', 'false');
      localStorage.setItem('nara-price-music', 'false');
      window.__particleEvents = [];
      window.__freezeParticles = false;
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.matches?.('.fx-particles')) {
            window.__particleEvents.push({ effect: node.dataset.effect, count: node.childElementCount, at: performance.now() });
            if (window.__freezeParticles) for (const animation of node.getAnimations({ subtree: true })) {
              animation.pause();
              const timing = animation.effect.getTiming();
              animation.currentTime = timing.delay + timing.duration * .4;
            }
          }
        }
      }).observe(document, { childList: true, subtree: true });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    const saved = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    const events = () => page.evaluate(() => window.__particleEvents);
    const empty = () => page.waitForFunction(() => !document.querySelector('.fx-particles, .fx-score-fly'));
    async function seed(attempts = [], finish = null, best = 0, question = null) {
      const session = createSession(bank, trivia, false, () => .25);
      if (question) {
        const existing = session.questions.findIndex(q => q.id === question.id);
        if (existing >= 0) [session.questions[0], session.questions[existing]] = [session.questions[existing], session.questions[0]];
        else session.questions[0] = question;
        session.questionIds = session.questions.map(q => q.id);
      }
      session.attempts = attempts;
      if (finish) {
        session.index = 9; session.phase = 'reveal';
        session.rounds = session.questions.map((q, i) => {
          const guesses = finish === 'zero' ? [1, 2, 3] : finish === 'mixed' && i === 0 ? [1, q.answer] : [q.answer];
          return { candidateId: q.id, attempts: guesses, score: scoreRound(guesses, q.answer) };
        });
      }
      await page.evaluate(({ key, session, best }) => {
        localStorage.setItem(key, JSON.stringify(session));
        localStorage.setItem('nara-price-best-v3', JSON.stringify(best));
      }, { key, session, best });
      await page.reload();
      await page.locator('.art-title-menu > summary').click();
      await page.locator('[data-action=resume]').click();
      await page.locator(finish ? '.art-reveal-stage' : '#guess').waitFor();
      return session.questions[0];
    }
    async function submit(value) {
      await page.locator('#guess').fill(String(value));
      await page.locator('.guess-submit').click();
      await page.locator('.fx-reacting').waitFor();
    }
    async function inspectScoreLabel() {
      const report = await page.locator('.fx-score-fly').evaluate(fly => {
        const animation = fly.getAnimations()[0], timing = animation.effect.getTiming();
        const previousTime = animation.currentTime;
        const distance = (a, b) => Math.hypot(a.left + a.width / 2 - b.left - b.width / 2, a.top + a.height / 2 - b.top - b.height / 2);
        animation.pause();
        animation.currentTime = timing.delay + timing.duration * .001;
        const originDistance = distance(fly.getBoundingClientRect(), document.querySelector('.art-reveal-earned strong').getBoundingClientRect());
        animation.currentTime = timing.delay + timing.duration * .98;
        const arrivalDistance = distance(fly.getBoundingClientRect(), document.querySelector('.art-reveal-total strong').getBoundingClientRect());
        const arrivalOpacity = Number(getComputedStyle(fly).opacity);
        animation.currentTime = previousTime;
        animation.play();
        return { originDistance, arrivalDistance, arrivalOpacity };
      });
      scoreLandings.push({ profile: label, kind: 'earned-label', ...report });
      assert(report.originDistance <= 2, `${label} earned label starts away from earned score`);
      assert(report.arrivalDistance <= 2, `${label} earned label misses current score`);
      assert(report.arrivalOpacity >= .1, `${label} earned label vanishes before arrival`);
    }
    async function inspect(effect, count, protectedSelectors, name = effect) {
      const layer = page.locator(`.fx-particles[data-effect="${effect}"]`);
      await layer.waitFor();
      const report = await layer.evaluate((layer, selectors) => {
        const stage = layer.parentElement, bounds = stage.getBoundingClientRect();
        const animations = layer.getAnimations({ subtree: true });
        const overlaps = new Set(), escaped = [];
        const protectedNodes = selectors.flatMap(selector => [...stage.querySelectorAll(selector)]);
        for (const progress of [.15, .4, .65, .85]) {
          for (const animation of animations) {
            animation.pause();
            const timing = animation.effect.getTiming();
            animation.currentTime = timing.delay + timing.duration * progress;
          }
          for (const piece of layer.children) {
            if (Number(getComputedStyle(piece).opacity) < .05) continue;
            const box = piece.getBoundingClientRect();
            if (box.left < bounds.left - 1 || box.right > bounds.right + 1 || box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1) escaped.push(progress);
            for (const node of protectedNodes) {
              let target = node.getBoundingClientRect();
              if (node.matches('.actual strong, .mine strong')) {
                const text = document.createRange(); text.selectNodeContents(node);
                target = text.getBoundingClientRect();
              }
              if (box.left < target.right && box.right > target.left && box.top < target.bottom && box.bottom > target.top) overlaps.add(node.className);
            }
          }
        }
        for (const animation of animations) {
          const timing = animation.effect.getTiming();
          animation.currentTime = timing.delay + timing.duration * .4;
        }
        const minVisibleWidth = Math.min(...[...layer.children].map(piece => piece.getBoundingClientRect().width));
        let arrivalDistance = null;
        if (layer.dataset.effect === 'score' || layer.dataset.effect === 'score-arrival') {
          for (const animation of animations) {
            const timing = animation.effect.getTiming();
            animation.currentTime = timing.delay + timing.duration * .98;
          }
          const target = stage.querySelector('.art-reveal-total strong').getBoundingClientRect();
          arrivalDistance = Math.max(...[...layer.children].map(piece => {
            const box = piece.getBoundingClientRect();
            return Math.hypot(box.left + box.width / 2 - target.left - target.width / 2, box.top + box.height / 2 - target.top - target.height / 2);
          }));
          for (const animation of animations) {
            const timing = animation.effect.getTiming();
            animation.currentTime = timing.delay + timing.duration * .4;
          }
        }
        return { count: layer.childElementCount, total: document.querySelectorAll('.fx-particle').length, minVisibleWidth, arrivalDistance, hidden: layer.getAttribute('aria-hidden'), pointerEvents: getComputedStyle(layer).pointerEvents, overlaps: [...overlaps], escaped };
      }, protectedSelectors);
      geometry.push({ profile: label, effect, ...report });
      await page.screenshot({ path: path.join(output, `${label}-${name}.png`) });
      assert.equal(report.count, count, `${label} ${effect} count`);
      assert.equal(report.hidden, 'true');
      assert.equal(report.pointerEvents, 'none');
      assert(report.total <= (profile.mobile ? 24 : 48));
      const minimumWidth = { correct: profile.mobile ? 14 : 18, price: profile.mobile ? 14 : 20, heart: 8, score: 8, 'score-arrival': 24, confetti: profile.mobile ? 10 : 14 }[effect];
      assert(report.minVisibleWidth >= minimumWidth, `${label} ${effect} is too small to read`);
      if (report.arrivalDistance !== null) {
        scoreLandings.push({ profile: label, kind: effect, arrivalDistance: report.arrivalDistance });
        assert(report.arrivalDistance <= 3, `${label} ${effect} misses current score`);
      }
      assert.deepEqual(report.overlaps, [], `${label} ${effect} obstructs content`);
      assert.deepEqual(report.escaped, [], `${label} ${effect} leaves stage`);
      await layer.evaluateAll(layers => layers.forEach(layer => layer.getAnimations({ subtree: true }).forEach(animation => animation.play())));
    }
    await page.goto(origin);
    const q = await seed();
    await page.locator('.guess-submit').click();
    assert.equal(await page.locator('.fx-particles').count(), 0);
    assert.equal((await saved()).attempts.length, 0);
    await page.evaluate(() => { window.__freezeParticles = true; });
    await submit(Math.round(q.answer * 1.05));
    await page.locator('#guess-form').evaluate(form => {
      for (let i = 0; i < 8; i++) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await inspect('correct', profile.mobile ? 6 : 12, ['.art-product', '.art-price-bubble', '.art-hint', '.art-score']);
    await page.locator('.art-reveal-stage').waitFor();
    await inspectScoreLabel();
    await inspect('price', profile.mobile ? 3 : 4, ['.actual strong', '.mine strong', '.art-reveal-photo', '.art-reveal-next']);
    await inspect('score', profile.mobile ? 3 : 6, ['.art-reveal-tag', '.art-reveal-header h1', '.art-reveal-prices', '.art-reveal-photo', '.art-reveal-next']);
    await inspect('score-arrival', 1, ['.art-reveal-header', '.art-reveal-prices', '.art-reveal-next']);
    await empty();
    assert.equal((await saved()).rounds[0].score, 1000);
    assert.equal(await page.locator('.art-reveal-total strong').textContent(), '1,000점');
    assert.equal((await events()).filter(e => e.effect === 'correct').length, 1);
    pass(`${label}: muted ±10% success, one burst, neutral price, score trail/arrival, clear content and cleanup`);

    await seed();
    await page.evaluate(() => { window.__freezeParticles = true; });
    await submit(1);
    await inspect('heart', profile.mobile ? 3 : 6, ['.art-price-bubble', '.art-lives img:nth-child(-n+2)']);
    await page.locator('.fx-reacting').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.art-lives .spent').count(), 1);
    await submit(2); await page.locator('.fx-reacting').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.art-lives .spent').count(), 2);
    await submit(3); await page.locator('.art-reveal-stage').waitFor();
    await inspect('price', profile.mobile ? 3 : 4, ['.actual strong', '.mine strong', '.art-reveal-photo'], 'missed-price');
    await empty();
    assert.equal((await saved()).rounds[0].score, 0);
    assert.equal((await events()).filter(e => e.effect === 'heart').length, 3);
    assert.equal((await events()).filter(e => e.effect === 'correct' || e.effect.startsWith('score')).length, 0);
    pass(`${label}: three misses consume one heart each; zero-point reveal has only neutral sparkles`);

    for (const [kind, best, count] of [['mixed', 1000, 18], ['perfect', 10000, 24]]) {
      await seed([], kind, best);
      await page.evaluate(() => { window.__freezeParticles = true; });
      await page.locator('[data-action=next]').click();
      await inspect('confetti', count / (profile.mobile ? 2 : 1), ['.art-result-panel'], kind === 'perfect' ? 'perfect' : 'new-best');
      await page.locator('[data-announcing]').waitFor({ state: 'detached' });
      await empty();
      assert.equal((await events()).filter(e => e.effect === 'confetti').length, 1);
    }
    pass(`${label}: record and tied perfect score celebrate once from both sides without covering the result panel`);

    if (profile.width === 1366) {
      for (const attempts of [[1], [1, 2]]) {
        const q = await seed(attempts); await submit(q.answer);
        await page.locator('.art-reveal-stage').waitFor();
        assert.equal((await saved()).rounds[0].score, attempts.length === 1 ? 800 : 500);
        await page.locator('[data-action=next]').evaluate(button => button.click());
        const departureEvents = (await events()).length;
        await page.locator('.fx-scene-busy').waitFor({ state: 'detached' });
        await empty();
        assert.equal((await saved()).index, 1);
        await page.waitForTimeout(500);
        assert.equal((await events()).length, departureEvents);
      }
      pass('800/500-point successes and immediate next preserve score while cancelling pending particles');

      for (const [kind, best] of [['mixed', 9800], ['zero', 0]]) {
        await seed([], kind, best); await page.locator('[data-action=next]').click();
        await page.locator('.art-result-stage').waitFor();
        await page.locator('[data-announcing]').waitFor({ state: 'detached' });
        assert.equal((await events()).filter(e => e.effect === 'confetti').length, 0);
      }
      await seed([], 'perfect', 0); await page.locator('[data-action=next]').click();
      await page.locator('.fx-confetti').waitFor();
      await page.locator('[data-action=replay]').evaluate(button => button.click());
      await page.locator('.fx-scene-busy').waitFor({ state: 'detached' });
      await empty();
      assert.equal((await saved()).rounds.length, 0);
      pass('Ordinary tie/zero do not celebrate; perfect plus new best and immediate replay leave no particles');

      let q = await seed(); await submit(q.answer);
      await page.reload(); await page.locator('.art-title-menu > summary').click(); await page.locator('[data-action=resume]').click();
      await page.waitForTimeout(800);
      assert.equal((await events()).length, 0);
      assert.equal(await page.locator('.art-reveal-total strong').textContent(), '1,000점');
      pass('Reload during reaction restores the score without replaying any particle effect');

      q = await seed(); await submit(q.answer); await page.locator('.fx-particles[data-effect=price]').waitFor();
      await page.evaluate(() => document.querySelector('#info-dialog').showModal());
      await empty(); await page.waitForTimeout(700);
      assert.equal(await page.locator('.fx-particles').count(), 0);
      await page.evaluate(() => document.querySelector('#info-dialog').close());
      assert.equal(await page.locator('.art-reveal-total strong').textContent(), '1,000점');
      pass('Opening a native modal clears active and queued particles and settles the real score');

      q = await seed(); await submit(q.answer); await page.locator('.fx-particles[data-effect=score]').waitFor();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await empty();
      assert.equal(await page.locator('.art-reveal-total strong').textContent(), '1,000점');
      q = await seed(); await submit(q.answer); await page.locator('.art-reveal-stage').waitFor();
      await page.waitForTimeout(800);
      assert.equal((await events()).length, 0);
      assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
      await seed([], 'perfect', 0); await page.locator('[data-action=next]').click();
      assert.equal(await page.locator('.art-result-score').textContent(), '10,000점');
      await page.waitForTimeout(850);
      assert.equal((await events()).length, 0);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      pass('Reduced motion at startup and during reward suppresses all particles and displays final scores immediately');

      q = await seed(); await submit(q.answer);
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.locator('.art-reveal-stage').waitFor(); await page.waitForTimeout(750);
      assert.equal(await page.locator('.fx-particles').count(), 0);
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
      await empty();
      pass('Hidden-tab interruption clears particles; returning does not replay accumulated effects');

      await seed();
      let expected = 0;
      for (const attemptCount of [1, 2, 3, 0, 1, 2, 3, 0, 1, 2]) {
        const state = await saved(), answer = state.questions[state.index].answer;
        const guesses = attemptCount ? [...Array(attemptCount - 1).fill(1), answer] : [1, 2, 3];
        for (const guess of guesses) {
          await submit(guess);
          await page.locator('.fx-reacting').waitFor({ state: 'detached' });
        }
        await page.locator('.art-reveal-stage').waitFor(); await empty();
        expected += attemptCount ? [0, 1000, 800, 500][attemptCount] : 0;
        assert.equal(await page.locator('.art-reveal-total strong').textContent(), `${expected.toLocaleString('ko-KR')}점`);
        assert.equal(await page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.target?.matches?.('.fx-particle')).length), 0);
        await page.locator('[data-action=next]').click();
        if ((await saved()).phase === 'question') await page.waitForFunction(() => !!document.querySelector('#guess') && !document.querySelector('#guess').disabled);
      }
      await page.locator('.art-result-stage').waitFor();
      await page.locator('[data-announcing]').waitFor({ state: 'detached' }); await empty();
      assert.equal(await page.locator('.art-result-score').textContent(), `${expected.toLocaleString('ko-KR')}점`);
      assert.equal((await saved()).rounds.length, 10);
      await page.locator('[data-action=replay]').click();
      await page.waitForFunction(() => !!document.querySelector('#guess') && !document.querySelector('#guess').disabled);
      await empty();
      assert.equal((await saved()).rounds.length, 0);
      pass('Ten live rounds total 6,400 points without particle DOM/animation accumulation; replay starts cleanly');
    }
    if (profile.width === 844) {
      const q = await seed(); await submit(q.answer);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#rotation-guide').waitFor({ state: 'visible' });
      await page.locator('.art-reveal-stage').waitFor({ state: 'attached' }); await page.waitForTimeout(750);
      assert.equal(await page.locator('.fx-particles, .fx-score-fly').count(), 0);
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForFunction(() => !document.querySelector('#app').inert);
      assert.equal((await saved()).rounds[0].score, 1000);
      assert.equal(await page.locator('.art-reveal-total strong').textContent(), '1,000점');
      await page.screenshot({ path: path.join(output, `${label}-rotation-restored.png`) });
      pass('Touch/mobile rotation during a reaction preserves the session and returns without stale particles');
    }
    if (profile.width === 667) {
      const ordered = [...bank.questions].sort((a, b) => a.answer - b.answer);
      for (const question of [ordered[0], ordered.at(-1)]) {
        await seed([], null, 0, question);
        await page.evaluate(() => { window.__freezeParticles = true; });
        await submit(question.answer); await page.locator('.art-reveal-stage').waitFor();
        await inspect('price', 3, ['.actual strong', '.mine strong', '.art-reveal-photo'], `price-${question.answer}`);
        // Resume any reward groups held by the visual sampling hook as well.
        await page.evaluate(() => {
          window.__freezeParticles = false;
          for (const layer of document.querySelectorAll('.fx-particles')) for (const animation of layer.getAnimations({ subtree: true })) animation.play();
        });
        await empty();
      }
      pass('667x375: smallest/largest bank prices keep their digits and product photo clear');
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ checks, errors, geometry, scoreLandings }, null, 2));
  console.log(`${checks.length} particle checks passed`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
