// Presentation only. Session updates and scoring belong to app.js / engine.js.
import { createBackgroundMusic } from './music.js';
import { playAnswerFeedback, playRevealFeedback } from './feedback-audio.js';

export function createGameEffects(soundEnabled, musicEnabled = soundEnabled, musicTrack) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new Set();
  const sources = new Set();
  const clicks = new Set();
  const feedback = new Set();
  const cleanups = new Set();
  const timers = new Set();
  const idleAnimations = new Set();
  const particleGroups = new Set();
  let particleEpoch = 0;
  let lastAmountAt = -Infinity;
  let context, decoded, finishReaction, finishScene, finishAnnouncement, finishReward, counterFrame;
  const music = createBackgroundMusic(() => context, musicEnabled, musicTrack);
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
      const resume = context.resume().then(() => music.sync()).catch(() => {});
      decoded ??= samples.then(bytes => bytes && Promise.all(bytes.map(buffer => context.decodeAudioData(buffer)))).catch(() => null);
      return Promise.all([resume, decoded]).then(([, buffers]) => buffers);
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

  function clearParticles(preserveDialog = null) {
    particleEpoch++;
    for (const group of particleGroups) if (!preserveDialog?.contains(group.layer)) group.dispose();
  }

  function canShowParticles(stage = null) {
    const modal = document.querySelector('dialog[open]');
    return !reducedMotion.matches && !document.hidden && !document.querySelector('#app')?.inert && (!modal || stage?.closest('dialog') === modal) && !document.querySelector('.art-popover[open], .art-reveal-menu[open]');
  }

  function queueParticles(callback, delay) {
    if (!canShowParticles()) return;
    const epoch = particleEpoch;
    later(() => { if (epoch === particleEpoch) callback(); }, delay);
  }

  function particleLayer(stage, effect) {
    if (!stage?.isConnected || !canShowParticles(stage)) return;
    const rect = stage.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = `fx-particles${effect === 'confetti' ? ' fx-confetti' : ''}`;
    layer.dataset.effect = effect;
    layer.setAttribute('aria-hidden', 'true');
    stage.append(layer);
    const group = {
      layer, rect, compact: rect.width <= 900, scale: rect.width / 1280, animations: new Set(),
      dispose() {
        for (const animation of group.animations) animation.cancel();
        group.animations.clear();
        layer.remove();
        particleGroups.delete(group);
        cleanups.delete(group.dispose);
      },
    };
    particleGroups.add(group);
    cleanups.add(group.dispose);
    return group;
  }

  function particle(group, { x, y, size, color, shape = 'dot', height = shape === 'paper' ? size * 1.6 : size, frames, duration, delay = 0 }) {
    const count = [...particleGroups].reduce((sum, entry) => sum + entry.layer.childElementCount, 0);
    if (count >= (group.compact ? 24 : 48)) return;
    const piece = document.createElement('i');
    piece.className = `fx-particle fx-particle-${shape}`;
    piece.style.left = `${x}px`;
    piece.style.top = `${y}px`;
    piece.style.width = `${size}px`;
    piece.style.height = `${height}px`;
    piece.style.marginLeft = `${-size / 2}px`;
    piece.style.marginTop = `${-height / 2}px`;
    piece.style.color = color;
    group.layer.append(piece);
    const animation = animate(piece, frames, { duration, delay, fill: 'both', easing: 'linear' });
    group.animations.add(animation);
    const finish = () => {
      group.animations.delete(animation);
      piece.remove();
      if (!group.layer.childElementCount) group.dispose();
    };
    animation.finished.then(finish, finish);
  }

  function localRect(group, element) {
    const rect = element.getBoundingClientRect();
    return { left: rect.left - group.rect.left, right: rect.right - group.rect.left, top: rect.top - group.rect.top, bottom: rect.bottom - group.rect.top, width: rect.width, height: rect.height };
  }

  function correctParticles(stage) {
    const group = particleLayer(stage, 'correct');
    if (!group) return;
    const frame = localRect(group, stage.querySelector('.art-frame'));
    const count = group.compact ? 6 : 12;
    const y = frame.bottom - 32 * group.scale;
    for (let i = 0; i < count; i++) {
      const direction = i % 2 ? 1 : -1;
      const dx = direction * (52 + i % 6 * 16) * Math.max(.75, group.scale);
      const dy = -Math.min((58 + i % 5 * 20) * Math.max(.75, group.scale), y - group.rect.height * .39);
      particle(group, {
        x: direction < 0 ? frame.left + 8 * group.scale : frame.right - 8 * group.scale,
        y, size: Math.max(group.compact ? 18 : 22, (24 + i % 3 * 6) * group.scale),
        color: i % 3 ? '#fee500' : '#344eff', shape: i % 3 ? 'star' : 'dot', duration: 620 + i % 4 * 45,
        frames: [{ translate: '0 0', scale: '.65', opacity: 0 }, { translate: `${dx * .25}px ${dy * .6}px`, scale: '1.15', opacity: 1, offset: .22 }, { translate: `${dx * .72}px ${dy}px`, scale: '1', rotate: `${direction * 60}deg`, opacity: 1, offset: .7 }, { translate: `${dx}px ${dy * .8}px`, scale: '.65', rotate: `${direction * 100}deg`, opacity: 0 }],
      });
    }
  }

  function heartParticles(stage, heart) {
    if (!heart) return;
    const group = particleLayer(stage, 'heart');
    if (!group) return;
    const rect = localRect(group, heart);
    const y = rect.top + rect.height * .6;
    const count = group.compact ? 3 : 6;
    for (let i = 0; i < count; i++) {
      const dx = (i / (count - 1) - .5) * rect.width * .9;
      const dy = Math.min((32 + i % 3 * 9) * Math.max(.75, group.scale), Math.max(0, group.rect.height - y - 8));
      particle(group, {
        x: rect.left + rect.width / 2, y,
        size: Math.max(11, (12 + i % 2 * 4) * group.scale), color: i % 2 ? '#ff7699' : '#e92f53', duration: 440 + i % 3 * 50,
        frames: [{ translate: '0 0', scale: '.75', opacity: 0 }, { opacity: 1, scale: '1', offset: .18 }, { opacity: .95, offset: .6 }, { translate: `${dx}px ${dy}px`, scale: '.5', opacity: 0 }],
      });
    }
  }

  function priceParticles() {
    const stage = document.querySelector('.art-reveal-stage');
    const price = stage?.querySelector('.art-reveal-prices .actual strong');
    if (!price) return;
    const group = particleLayer(stage, 'price');
    if (!group) return;
    // Anchor to the printed amount, excluding unused space in the price column.
    const amount = document.createRange();
    amount.selectNodeContents(price);
    const rect = localRect(group, amount), gap = Math.max(18, 20 * group.scale) + rect.width * .035;
    // The photo sits close to the left edge; keep glints on the free right side.
    const points = [[rect.right + gap, rect.top + rect.height * .15], [rect.right + gap * 1.8, rect.top + rect.height * .35], [rect.right + gap, rect.bottom - rect.height * .15], [rect.right + gap * 1.6, rect.top - rect.height * .1]];
    points.slice(0, group.compact ? 3 : 4).forEach(([x, y], i) => particle(group, {
      x, y, size: Math.max(18, (26 + i % 2 * 8) * group.scale), color: '#34bfff', shape: 'star', duration: 480 + i % 2 * 60, delay: i * 20,
      frames: [{ scale: '.6', opacity: 0, rotate: '-15deg' }, { scale: '1.1', opacity: 1, rotate: '0deg', offset: .25 }, { scale: '1', opacity: 1, offset: .6 }, { scale: '.55', opacity: 0, rotate: '15deg' }],
    }));
  }

  function hintParticles() {
    const hint = document.querySelector('.art-hint');
    const direction = hint?.classList.contains('up') ? -1 : hint?.classList.contains('down') ? 1 : 0;
    if (!direction) return;
    const group = particleLayer(hint.closest('.art-stage'), 'hint');
    if (!group) return;
    group.layer.dataset.direction = direction < 0 ? 'up' : 'down';
    const rect = localRect(group, hint), gap = Math.max(10, 12 * group.scale);
    for (let i = 0; i < (group.compact ? 2 : 3); i++) particle(group, {
      x: rect.right + gap + i * Math.max(8, 9 * group.scale), y: rect.top + rect.height * .4,
      size: Math.max(3, 4 * group.scale), height: Math.max(14, 18 * group.scale), shape: 'streak',
      color: direction < 0 ? '#f44049' : '#344eff', duration: 240 + i * 15,
      frames: [{ translate: '0 0', opacity: 0 }, { opacity: 1, offset: .15 }, { translate: `0 ${direction * Math.max(16, 24 * group.scale)}px`, opacity: 0 }],
    });
  }

  function amountAdded(button) {
    const now = performance.now();
    if (now - lastAmountAt < 100) return;
    const group = particleLayer(button.closest('.art-stage'), 'amount');
    if (!group) return;
    lastAmountAt = now;
    const entry = localRect(group, group.layer.parentElement.querySelector('.art-price-entry'));
    const text = document.createRange();
    text.selectNodeContents(button);
    const caption = localRect(group, text);
    // Keep the burst in the gap above the plus row. A lower-edge fallback
    // would cover the minus labels when amount controls are only 24px tall.
    const size = Math.min(Math.max(8, 12 * group.scale), caption.top - entry.bottom - 6);
    if (size < 4) { group.dispose(); return; }
    const minimumY = entry.bottom + size / 2 + 3, maximumY = caption.top - size / 2 - 3;
    const y = maximumY;
    const rise = Math.max(0, Math.min(Math.max(8, 12 * group.scale), y - minimumY));
    for (let i = 0; i < 3; i++) particle(group, {
      x: rect.left + rect.width / 2, y, size, color: '#344eff', duration: 160 + i * 10,
      frames: [{ translate: '0 0', scale: '.6', opacity: 0 }, { scale: '1', opacity: 1, offset: .25 }, { translate: `${(i - 1) * Math.max(8, 12 * group.scale)}px ${-rise}px`, scale: '.6', opacity: 0 }],
    });
  }

  function rankingRegistered({ celebrate = true } = {}) {
    const stage = document.querySelector('#info-dialog[open] .art-ranking-stage');
    const best = stage?.querySelector('.art-ranking-best');
    if (!best) return;
    best.classList.add('fx-ranking-confirmed');
    cleanups.add(() => best.classList.remove('fx-ranking-confirmed'));
    if (!celebrate) return;
    const group = particleLayer(stage, 'registration');
    if (!group) return;
    const rect = localRect(group, best), gap = Math.max(10, 13 * group.scale);
    for (let i = 0; i < 4; i++) particle(group, {
      x: i % 2 ? rect.right + gap : rect.left - gap, y: rect.top + rect.height * (i < 2 ? .25 : .75),
      size: Math.max(12, 18 * group.scale), color: i % 2 ? '#34bfff' : '#344eff', shape: 'star', duration: 380, delay: 180 + i * 15,
      frames: [{ scale: '.55', opacity: 0 }, { scale: '1', opacity: 1, offset: .25 }, { scale: '.6', opacity: 0 }],
    });
  }

  function scorePath(earned, total) {
    const stage = earned.closest('.art-reveal-stage');
    const bounds = stage.getBoundingClientRect();
    const from = earned.getBoundingClientRect(), to = total.getBoundingClientRect();
    const start = { x: from.left + from.width / 2 - bounds.left, y: from.top + from.height / 2 - bounds.top };
    const end = { x: to.left + to.width / 2 - bounds.left, y: to.top + to.height / 2 - bounds.top };
    // Bend outward first, clearing the verdict before entering the actual score.
    const points = Array.from({ length: 9 }, (_, i) => {
      const t = i / 8;
      return { t, x: (end.x - start.x) * (1 - (1 - t) ** 3), y: (end.y - start.y) * (3 * t ** 2 - 2 * t ** 3) };
    });
    return { stage, start, end, points, targetWidth: to.width, targetHeight: to.height };
  }

  function scoreParticles(path, total, delay) {
    queueParticles(() => {
      const group = particleLayer(path.stage, 'score');
      if (!group) return;
      const count = group.compact ? 3 : 6;
      for (let i = 0; i < count; i++) {
        particle(group, {
          x: path.start.x, y: path.start.y,
          size: Math.max(10, (14 - i % 3 * 2) * group.scale), color: '#344eff', duration: 520 - i * 24, delay: i * 24,
          frames: path.points.map(({ t, x, y }) => ({ offset: t, translate: `${x}px ${y}px`, scale: `${1 - t * .35}`, opacity: t === 0 || t === 1 ? 0 : 1 })),
        });
      }
    }, delay);
    queueParticles(() => {
      const group = particleLayer(path.stage, 'score-arrival');
      if (!group) return;
      const current = localRect(group, total), padding = Math.max(6, 10 * group.scale);
      particle(group, {
        x: current.left + current.width / 2, y: current.top + current.height / 2,
        size: Math.max(path.targetWidth, current.width) + padding * 2, height: Math.max(path.targetHeight, current.height) + padding * 2,
        color: '#346eff', shape: 'ring', duration: 360,
        frames: [{ scale: '1', opacity: 0 }, { scale: '1.08', opacity: 1, offset: .25 }, { scale: '1.3', opacity: 0 }],
      });
    }, delay + 520);
  }

  function resultParticles(stage, perfect) {
    const group = particleLayer(stage, 'confetti');
    if (!group) return;
    const panel = localRect(group, stage.querySelector('.art-result-panel'));
    const count = (perfect ? 24 : 18) / (group.compact ? 2 : 1);
    for (let i = 0; i < count; i++) {
      const right = i % 2, direction = right ? -1 : 1;
      // Keep the celebration in the side gutters even when the story panel
      // widens on a phone. Its copy and controls must stay unobscured.
      const gutter = right ? group.rect.width - panel.right : panel.left;
      const inset = Math.min(group.rect.width * .07, gutter / 2);
      const x = right ? group.rect.width - inset : inset, y = group.rect.height * .5;
      const space = right ? x - panel.right : panel.left - x;
      const dx = direction * Math.max(0, space - Math.max(16, 16 * group.scale)) * (.3 + i % 5 * .14);
      const rise = group.rect.height * (.4 + i % 4 * .035), fall = group.rect.height * (.36 + i % 3 * .025);
      const frames = [0, .1, .3, .55, .8, 1].map(t => ({
        offset: t, translate: `${dx * t}px ${-rise * 4 * t * (1 - t) + fall * t * t}px`,
        rotate: `${direction * (40 + i * 19) * t}deg`, scale: `${1 - t * .25}`,
        opacity: t === 0 || t === 1 ? 0 : 1,
      }));
      particle(group, { x, y, size: Math.max(12, (14 + i % 3 * 4) * group.scale), color: ['#344eff', '#b800ff', '#fee500'][i % 3], shape: i % 4 ? 'paper' : 'dot', frames, duration: 700 + i % 3 * 30, delay: i % 4 * 18 });
    }
    return group;
  }

  function reset({ keepFeedback = false } = {}) {
    clearParticles();
    lastAmountAt = -Infinity;
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
    queueParticles(priceParticles, 120);
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
    if (correct) correctParticles(stage);
    else {
      const heart = stage.querySelectorAll('.art-lives img')[spentIndex];
      heartParticles(stage, heart);
      animate(heart, [
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
    hintParticles();
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
    const path = scorePath(earned, total);
    scoreParticles(path, total, delay);
    animate(earned, [{ scale: '.9' }, { scale: '1.1', offset: .6 }, { scale: '1' }], { duration: 280, delay });
    const fly = document.createElement('span');
    fly.className = 'fx-score-fly';
    fly.setAttribute('aria-hidden', 'true');
    fly.textContent = `+${score.toLocaleString('ko-KR')}`;
    fly.style.left = `${path.start.x}px`;
    fly.style.top = `${path.start.y}px`;
    path.stage.append(fly);
    const flight = animate(fly, path.points.map(({ t, x, y }) => ({
      offset: t, transform: `translate(${x}px, ${y}px) scale(${1 - t * .35})`, opacity: t === 0 || t === 1 ? 0 : 1,
    })), { duration: 520, delay, fill: 'both', easing: 'linear' });
    flight?.finished.then(() => fly.remove(), () => fly.remove());
    const text = total.firstChild;
    const finalValue = text.nodeValue;
    const finish = () => {
      cancelAnimationFrame(counterFrame);
      text.nodeValue = finalValue;
      fly.remove();
      cleanups.delete(finish);
      if (finishReward === finish) finishReward = null;
    };
    finishReward = finish;
    cleanups.add(finish);
    const began = performance.now() + delay;
    function count(now) {
      const progress = Math.max(0, Math.min(1, (now - began) / 520));
      text.nodeValue = Math.round(previousTotal + score * (1 - (1 - progress) ** 3)).toLocaleString('ko-KR');
      if (progress < 1) counterFrame = requestAnimationFrame(count);
      else finish();
    }
    text.nodeValue = previousTotal.toLocaleString('ko-KR');
    counterFrame = requestAnimationFrame(count);
    later(() => animate(target, [
      { transform: 'translateZ(0) scale(1)' },
      { transform: 'translateZ(0) scale(1.07)', offset: .4 },
      { transform: 'translateZ(0) scale(1)' },
    ], { duration: 260 }), delay + 520);
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
    const elements = document.querySelectorAll('.art-title-start .art-title-label, .art-stage .art-judge-left, .art-stage .art-judge-right, .art-result-character');
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
      confetti?.dispose();
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
        const progress = Math.max(0, Math.min(1, (now - began) / 650));
        output.textContent = `${Math.round(total * (1 - (1 - progress) ** 3)).toLocaleString('ko-KR')}점`;
        if (progress < 1) counterFrame = requestAnimationFrame(count);
        else output.textContent = finalText;
      }
      output.textContent = '0점';
      counterFrame = requestAnimationFrame(count);
      stage.querySelectorAll('.art-result-character').forEach((character, i) => {
        track(character, [{ translate: '0 0' }, { translate: '0 -10px', offset: .25 }, { translate: '0 0', offset: .5 }, { translate: '0 -5px', offset: .75 }, { translate: '0 0' }], { delay: 620 + i * 70, duration: 400, fill: 'backwards', easing: 'ease-in-out' });
      });
      if (special) queueParticles(() => {
        if (finished) return;
        confetti = resultParticles(stage, total === maxScore);
      }, 650);
    }
    later(() => { if (!finished) resultSound(special); }, reducedMotion.matches ? 0 : 620);
    later(() => { finish(); idle(); }, reducedMotion.matches ? 800 : 1500);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearParticles(); finishReward?.(); stopAudio(); stopIdle(); finishAnnouncement?.(); finishReaction?.(true); finishScene?.(true); }
    else { if (context) unlock(); idle(); }
    music.sync();
  });
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) { clearParticles(); finishReward?.(); finishAnnouncement?.(); finishScene?.(true); for (const animation of animations) animation.cancel(); }
    idle();
  });
  document.addEventListener('focusin', () => { if (document.activeElement?.matches('input, textarea')) stopIdle(); });
  document.addEventListener('focusout', () => requestAnimationFrame(idle));
  document.addEventListener('toggle', event => {
    if (event.target.matches?.('dialog')) clearParticles(event.target.open ? event.target : null);
    else if (event.target.open) clearParticles();
    idle();
  }, true);
  const overlayObserver = new MutationObserver(() => {
    const modal = document.querySelector('dialog[open]');
    if (document.querySelector('#app')?.inert || modal) { clearParticles(document.querySelector('#app')?.inert ? null : modal); finishReward?.(); }
    else for (const group of particleGroups) if (group.layer.closest('dialog')) group.dispose();
  });
  for (const element of document.querySelectorAll('#app, #info-dialog')) overlayObserver.observe(element, { attributes: true, attributeFilter: ['inert', 'open'] });
  window.addEventListener('resize', () => { clearParticles(); finishReward?.(); requestAnimationFrame(idle); });
  return { unlock, reset, react, retry, reveal, enterRound, exitReveal, announceResults, amountAdded, rankingRegistered, idle, syncMusic: music.sync, isSceneBusy: () => Boolean(finishScene), press, click: () => clickSound(), invalid, stopAudio };
}
