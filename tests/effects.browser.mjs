// Regression coverage for transient feedback, real local audio and saved progress.
// All non-local traffic is blocked; this test never submits a live ranking.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '../dist/engine.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(project, '.artifacts/effects');
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
const bank = JSON.parse(await readFile(path.join(project, 'dist/data.json')));
const trivia = JSON.parse(await readFile(path.join(project, 'dist/trivia.json')));
const root = path.join(project, 'dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.otf': 'font/otf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    assert(file.startsWith(root + path.sep));
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const key = 'nara-price-session-v3';
const checks = [], errors = [];
function pass(text) { checks.push(text); console.log('PASS ' + text); }
let browser;
try {
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.UI_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await context.addInitScript(() => {
    window.__audioPlayed = [];
    window.__clickPlayed = 0;
    window.__answerNotes = [];
    const oscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const source = oscillator.call(this), start = source.start;
      source.start = function (...args) {
        window.__clickPlayed++;
        if (this.type === 'custom') window.__answerNotes.push({ frequency: this.frequency.value, at: args[0] });
        return start.apply(this, args);
      };
      return source;
    };
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = create.call(this), start = source.start, stop = source.stop;
      let event;
      source.start = function (...args) {
        event = { duration: this.buffer.duration, context: this.context.state, loop: this.loop, at: args[0] ?? this.context.currentTime, stops: [] };
        window.__audioPlayed.push(event);
        return start.apply(this, args);
      };
      source.stop = function (...args) { event?.stops.push({ at: this.context.currentTime, scheduled: args[0] }); return stop.apply(this, args); };
      return source;
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  const saved = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
  const audio = () => page.evaluate(() => window.__audioPlayed.filter(event => !event.loop));
  async function seed(attempts = []) {
    const session = createSession(bank, trivia, true, () => .25);
    session.attempts = attempts;
    await page.evaluate(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key, session });
    await page.reload();
    await page.locator('.art-title-menu > summary').click();
    await page.locator('.art-title-menu [data-action=resume]').click();
    await page.locator('#guess').waitFor();
    return session.questions[0];
  }
  async function submit(value) {
    await page.locator('#guess').fill(String(value));
    await page.locator('.guess-submit').click();
    await page.locator('.fx-reacting').waitFor();
  }
  async function settled() { await page.locator('.fx-reacting').waitFor({ state: 'detached' }); }
  await page.goto(origin);
  await page.locator('.art-title-start').click();
  await page.waitForFunction(() => window.__clickPlayed > 0);
  pass('First start click unlocks Web Audio and plays its button sound across navigation');
  assert.deepEqual(await readFile(path.join(project, 'dist/assets/designer/curtain-closed.png')), await readFile(path.join(project, 'design-source/완전히 닫힌 보랏빛 무대 커튼.png')));
  assert.equal(await page.locator('.fx-curtain-half').count(), 2);
  assert.equal(await page.locator('.guess-submit').isDisabled(), true);
  await page.waitForFunction(() => {
    const halves = document.querySelectorAll('.fx-curtain-half');
    return halves.length === 2 && parseFloat(getComputedStyle(halves[0]).translate) < 0 && parseFloat(getComputedStyle(halves[1]).translate) > 0;
  });
  const curtainMotion = await page.locator('.fx-curtain').evaluate(el => [...el.children].map(half => parseFloat(getComputedStyle(half).translate)));
  assert(curtainMotion[0] < 0 && curtainMotion[1] > 0);
  await page.screenshot({ path: path.join(output, 'curtain-opening.png') });
  await page.locator('.fx-scene-busy').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.fx-curtain').count(), 0);
  assert.equal(await page.locator('#guess').isEnabled(), true);
  pass('Original curtain art opens left/right once and releases controls after the first round enters');
  await page.locator('.guess-submit').click();
  assert.equal(await page.locator('#guess').getAttribute('aria-invalid'), 'true');
  assert.deepEqual((await saved()).attempts, []);
  assert.equal(await page.locator('.art-lives .spent').count(), 0);
  assert.equal((await audio()).length, 0);
  pass('Invalid input leaves attempts, lives and crowd audio unchanged');

  const q = await seed();
  await page.locator('[data-action=add][data-amount="10000"]').click();
  assert.equal(await page.locator('#guess').inputValue(), '10,000');
  const baseRect = await page.locator('.art-product').boundingBox();
  await submit(Math.round(q.answer * 1.05));
  await page.locator('#guess-form').evaluate(form => {
    for (let i = 0; i < 8; i++) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal((await saved()).rounds.length, 1);
  assert.equal((await saved()).rounds[0].score, 1000);
  assert.equal(await page.locator('.guess-submit').isDisabled(), true);
  const moving = await page.locator('.art-stage').evaluate(stage => ({
    crowd: [...stage.querySelectorAll('.art-audience, .art-judge-left, .art-judge-right')].filter(el => el.getAnimations().length).length,
    product: stage.querySelector('.art-product').getAnimations().length,
  }));
  assert.equal(moving.crowd, 9);
  assert.equal(moving.product, 0);
  assert.deepEqual(await page.locator('.art-product').boundingBox(), baseRect);
  await page.waitForFunction(() => [...document.querySelectorAll('.art-person-4, .art-judge-left, .art-judge-right')].length === 3 && [...document.querySelectorAll('.art-person-4, .art-judge-left, .art-judge-right')].every(el => parseFloat(getComputedStyle(el).translate.split(' ')[1]) < 0));
  const correctY = await page.locator('.art-person-4').evaluate(el => parseFloat(getComputedStyle(el).translate.split(' ')[1]));
  assert(correctY < 0);
  assert(await page.locator('.art-stage').evaluate(stage => [...stage.querySelectorAll('.art-judge-left, .art-judge-right')].every(el => parseFloat(getComputedStyle(el).translate.split(' ')[1]) < 0)));
  assert.equal(await page.evaluate(() => document.getAnimations().filter(animation => animation.id === 'ambient-idle').length), 0);
  await page.screenshot({ path: path.join(output, 'correct-reaction.png') });
  await page.locator('.art-reveal-earned strong').waitFor();
  assert.equal(await page.locator('.art-reveal-earned strong').textContent(), '+1,000점');
  await page.waitForFunction(() => document.querySelector('.art-reveal-total strong')?.textContent === '1,000점');
  assert.equal(await page.locator('.art-reveal-total strong').textContent(), '1,000점');
  assert.deepEqual((await audio()).map(x => Math.round(x.duration * 100)), [160]);
  assert.equal((await audio())[0].context, 'running');
  const upNotes = await page.evaluate(() => window.__answerNotes);
  assert.equal(upNotes.length, 4);
  assert(upNotes.every((note, i) => !i || note.frequency > upNotes[i - 1].frequency));
  const cheer = (await audio())[0];
  assert(cheer.stops.every(stop => stop.at >= cheer.at + 1.6 - .02));
  pass('Within ±10%: nine characters bounce, actual cheer plays once, score remains 1,000 under repeated Enter');

  await seed();
  await submit(1);
  await page.waitForFunction(() => [...document.querySelectorAll('.art-person-4, .art-judge-left, .art-judge-right')].length === 3 && [...document.querySelectorAll('.art-person-4, .art-judge-left, .art-judge-right')].every(el => parseFloat(getComputedStyle(el).translate.split(' ')[1]) > 0));
  const wrongY = await page.locator('.art-person-4').evaluate(el => parseFloat(getComputedStyle(el).translate.split(' ')[1]));
  assert(wrongY > 0);
  assert(await page.locator('.art-stage').evaluate(stage => [...stage.querySelectorAll('.art-judge-left, .art-judge-right')].every(el => parseFloat(getComputedStyle(el).translate.split(' ')[1]) > 0)));
  await page.screenshot({ path: path.join(output, 'wrong-reaction.png') });
  await settled();
  assert.equal(await page.locator('.art-lives .spent').count(), 1);
  assert.equal(await page.locator('.art-hint-word').textContent(), 'UP!');
  assert.equal(await page.locator('.art-reveal-screen').count(), 0);
  const downNotes = await page.evaluate(() => window.__answerNotes);
  assert.equal(downNotes.length, 3);
  assert(downNotes.every((note, i) => !i || note.frequency < downNotes[i - 1].frequency));
  assert.deepEqual((await audio())[0].stops, []);
  await submit(2);
  const interrupted = (await audio())[0].stops[0];
  assert(interrupted.scheduled - interrupted.at >= .11);
  await settled();
  await submit(3); await settled();
  assert.equal(await page.locator('.art-reveal-earned strong').textContent(), '0점');
  assert.equal((await saved()).rounds[0].score, 0);
  assert.deepEqual((await audio()).map(x => Math.round(x.duration * 100)), [220, 220, 220]);
  assert.equal(await page.locator('.fx-score-fly').count(), 0);
  pass('Every miss dips the crowd with boo audio; retries consume one heart; three misses reveal 0 with no cheer');
  pass('Correct/incorrect layer rising/falling bells; screen swaps keep the tail and a new guess fades the previous cue');

  await seed([1]);
  await submit(2);
  await settled();
  assert((await page.locator('.art-attempt > span:first-child').textContent()).includes('마지막 기회'));
  assert.equal(await page.locator('.art-lives img:not(.spent)').count(), 1);
  assert(await page.locator('.art-lives img:not(.spent)').evaluate(el => el.getAnimations().length > 0));
  await page.screenshot({ path: path.join(output, 'last-chance.png') });
  await page.reload();
  await page.locator('.art-title-menu > summary').click();
  await page.locator('.art-title-menu [data-action=resume]').click();
  assert.deepEqual((await saved()).attempts, [1, 2]);
  assert.equal(await page.locator('.art-lives img:not(.spent)').evaluate(el => el.getAnimations().length), 0);
  pass('Second miss emphasizes the final heart once; resume retains the last chance without replay');

  const transition = await seed();
  await submit(transition.answer);
  await page.locator('.art-reveal-screen').waitFor();
  assert(await page.locator('.art-reveal-prices .actual strong').evaluate(el => el.getAnimations().length > 0));
  await page.waitForFunction(() => document.querySelector('.art-reveal-total strong')?.textContent === '1,000점');
  pass('Reveal introduces the existing board/photo, highlights the real price and then settles the score');
  await page.locator('[data-action=next]').click();
  assert.equal((await saved()).index, 1);
  await page.locator('[data-action=next]').evaluate(button => {
    for (let i = 0; i < 8; i++) button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.locator('.art-stage[data-scene=round]').waitFor();
  const entering = await page.locator('.art-stage').evaluate(stage => ({
    disabled: stage.querySelector('#guess').disabled,
    product: stage.querySelector('.art-board-content').getAnimations().length,
    round: stage.querySelector('.art-round').getAnimations().length,
  }));
  assert(entering.disabled && entering.product > 0 && entering.round > 0);
  assert.equal(await page.locator('.fx-curtain').count(), 0);
  await page.screenshot({ path: path.join(output, 'round-entering.png') });
  await page.locator('.fx-scene-busy').waitFor({ state: 'detached' });
  assert.equal((await saved()).index, 1);
  assert.equal((await saved()).rounds.length, 1);
  assert.equal(await page.locator('#guess').isEnabled(), true);
  pass('Next fades out the answer and introduces one new round/product, even under repeated clicks');

  await page.reload();
  await page.locator('.art-title-start').click();
  const openingSession = await saved();
  await page.reload();
  await page.locator('.art-title-menu > summary').click();
  await page.locator('.art-title-menu [data-action=resume]').click();
  assert.deepEqual((await saved()).questionIds, openingSession.questionIds);
  assert.equal(await page.locator('.fx-curtain, .fx-scene-busy').count(), 0);
  assert.equal(await page.locator('#guess').isEnabled(), true);
  pass('Refresh during opening restores the same first question with no curtain replay or locked controls');

  const movingSession = await seed();
  await submit(movingSession.answer);
  await page.locator('.art-reveal-screen').waitFor();
  await page.locator('[data-action=next]').click();
  await page.reload();
  await page.locator('.art-title-menu > summary').click();
  await page.locator('.art-title-menu [data-action=resume]').click();
  assert.equal((await saved()).index, 1);
  assert.equal((await saved()).rounds.length, 1);
  assert.equal(await page.locator('.fx-curtain, .fx-scene-busy').count(), 0);
  assert.equal(await page.locator('#guess').isEnabled(), true);
  pass('Refresh during next-round transition restores the saved next question exactly once');

  for (const [attempts, score] of [[[1], 800], [[1, 2], 500]]) {
    const question = await seed(attempts);
    await submit(question.answer);
    await page.locator('.art-reveal-earned strong').waitFor();
    assert.equal((await saved()).rounds[0].score, score);
    await page.locator('[data-action=next]').click();
    assert.equal((await saved()).index, 1);
    assert.equal(await page.locator('.fx-score-fly').count(), 0);
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.art-score output').textContent(), score.toLocaleString('ko-KR'));
  }
  pass('Second/third try still award 800/500; immediate next cancels score effects without changing progress');

  const refresh = await seed();
  await submit(refresh.answer);
  await page.reload();
  await page.locator('.art-title-menu > summary').click();
  await page.locator('[data-action=resume]').last().click();
  await page.locator('.art-reveal-screen').waitFor();
  assert.equal(await page.locator('.art-reveal-total strong').textContent(), '1,000점');
  assert.equal(await page.locator('.fx-score-fly, .fx-reacting').count(), 0);
  assert.equal((await audio()).length, 0);
  pass('Refresh during reaction restores saved result with no repeated score or audio');

  await seed();
  await page.locator('.art-menu > summary').click();
  await page.locator('.art-menu [data-action=sound]').click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('nara-price-sound'))), false);
  await page.locator('.art-menu > summary').click();
  await submit(1);
  await settled();
  const muted = await saved();
  await submit(muted.questions[0].answer);
  await page.locator('.art-reveal-screen').waitFor();
  assert.equal((await audio()).length, 0);
  pass('Mute suppresses both reaction samples and persists across reload');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.locator('.art-title-start').click();
  const reduced = (await saved()).questions[0];
  assert.equal(await page.locator('.fx-curtain, .fx-scene-busy').count(), 0);
  assert.equal(await page.locator('#guess').isEnabled(), true);
  await submit(reduced.answer);
  assert.equal(await page.locator('.art-stage').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
  await page.locator('.art-reveal-screen').waitFor();
  assert.equal(await page.locator('.fx-score-fly').count(), 0);
  assert.equal(await page.locator('.art-reveal-total strong').textContent(), '1,000점');
  pass('Reduced motion skips curtain/entry delays and retains feedback and score without motion');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.reload();
  await page.locator('.art-title-start').click();
  await page.screenshot({ path: path.join(output, 'mobile-curtain.png') });
  const beforeRotation = (await saved()).questionIds;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#rotation-guide').waitFor({ state: 'visible' });
  await page.locator('.fx-scene-busy').waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => !document.querySelector('#app').inert);
  assert.deepEqual((await saved()).questionIds, beforeRotation);
  assert.equal(await page.locator('.fx-curtain').count(), 0);
  assert.equal(await page.locator('#guess').isEnabled(), true);
  pass('Rotation during opening preserves the session and returns to an unlocked landscape stage');
  await submit(1);
  await page.screenshot({ path: path.join(output, 'mobile-wrong-reaction.png') });
  await settled();
  const fits = await page.locator('.art-stage').evaluate(stage => {
    const rect = stage.getBoundingClientRect(), input = stage.querySelector('.art-price-bubble').getBoundingClientRect();
    return rect.width <= innerWidth && rect.height <= innerHeight && input.left >= rect.left && input.right <= rect.right;
  });
  assert(fits);
  await page.screenshot({ path: path.join(output, 'mobile-retry.png') });
  pass('Mobile landscape keeps the existing stage and controls within the viewport');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(`${checks.length} feedback checks passed`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
