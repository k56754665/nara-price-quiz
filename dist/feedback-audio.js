// Layer a soft crowd reaction with a recognizable ascending/descending bell cue.
// This graph owns its short tail independently of screen animation timers.
export function playAnswerFeedback(context, crowd, correct, onEnded = () => {}) {
  const now = context.currentTime;
  const output = context.createGain();
  const melody = context.createGain();
  const nodes = [output, melody], voices = [];
  let timer, closing = false, disposed = false;
  output.gain.setValueAtTime(0, now);
  output.gain.linearRampToValueAtTime(1, now + .012);
  output.connect(context.destination);
  melody.connect(output);
  // Two quiet, bounded reflections let the last bell ring out without a loop.
  for (const [seconds, level] of [[.12, .14], [.24, .055]]) {
    const delay = context.createDelay(.3), reflection = context.createGain();
    delay.delayTime.value = seconds; reflection.gain.value = level;
    melody.connect(delay).connect(reflection).connect(output);
    nodes.push(delay, reflection);
  }
  const wave = context.createPeriodicWave(new Float32Array(4), new Float32Array(correct ? [0, 1, .35, .1] : [0, 1, .16, .04]));
  const frequencies = correct ? [523.25, 659.25, 783.99, 1046.5] : [392, 329.63, 261.63];
  const interval = correct ? .10 : .18;
  let end = 0;
  frequencies.forEach((frequency, index) => {
    const voice = context.createOscillator(), envelope = context.createGain();
    const at = now + index * interval;
    const decay = index === frequencies.length - 1 ? .70 : correct ? .36 : .44;
    const level = (correct ? .28 : .25) * (1 - index * .08);
    voice.setPeriodicWave(wave); voice.frequency.value = frequency;
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(level, at + .012);
    envelope.gain.exponentialRampToValueAtTime(.001, at + decay);
    envelope.gain.linearRampToValueAtTime(0, at + decay + .04);
    voice.connect(envelope).connect(melody);
    voice.start(at); voice.stop(at + decay + .055);
    voices.push(voice); nodes.push(voice, envelope);
    end = index * interval + decay + .055 + .24;
  });
  if (crowd) {
    const voice = context.createBufferSource(), level = context.createGain();
    voice.buffer = crowd;
    // Keep the crowd behind the bells, then let it rise gently after the cue.
    const bed = correct ? .09 : .075;
    level.gain.setValueAtTime(bed, now);
    level.gain.setValueAtTime(bed, now + .65);
    level.gain.linearRampToValueAtTime(correct ? .18 : .14, now + 1.05);
    voice.connect(level).connect(output);
    voice.start(now + .12);
    voices.push(voice); nodes.push(voice, level);
    end = Math.max(end, crowd.duration + .12);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    for (const voice of voices) { try { voice.stop(); } catch {} }
    for (const node of nodes) node.disconnect();
    onEnded();
  }
  function stop(fade = .12) {
    if (closing || disposed) return;
    closing = true;
    const at = context.currentTime;
    output.gain.cancelScheduledValues(at);
    output.gain.setValueAtTime(output.gain.value, at);
    output.gain.linearRampToValueAtTime(0, at + fade);
    for (const voice of voices) { try { voice.stop(at + fade); } catch {} }
    clearTimeout(timer);
    timer = setTimeout(dispose, (fade + .04) * 1000);
  }
  timer = setTimeout(dispose, (end + .08) * 1000);
  return { stop, dispose, duration: end };
}

// A neutral glass shimmer marks the answer's appearance, even after three misses.
// It is deliberately shorter than the ascending/descending answer melodies.
export function playRevealFeedback(context, onEnded = () => {}) {
  const now = context.currentTime, duration = .68;
  const output = context.createGain(), nodes = [output], voices = [];
  let timer, closing = false, disposed = false;
  output.gain.setValueAtTime(1, now);
  output.connect(context.destination);
  for (const [frequency, delay, level, decay] of [[880, 0, .10, .52], [1320, .03, .04, .40], [1760, .055, .025, .31]]) {
    const voice = context.createOscillator(), envelope = context.createGain();
    const at = now + delay;
    voice.type = 'sine'; voice.frequency.value = frequency;
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(level, at + .012);
    envelope.gain.exponentialRampToValueAtTime(.0001, at + decay);
    envelope.gain.linearRampToValueAtTime(0, at + decay + .04);
    voice.connect(envelope).connect(output);
    voice.start(at); voice.stop(at + decay + .055);
    voices.push(voice); nodes.push(voice, envelope);
  }
  function dispose() {
    if (disposed) return;
    disposed = true; clearTimeout(timer);
    for (const voice of voices) { try { voice.stop(); } catch {} }
    for (const node of nodes) node.disconnect();
    onEnded();
  }
  function stop(fade = .12) {
    if (closing || disposed) return;
    closing = true;
    const at = context.currentTime;
    output.gain.cancelScheduledValues(at);
    output.gain.setValueAtTime(output.gain.value, at);
    output.gain.linearRampToValueAtTime(0, at + fade);
    for (const voice of voices) { try { voice.stop(at + fade); } catch {} }
    clearTimeout(timer);
    timer = setTimeout(dispose, (fade + .04) * 1000);
  }
  timer = setTimeout(dispose, (duration + .08) * 1000);
  return { stop, dispose, duration };
}
