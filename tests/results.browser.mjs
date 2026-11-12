// Real browser coverage for result announcements, idle motion and independent audio.
// Network writes, native sharing and clipboard writes never leave this test context.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, scoreRound } from '../dist/engine.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(project, '.artifacts/results-effects');
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: true });
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await context.addInitScript(() => {
    window.__buffers = []; window.__tones = []; window.__ramps = [];
    const createSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = createSource.call(this), start = source.start, stop = source.stop;
      let event;
      source.start = function (...args) {
        const samples = this.buffer.getChannelData(0);
        event = { loop: this.loop, active: true, offset: args[1] || 0, duration: this.buffer.duration, channels: this.buffer.numberOfChannels, energy: samples.slice(0, 2048).reduce((sum, n) => sum + Math.abs(n), 0) / 2048 };
        window.__buffers.push(event);
        return start.apply(this, args);
      };
      source.stop = function (...args) { if (event) event.active = false; return stop.apply(this, args); };
      return source;
    };
    const createTone = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const source = createTone.call(this), start = source.start;
      source.start = function (...args) { window.__tones.push(this.type); return start.apply(this, args); };
      return source;
    };
    const ramp = AudioParam.prototype.linearRampToValueAtTime;
    AudioParam.prototype.linearRampToValueAtTime = function (value, when) { window.__ramps.push(value); return ramp.call(this, value, when); };
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text; } } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const saved = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
  const activeMusic = () => page.evaluate(() => window.__buffers.filter(event => event.loop && event.active).length);
  const fanfare = () => page.evaluate(() => window.__tones.filter(type => type === 'triangle').length);
  const idleCount = () => page.evaluate(() => document.getAnimations().filter(animation => animation.id === 'ambient-idle').length);
  async function menu(action) {
    const details = page.locator('details').filter({ has: page.locator('nav.art-menu-content') });
    if (!await details.evaluate(el => el.open)) await details.locator('summary').click();
    await details.locator(`[data-action="${action}"]`).click();
  }
  async function seedFinish(kind, previousBest) {
    const session = createSession(bank, trivia, true, () => .25);
    const attempts = kind === 'perfect' ? Array(10).fill(1) : kind === 'zero' ? Array(10).fill(0) : [1, 2, 3, 0, 1, 1, 1, 1, 1, 1];
    session.index = 9; session.phase = 'reveal';
    session.rounds = session.questions.map((q, index) => {
      const guesses = attempts[index] ? [...Array(attempts[index] - 1).fill(1), q.answer] : [1, 2, 3];
      return { candidateId: q.id, attempts: guesses, score: scoreRound(guesses, q.answer) };
    });
    await page.evaluate(({ key, session, previousBest }) => {
      localStorage.setItem(key, JSON.stringify(session));
      localStorage.setItem('nara-price-best-v3', JSON.stringify(previousBest));
      localStorage.setItem('nara-price-sound', 'true');
      localStorage.setItem('nara-price-music', 'true');
    }, { key, session, previousBest });
    await page.reload();
    await menu('resume');
    await page.locator('.art-reveal-stage').waitFor();
    await page.waitForFunction(() => window.__buffers.some(event => event.loop && event.active));
    await page.locator('[data-action=next]').click();
    await page.locator('.art-result-stage[data-announcing]').waitFor();
  }
  async function settled() { await page.locator('.art-result-stage[data-announcing]').waitFor({ state: 'detached' }); }
  await page.goto(origin);
  await page.locator('.art-title-stage').waitFor();
  await page.waitForFunction(() => document.getAnimations().some(animation => animation.id === 'ambient-idle'));
  assert.equal((await page.evaluate(() => window.__buffers)).length, 0);
  assert.equal(await idleCount(), 1);
  pass('Title idles with a fixed hit target; BGM waits for a user gesture');

  await seedFinish('mixed', 9000);
  assert.equal((await saved()).phase, 'results');
  assert.equal(await page.locator('.art-result-score').getAttribute('aria-label'), '최종 점수 8,300점');
  await page.locator('.art-result-share').click();
  assert((await page.evaluate(() => window.__copied)).includes('8,300'));
  await settled();
  assert.equal(await page.locator('.art-result-score').textContent(), '8,300점');
  assert.equal(await page.locator('.fx-result-honor, .fx-confetti').count(), 0);
  assert.equal(await fanfare(), 2);
  assert.equal(await idleCount(), 3);
  assert.equal(await activeMusic(), 1);
  assert.equal(await page.evaluate(() => window.__buffers.filter(event => event.loop).length), 1);
  assert(await page.evaluate(() => window.__buffers.find(event => event.loop).energy > .01));
  assert(await page.evaluate(() => { const music = window.__buffers.find(event => event.loop); return music.channels === 2 && Math.abs(music.duration - 27.042) < .02; }));
  assert(await page.evaluate(() => window.__ramps.some(value => Math.abs(value - .16 * .22) < .00001)));
  await page.screenshot({ path: path.join(output, 'result-normal.png') });
  pass('Normal result counts to 8,300, shares the real total during counting and keeps one non-silent ducked BGM loop');

  await menu('about');
  assert.equal(await idleCount(), 0);
  await page.locator('#info-dialog [data-action=close-dialog]').click();
  await page.waitForFunction(() => document.getAnimations().filter(animation => animation.id === 'ambient-idle').length === 3);
  pass('Idle motion pauses for reading a dialog and resumes after closing');

  await menu('music');
  assert.equal(await activeMusic(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('nara-price-sound')), 'true');
  await menu('sound');
  await menu('music');
  await page.waitForFunction(() => window.__buffers.some(event => event.loop && event.active));
  assert.equal(await activeMusic(), 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('nara-price-sound')), 'false');
  await page.reload();
  assert.equal(await activeMusic(), 0);
  await menu('resume');
  await page.waitForFunction(() => window.__buffers.some(event => event.loop && event.active));
  assert.equal(await page.locator('.art-result-score').textContent(), '8,300점');
  assert.equal(await page.locator('.fx-confetti, [data-announcing]').count(), 0);
  assert.equal(await fanfare(), 0);
  pass('BGM and effects mute independently, persist on reload and do not repeat the result announcement');

  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await activeMusic(), 0);
  assert.equal(await idleCount(), 0);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => window.__buffers.some(event => event.loop && event.active));
  assert.equal(await activeMusic(), 1);
  assert(await page.evaluate(() => window.__buffers.filter(event => event.loop).at(-1).offset > 0));
  pass('Visibility changes stop BGM/idle and resume one music loop from its saved position');

  await seedFinish('mixed', 1000);
  await page.locator('.fx-confetti').waitFor();
  assert.equal(await page.locator('.fx-confetti i').count(), 18);
  assert.equal(await page.locator('.fx-result-honor').textContent(), '이 기기 최고 기록!');
  assert.equal((await saved()).newBest, true);
  await page.screenshot({ path: path.join(output, 'result-new-best.png') });
  await settled();
  assert.equal(await fanfare(), 4);
  assert.equal(await page.locator('.fx-confetti').count(), 0);
  pass('Strictly improved device record gets one fanfare, restrained confetti and the correct record label');

  for (const [kind, best, total] of [['mixed', 8300, 8300], ['zero', 0, 0]]) {
    await seedFinish(kind, best); await settled();
    assert.equal((await saved()).newBest, false);
    assert.equal(await page.locator('.fx-result-honor, .fx-confetti').count(), 0);
    assert.equal(await fanfare(), 2);
    assert.equal(await page.locator('.art-result-score').textContent(), `${total.toLocaleString('ko-KR')}점`);
  }
  pass('A tied record and 0 points never claim a new best or trigger celebration');

  for (const best of [10000, 0]) {
    await seedFinish('perfect', best);
    await page.locator('.fx-confetti').waitFor();
    assert.equal(await page.locator('.fx-result-honor').textContent(), '10,000점 만점!');
    await settled();
    assert.equal(await fanfare(), 4);
    assert.equal(await page.locator('.art-result-score').textContent(), '10,000점');
  }
  await page.screenshot({ path: path.join(output, 'result-perfect.png') });
  pass('Perfect score celebrates even when tied; perfect plus new best still plays only one fanfare');

  await seedFinish('mixed', 1000);
  await page.reload();
  await menu('resume');
  assert.equal(await page.locator('.art-result-score').textContent(), '8,300점');
  assert.equal(await page.locator('.fx-result-honor').textContent(), '이 기기 최고 기록!');
  assert.equal((await saved()).rounds.length, 10);
  await page.waitForTimeout(850);
  assert.equal(await fanfare(), 0);
  assert.equal(await page.locator('.fx-confetti, [data-announcing]').count(), 0);
  pass('Reload during announcement restores the final result without replaying counting, confetti or fanfare');

  await seedFinish('mixed', 1000);
  await page.locator('[data-action=replay]').click();
  await page.locator('.fx-scene-busy').waitFor({ state: 'detached' });
  assert.equal((await saved()).rounds.length, 0);
  assert.equal((await saved()).index, 0);
  assert.equal(await page.locator('.fx-confetti, [data-announcing]').count(), 0);
  assert.equal(await fanfare(), 0);
  assert.equal(await activeMusic(), 1);
  await page.locator('#guess').focus();
  assert.equal(await idleCount(), 0);
  pass('Immediate replay cancels pending result audio/particles and input focus pauses ambient motion');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedFinish('perfect', 0);
  assert.equal(await page.locator('.art-result-score').textContent(), '10,000점');
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  assert.equal(await page.locator('.fx-confetti').count(), 0);
  await settled();
  assert.equal(await fanfare(), 4);
  pass('Reduced motion shows final score/honor immediately with no count animation, bounce, confetti or idle');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 844, height: 390 });
  await seedFinish('perfect', 0); await settled();
  const fits = await page.locator('.art-result-panel').evaluate(panel => {
    const p = panel.getBoundingClientRect(), actions = panel.querySelector('.art-result-actions').getBoundingClientRect();
    return p.left >= 0 && p.right <= innerWidth && actions.bottom <= innerHeight && panel.scrollWidth <= panel.clientWidth;
  });
  assert(fits);
  await page.screenshot({ path: path.join(output, 'result-perfect-mobile.png') });
  pass('Mobile landscape retains the supplied result panel, honor and reachable share/replay actions');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(`${checks.length} result/music checks passed`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
