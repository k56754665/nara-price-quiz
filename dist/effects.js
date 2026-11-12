// Presentation only. Session updates and scoring belong to app.js / engine.js.
import { createBackgroundMusic } from './music.js';
import { playAnswerFeedback, playRevealFeedback } from './feedback-audio.js';

export function createGameEffects(soundEnabled, musicEnabled = soundEnabled) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new Set();
  const sources = new Set();
  const clicks = new Set();
  const feedback = new Set();
  const cleanups = new Set();
  const timers = new Set();
  const idleAnimations = new Set();
  let context, decoded, finishReaction, finishScene, finishAnnouncement, counterFrame;
  const music = createBackgroundMusic(() => context, musicEnabled);
  let audioEpoch = 0;
  const samples = Promise.all(['cheer', 'boo'].map(async name => {
    const response = await fetch(`./assets/audio/${name}.wav`);
    if (!response.ok) throw Error(`Missing ${name} sound`);
    return response.arrayBuffer();
  })).catch(() => null);

  function unlock() {
    if (!soundEnabled() && !musicEnabled()) return Promise.resolve(null);
    try {
      context ??= new (window.AudioContext || window.webkitAudioContext)();
      const resume = context.resume().catch(() => {});
      decoded ??= samples.then(bytes => bytes && Promise.all(bytes.map(buffer => context.decodeAudioData(buffer)))).catch(() => null);
      return Promise.all([resume, decoded]).then(([, buffers]) => { music.sync(); return buffers; });
    } catch { return Promise.resolve(null); }
  }

  function stopAudio(includeClicks = true, keepFeedback = false) {
    audioEpoch++;
    if (!keepFeedback) for (const sound of feedback) sound.stop();
    for (const source of sources) { try { source.stop(); } catch {} }
    sources.clear();
    if (includeClicks) {
      for (const source of clicks) { try { source.stop(); } catch {} }
      clicks.clear();
    }
  }

  function connect(source, gain, click = false) {
    source.connect(gain).connect(context.destination);
    const active = click ? clicks : sources;
    active.add(source);
    source.onended = () => { active.delete(source); source.disconnect(); gain.disconnect(); };
  }

  function reactionSound(correct) {
    const epoch = audioEpoch;
    unlock().then(buffers => {
      if (!context || !soundEnabled() || epoch !== audioEpoch || document.hidden) return;
      const sound = playAnswerFeedback(context, buffers?.[correct ? 0 : 1], correct, () => feedback.delete(sound));
      feedback.add(sound);
      music.duck(sound.duration);
    });
  }

  function clickSound(invalid = false) {
    if (!soundEnabled()) return;
    // Creation/resume happens synchronously within the player's gesture.
    unlock().then(() => {
      if (!context || context.state !== 'running' || !soundEnabled() || document.hidden) return;
      const source = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      source.type = 'sine';
      source.frequency.setValueAtTime(invalid ? 240 : 650, now);
      source.frequency.exponentialRampToValueAtTime(invalid ? 160 : 420, now + .065);
      gain.gain.setValueAtTime(.035, now);
      gain.gain.exponentialRampToValueAtTime(.001, now + .075);
      connect(source, gain, true);
      source.start();
      source.stop(now + .08);
    });
  }

  function revealSound() {
    if (!soundEnabled()) return;
    const epoch = audioEpoch;
    unlock().then(() => {
      if (!context || context.state !== 'running' || !soundEnabled() || epoch !== audioEpoch || document.hidden) return;
      const sound = playRevealFeedback(context, () => feedback.delete(sound));
      feedback.add(sound);
      music.duck(sound.duration);
    });
  }

  function animate(element, frames, options) {
    if (!element || reducedMotion.matches) return;
    const animation = element.animate(frames, { easing: 'ease-out', ...options });
    animations.add(animation);
    animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
    return animation;
  }

  function later(callback, delay) {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  }

  function reset({ keepFeedback = false } = {}) {
    stopIdle();
    finishAnnouncement?.();
    finishReaction?.(false);
    finishScene?.(false);
    finishReaction = null;
    for (const animation of animations) animation.cancel();
    animations.clear();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    cancelAnimationFrame(counterFrame);
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
    // A navigation click finishes its 80 ms sound across the screen swap.
    stopAudio(false, keepFeedback);
  }

  // Scene locks are transient. Cancelling restores controls and original art,
  // while app.js has already saved the valid destination session.
  function scene(stage, name, duration, setup) {
    if (!stage || reducedMotion.matches || document.hidden) return Promise.resolve(true);
    stopIdle();
    return new Promise(resolve => {
      const controls = [...stage.querySelectorAll('button, input')].map(element => [element, element.disabled]);
      controls.forEach(([element]) => { element.disabled = true; });
      stage.classList.add('fx-scene-busy');
      stage.dataset.scene = name;
      stage.setAttribute('aria-busy', 'true');
      const dispose = setup();
      let finished = false;
      const finish = completed => {
        if (finished) return;
        finished = true;
        finishScene = null;
        dispose();
        controls.forEach(([element, disabled]) => { element.disabled = disabled; });
        stage.classList.remove('fx-scene-busy');
        delete stage.dataset.scene;
        stage.removeAttribute('aria-busy');
        if (completed) idle();
        resolve(completed);
      };
      finishScene = finish;
      later(() => finish(true), duration);
    });
  }

  function enterRound({ curtain = false } = {}) {
    const stage = document.querySelector('.art-stage');
    const opening = curtain ? 760 : 0;
    return scene(stage, curtain ? 'opening' : 'round', opening + 350, () => {
      const current = [];
      let overlay;
      if (curtain) {
        overlay = document.createElement('div');
        overlay.className = 'fx-curtain';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML = '<span class="fx-curtain-half fx-curtain-left"></span><span class="fx-curtain-half fx-curtain-right"></span>';
        stage.append(overlay);
        for (const [side, direction] of [['left', -1], ['right', 1]]) {
          current.push(animate(overlay.querySelector(`.fx-curtain-${side}`), [
            { translate: '0 0', offset: 0 }, { translate: '0 0', offset: .1 }, { translate: `${direction * 102}% 0`, offset: 1 },
          ], { duration: opening, fill: 'both', easing: 'cubic-bezier(.55, 0, .25, 1)' }));
        }
      }
      current.push(animate(stage.querySelector('.art-round'), [
        { opacity: 0, scale: '.9' }, { opacity: 1, scale: '1.08', offset: .65 }, { opacity: 1, scale: '1' },
      ], { delay: opening, duration: 220, fill: 'both' }));
      current.push(animate(stage.querySelector('.art-board-content'), [
        { opacity: 0, translate: '0 8px' }, { opacity: 1, translate: '0 0' },
      ], { delay: opening + 90, duration: 260, fill: 'both' }));
      return () => { current.forEach(animation => animation?.cancel()); overlay?.remove(); };
    });
  }

  function exitReveal() {
    reset();
    return scene(document.querySelector('.art-reveal-stage'), 'leaving', 180, () => {
      const current = [...document.querySelectorAll('.art-reveal-board, .art-reveal-footer')].map(element => animate(element, [
        { opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 -8px' },
      ], { duration: 180, fill: 'both', easing: 'ease-in' }));
      return () => current.forEach(animation => animation?.cancel());
    });
  }

  function reveal(score, previousTotal) {
    // Match the actual-price highlight, after the crowd's initial reaction.
    later(revealSound, 120);
    animate(document.querySelector('.art-reveal-board'), [{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
    animate(document.querySelector('.art-reveal-photo'), [{ opacity: 0, translate: '0 8px' }, { opacity: 1, translate: '0 0' }], { duration: 260 });
    animate(document.querySelector('.art-reveal-prices .actual strong'), [
      { scale: '.97' }, { scale: '1.035', offset: .55 }, { scale: '1' },
    ], { delay: 120, duration: 360 });
    animate(document.querySelector('.art-reveal-footer'), [{ opacity: 0 }, { opacity: 1 }], { delay: 120, duration: 200, fill: 'backwards' });
    reward(score, previousTotal, 180);
  }

  function react({ correct, spentIndex, retry }) {
    reset();
    const stage = document.querySelector('.art-stage');
    if (!stage) return Promise.resolve(false);
    const duration = correct ? 920 : 720;
    const width = stage.getBoundingClientRect().width;
    stage.classList.add('fx-reacting');
    stage.dataset.reaction = correct ? 'correct' : 'wrong';
    stage.setAttribute('aria-busy', 'true');
    const controls = [...stage.querySelectorAll('button, input')].map(element => [element, element.disabled]);
    controls.forEach(([element]) => { element.disabled = true; });
    const submit = stage.querySelector('.guess-submit');
    const submitLabel = submit.textContent;
    submit.textContent = correct ? '정답!' : '아쉬워요';
    const status = document.createElement('span');
    status.className = 'fx-status';
    status.setAttribute('role', 'status');
    stage.append(status);
    status.textContent = correct ? '정답이에요!' : retry ? '아쉬워요! 한 번 더 도전해 보세요.' : '세 번의 기회를 모두 사용했어요. 정답을 공개합니다.';
    cleanups.add(() => {
      stage.classList.remove('fx-reacting');
      stage.removeAttribute('aria-busy');
      delete stage.dataset.reaction;
      controls.forEach(([element, disabled]) => { element.disabled = disabled; });
      submit.textContent = submitLabel;
      status.remove();
    });
    // Every character reacts together; the stage, product and controls stay still.
    stage.querySelectorAll('.art-audience, .art-judge-left, .art-judge-right').forEach(character => {
      const judge = !character.classList.contains('art-audience');
      const distance = width * (judge ? .008 : .014);
      const frames = correct
        ? [0, -distance, 0, -distance * .68, 0, -distance * .34, 0].map((y, i) => ({ translate: `0 ${y}px`, offset: i / 6 }))
        : [{ translate: '0 0', offset: 0 }, { translate: `0 ${distance * .65}px`, offset: .3 }, { translate: `0 ${distance * .65}px`, offset: .58 }, { translate: '0 0', offset: 1 }];
      animate(character, frames, { duration, easing: 'ease-in-out' });
    });
    if (!correct) {
      animate(stage.querySelectorAll('.art-lives img')[spentIndex], [
        { scale: '1', opacity: 1 }, { scale: '.7', opacity: .45, offset: .45 }, { scale: '1', opacity: .22 },
      ], { duration: Math.min(duration, 420), fill: 'forwards' });
    }
    reactionSound(correct);
    return new Promise(resolve => {
      finishReaction = completed => { finishReaction = null; resolve(completed); };
      later(() => finishReaction?.(true), duration);
    });
  }

  function retry({ lastChance = false } = {}) {
    animate(document.querySelector('.art-hint'), [
      { transform: 'translateZ(0) scale(.85)', opacity: .4 },
      { transform: 'translateZ(0) scale(1.05)', opacity: 1, offset: .7 },
      { transform: 'translateZ(0) scale(1)', opacity: 1 },
    ], { duration: 280 });
    animate(document.querySelector('.art-feedback'), [{ opacity: 0, translate: '0 5px' }, { opacity: 1, translate: '0 0' }], { duration: 240 });
    if (lastChance) {
      animate(document.querySelector('.art-lives img:not(.spent)'), [{ scale: '1' }, { scale: '1.16', offset: .45 }, { scale: '1' }], { duration: 480 });
      animate(document.querySelector('.art-attempt > span:first-child'), [{ opacity: .5 }, { opacity: 1 }], { duration: 420 });
    }
  }

  function reward(score, previousTotal, delay = 0) {
    if (!score || reducedMotion.matches) return;
    const earned = document.querySelector('.art-reveal-earned strong');
    const target = document.querySelector('.art-reveal-total');
    const total = target?.querySelector('strong');
    if (!earned || !total) return;
    animate(earned, [{ scale: '.9' }, { scale: '1.1', offset: .6 }, { scale: '1' }], { duration: 280, delay });
    const start = earned.getBoundingClientRect(), end = total.getBoundingClientRect();
    const fly = document.createElement('span');
    fly.className = 'fx-score-fly';
    fly.setAttribute('aria-hidden', 'true');
    fly.textContent = `+${score.toLocaleString('ko-KR')}`;
    fly.style.left = `${start.left + start.width / 2}px`;
    fly.style.top = `${start.top}px`;
    document.body.append(fly);
    cleanups.add(() => fly.remove());
    const flight = animate(fly, [
      { translate: '0 0', opacity: 0, scale: '.85' },
      { translate: '0 -12px', opacity: 1, scale: '1', offset: .2 },
      { translate: `${end.left + end.width / 2 - start.left - start.width / 2}px ${end.top - start.top}px`, opacity: 0, scale: '.55' },
    ], { duration: 520, delay, fill: 'both', easing: 'ease-in-out' });
    flight?.finished.then(() => fly.remove(), () => fly.remove());
    const text = total.firstChild;
    const finalValue = text.nodeValue;
    cleanups.add(() => { text.nodeValue = finalValue; });
    const began = performance.now() + delay;
    function count(now) {
      const progress = Math.max(0, Math.min(1, (now - began) / 520));
      text.nodeValue = Math.round(previousTotal + score * (1 - (1 - progress) ** 3)).toLocaleString('ko-KR');
      if (progress < 1) counterFrame = requestAnimationFrame(count);
      else text.nodeValue = finalValue;
    }
    text.nodeValue = previousTotal.toLocaleString('ko-KR');
    counterFrame = requestAnimationFrame(count);
    later(() => animate(target, [
      { transform: 'translateZ(0) scale(1)' },
      { transform: 'translateZ(0) scale(1.07)', offset: .4 },
      { transform: 'translateZ(0) scale(1)' },
    ], { duration: 260 }), delay + 440);
  }

  function press(button) {
    if (button.disabled || finishScene || document.querySelector('.fx-reacting')) return;
    animate(button, [{ scale: '.96' }, { scale: '1' }], { duration: 130 });
  }

  function invalid() {
    animate(document.querySelector('#guess'), [0, -5, 4, -3, 0].map(x => ({ translate: `${x}px 0` })), { duration: 230 });
    clickSound(true);
  }

  function stopIdle() {
    for (const animation of idleAnimations) animation.cancel();
    idleAnimations.clear();
  }

  function idle() {
    stopIdle();
    if (reducedMotion.matches || document.hidden || document.querySelector('#app')?.inert || finishScene || finishReaction || document.querySelector('.art-result-stage[data-announcing], dialog[open], .art-popover[open], .art-reveal-menu[open]') || document.activeElement?.matches('input, textarea')) return;
    const elements = document.querySelectorAll('.art-title-start .art-title-label, .art-stage .art-judge-left, .art-stage .art-judge-right, .art-result-bird, .art-result-backpack, .art-result-wave');
    elements.forEach((element, i) => {
      const title = Boolean(element.closest('.art-title-start'));
      const frames = title
        ? [{ scale: '1' }, { scale: '1.015', offset: .5 }, { scale: '1' }]
        : [{ translate: '0 0', rotate: '0deg' }, { translate: '0 -2px', rotate: '.4deg', offset: .5 }, { translate: '0 0', rotate: '0deg' }];
      const animation = animate(element, frames, { duration: 5200 + i * 650, iterations: Infinity, easing: 'ease-in-out' });
      if (animation) { animation.id = 'ambient-idle'; idleAnimations.add(animation); }
    });
  }

  function resultSound(special) {
    if (!soundEnabled()) return;
    const epoch = audioEpoch;
    unlock().then(() => {
      if (!context || !soundEnabled() || epoch !== audioEpoch || document.hidden) return;
      music.duck(.8);
      const notes = special ? [523.25, 659.25, 783.99, 1046.5] : [523.25, 659.25];
      notes.forEach((frequency, i) => {
        const source = context.createOscillator(), gain = context.createGain();
        const at = context.currentTime + i * .13;
        source.type = 'triangle';
        source.frequency.value = frequency;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(special ? .065 : .035, at + .015);
        gain.gain.exponentialRampToValueAtTime(.001, at + .32);
        connect(source, gain);
        source.start(at); source.stop(at + .34);
      });
    });
  }

  function announceResults({ total, maxScore, newBest }) {
    const stage = document.querySelector('.art-result-stage');
    if (!stage) return;
    const output = stage.querySelector('.art-result-score');
    const finalText = output.textContent, special = newBest || total === maxScore;
    stopIdle();
    stage.dataset.announcing = 'true';
    const current = [];
    let finished = false, confetti;
    const finish = () => {
      if (finished) return;
      finished = true; finishAnnouncement = null;
      cancelAnimationFrame(counterFrame);
      output.textContent = finalText;
      delete stage.dataset.announcing;
      confetti?.remove();
      current.forEach(animation => animation?.cancel());
      cleanups.delete(finish);
    };
    finishAnnouncement = finish;
    cleanups.add(finish);
    const track = (element, frames, options) => current.push(animate(element, frames, options));
    if (!reducedMotion.matches && !document.hidden) {
      track(stage.querySelector('.art-result-panel'), [{ opacity: 0, scale: '.97' }, { opacity: 1, scale: '1' }], { duration: 280 });
      track(stage.querySelector('.art-result-identity'), [{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }], { delay: 560, duration: 220, fill: 'backwards' });
      const began = performance.now();
      function count(now) {
        const progress = Math.min(1, (now - began) / 650);
        output.textContent = `${Math.round(total * (1 - (1 - progress) ** 3)).toLocaleString('ko-KR')}점`;
        if (progress < 1) counterFrame = requestAnimationFrame(count);
        else output.textContent = finalText;
      }
      output.textContent = '0점';
      counterFrame = requestAnimationFrame(count);
      stage.querySelectorAll('.art-result-bird, .art-result-backpack, .art-result-wave').forEach((character, i) => {
        track(character, [{ translate: '0 0' }, { translate: '0 -10px', offset: .25 }, { translate: '0 0', offset: .5 }, { translate: '0 -5px', offset: .75 }, { translate: '0 0' }], { delay: 620 + i * 70, duration: 400, fill: 'backwards', easing: 'ease-in-out' });
      });
      if (special) later(() => {
        if (finished) return;
        confetti = document.createElement('div');
        confetti.className = 'fx-confetti';
        confetti.setAttribute('aria-hidden', 'true');
        stage.append(confetti);
        for (let i = 0; i < 18; i++) {
          const piece = document.createElement('i');
          piece.style.left = `${i % 2 ? 74 + (i % 9) * 2.5 : 4 + (i % 9) * 2.5}%`;
          piece.style.background = ['#344eff', '#b800ff', '#fee500'][i % 3];
          confetti.append(piece);
          track(piece, [{ translate: '0 -12px', rotate: '0deg', opacity: 0 }, { opacity: .9, offset: .1 }, { translate: `${i % 2 ? -14 : 14}px ${stage.clientHeight * .8}px`, rotate: `${150 + i * 17}deg`, opacity: 0 }], { delay: i % 4 * 25, duration: 700, fill: 'both' });
        }
      }, 650);
    }
    later(() => { if (!finished) resultSound(special); }, reducedMotion.matches ? 0 : 620);
    later(() => { finish(); idle(); }, reducedMotion.matches ? 800 : 1500);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopAudio(); stopIdle(); finishAnnouncement?.(); finishReaction?.(true); finishScene?.(true); }
    else { if (context) unlock(); idle(); }
    music.sync();
  });
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) { finishAnnouncement?.(); finishScene?.(true); for (const animation of animations) animation.cancel(); }
    idle();
  });
  document.addEventListener('focusin', () => { if (document.activeElement?.matches('input, textarea')) stopIdle(); });
  document.addEventListener('focusout', () => requestAnimationFrame(idle));
  document.addEventListener('toggle', () => idle(), true);
  window.addEventListener('resize', () => requestAnimationFrame(idle));
  return { unlock, reset, react, retry, reveal, enterRound, exitReveal, announceResults, idle, syncMusic: music.sync, isSceneBusy: () => Boolean(finishScene), press, click: () => clickSound(), invalid, stopAudio };
}
