// Render the shipped graph with native OfflineAudioContext for waveform QA and auditions.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(project, '.artifacts/feedback-audio');
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
const root = path.join(project, 'dist');
const server = http.createServer(async (request, response) => {
  if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Audio audit</title>'); return; }
  try {
    const file = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    assert(file.startsWith(root + path.sep));
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'audio/wav' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const checks = [];
function pass(text) { checks.push(text); console.log('PASS ' + text); }
try {
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.UI_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (const correct of [true, false]) {
    const report = await page.evaluate(async correct => {
      const { playAnswerFeedback } = await import('./feedback-audio.js');
      const rate = 22050;
      const bytes = await (await fetch(`./assets/audio/${correct ? 'cheer' : 'boo'}.wav`)).arrayBuffer();
      const decoder = new OfflineAudioContext(1, 1, rate);
      const crowd = await decoder.decodeAudioData(bytes);
      function rms(samples, from, to) {
        const first = Math.floor(from * rate), last = Math.min(samples.length, Math.floor(to * rate));
        let sum = 0;
        for (let i = first; i < last; i++) sum += samples[i] ** 2;
        return Math.sqrt(sum / Math.max(1, last - first));
      }
      const raw = crowd.getChannelData(0);
      const renderDuration = Math.max(2.2, crowd.duration + .5);
      const context = new OfflineAudioContext(1, Math.round(renderDuration * rate), rate);
      const notes = [], create = context.createOscillator.bind(context);
      context.createOscillator = () => {
        const oscillator = create(), start = oscillator.start.bind(oscillator);
        oscillator.start = at => { notes.push({ frequency: oscillator.frequency.value, at }); start(at); };
        return oscillator;
      };
      const graph = playAnswerFeedback(context, crowd, correct);
      const rendered = await context.startRendering();
      graph.dispose();
      const samples = rendered.getChannelData(0);
      // Subtract an identical bell-only render to measure masking in the actual mix.
      const bellContext = new OfflineAudioContext(1, Math.round(renderDuration * rate), rate);
      const bells = playAnswerFeedback(bellContext, null, correct);
      const bellSamples = (await bellContext.startRendering()).getChannelData(0);
      bells.dispose();
      const crowdSamples = Float32Array.from(samples, (sample, i) => sample - bellSamples[i]);
      const noteBalance = notes.slice(1).map(note => ({
        bell: rms(bellSamples, note.at + .025, note.at + .085),
        crowd: rms(crowdSamples, note.at + .025, note.at + .085),
      }));
      let peak = 0;
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
      const wav = new ArrayBuffer(44 + samples.length * 2), view = new DataView(wav);
      const ascii = (at, text) => [...text].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
      ascii(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); ascii(8, 'WAVE');
      ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
      for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
      let binary = '';
      new Uint8Array(wav).forEach(value => { binary += String.fromCharCode(value); });
      return {
        notes, peak, wav: btoa(binary), duration: crowd.duration,
        crowdStart: rms(raw, 0, .025), crowdBody: rms(raw, .2, .7), crowdEnd: rms(raw, crowd.duration - .05, crowd.duration),
        mixedBody: rms(samples, .2, .7), mixedTail: rms(samples, crowd.duration - .15, crowd.duration + .12), silenceAfter: rms(samples, crowd.duration + .2, renderDuration),
        bellBody: rms(bellSamples, .15, .65), crowdBed: rms(crowdSamples, .15, .65), noteBalance,
      };
    }, correct);
    assert.equal(report.notes.length, correct ? 4 : 3);
    assert(report.notes.every((note, i, notes) => !i || (correct ? note.frequency > notes[i - 1].frequency : note.frequency < notes[i - 1].frequency)));
    assert(report.notes.every((note, i, notes) => !i || note.at - notes[i - 1].at >= .07));
    assert(report.crowdStart < report.crowdBody * .2);
    assert(report.crowdEnd < report.crowdBody * .08);
    assert(report.peak > .05 && report.peak < .9);
    assert(report.mixedTail < report.mixedBody);
    assert(report.silenceAfter < .00001);
    assert(report.bellBody >= report.crowdBed * 2, 'Bells must stay at least 6 dB above the crowd during the cue');
    assert(report.noteBalance.every(note => note.bell >= note.crowd * 3), 'Each overlapping bell attack must stay clearly above the crowd');
    await writeFile(path.join(output, correct ? 'correct-feedback.wav' : 'wrong-feedback.wav'), Buffer.from(report.wav, 'base64'));
    delete report.wav;
    await writeFile(path.join(output, correct ? 'correct-analysis.json' : 'wrong-analysis.json'), JSON.stringify(report, null, 2));
    pass(`${correct ? 'Correct' : 'Incorrect'}: foreground bells exceed crowd bed, with ordered notes, soft fades and no clipping`);
  }
  const interrupted = await page.evaluate(async () => {
    const { playAnswerFeedback } = await import('./feedback-audio.js');
    const rate = 22050, context = new OfflineAudioContext(1, rate * 2, rate);
    const bytes = await (await fetch('./assets/audio/cheer.wav')).arrayBuffer();
    const crowd = await context.decodeAudioData(bytes);
    const graph = playAnswerFeedback(context, crowd, true);
    const pause = context.suspend(.65), rendering = context.startRendering();
    await pause;
    graph.stop();
    await context.resume();
    const samples = (await rendering).getChannelData(0);
    graph.dispose();
    return [...samples.slice(Math.floor(.86 * rate))].every(value => Math.abs(value) < .00001);
  });
  assert(interrupted);
  pass('Interrupting feedback fades to silence without leaving a delayed echo');
  const reveal = await page.evaluate(async () => {
    const { playRevealFeedback } = await import('./feedback-audio.js');
    const rate = 22050, context = new OfflineAudioContext(1, rate, rate);
    const graph = playRevealFeedback(context);
    const samples = (await context.startRendering()).getChannelData(0);
    graph.dispose();
    const rms = (from, to) => Math.sqrt(samples.slice(Math.floor(from * rate), Math.floor(to * rate)).reduce((sum, value) => sum + value * value, 0) / Math.round((to - from) * rate));
    const wav = new ArrayBuffer(44 + samples.length * 2), view = new DataView(wav);
    const ascii = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
    samples.forEach((value, i) => view.setInt16(44 + i * 2, Math.round(value * 32767), true));
    let binary = '';
    new Uint8Array(wav).forEach(value => binary += String.fromCharCode(value));
    return { peak: samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0), attack: rms(0, .002), body: rms(.015, .12), tail: rms(.4, .55), after: rms(.68, 1), wav: btoa(binary) };
  });
  assert(reveal.peak > .04 && reveal.peak < .5);
  assert(reveal.attack < reveal.body * .3);
  assert(reveal.tail > 0 && reveal.tail < reveal.body * .1);
  assert(reveal.after < .00001);
  await writeFile(path.join(output, 'reveal-feedback.wav'), Buffer.from(reveal.wav, 'base64'));
  pass('Reveal shimmer has a soft attack, audible body, natural release and silence afterward without clipping');
  const revealInterrupted = await page.evaluate(async () => {
    const { playRevealFeedback } = await import('./feedback-audio.js');
    const rate = 22050, context = new OfflineAudioContext(1, rate, rate);
    const graph = playRevealFeedback(context);
    const pause = context.suspend(.08), rendering = context.startRendering();
    await pause; graph.stop(); await context.resume();
    const samples = (await rendering).getChannelData(0);
    graph.dispose();
    return [...samples.slice(Math.floor(.25 * rate))].every(value => Math.abs(value) < .00001);
  });
  assert(revealInterrupted);
  pass('Interrupting the reveal accent fades to silence without a remaining voice');
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
