// Selected C: Short Elevator Music Loop by BlondPanda (CC0), bundled locally.
export function createBackgroundMusic(getContext, enabled) {
  let buffer, decoding, source, gain, startedAt = 0, offset = 0;
  const volume = .16;
  const bytes = fetch(new URL('./assets/audio/bgm-bossa.mp3', import.meta.url))
    .then(response => { if (!response.ok) throw Error('BGM unavailable'); return response.arrayBuffer(); })
    .catch(() => null);
  function prepare(audio) {
    const edge = Math.round(audio.sampleRate * .005);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const samples = audio.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) {
        const fade = Math.min(1, i / edge, (samples.length - i - 1) / edge);
        samples[i] *= .6917813 * fade;
      }
    }
    return audio;
  }

  function stop() {
    if (!source) return;
    const context = getContext();
    offset = (offset + context.currentTime - startedAt) % buffer.duration;
    source.stop(); source.disconnect(); gain.disconnect();
    source = null; gain = null;
  }

  function sync() {
    const context = getContext();
    if (!enabled() || document.hidden || !context || context.state !== 'running') { stop(); return; }
    if (source) return;
    if (!buffer) {
      // Recheck settings after decoding so a late load cannot unmute the game.
      decoding ??= bytes.then(data => data && context.decodeAudioData(data)).then(audio => {
        if (audio) { buffer = prepare(audio); sync(); }
      }).catch(() => {});
      return;
    }
    source = context.createBufferSource();
    gain = context.createGain();
    source.buffer = buffer;
    source.loop = true;
    gain.gain.setValueAtTime(0, context.currentTime);
    gain.gain.linearRampToValueAtTime(volume, context.currentTime + .35);
    source.connect(gain).connect(context.destination);
    startedAt = context.currentTime;
    source.start(0, offset);
  }

  function duck(duration) {
    if (!source) return;
    const now = getContext().currentTime, level = gain.gain;
    level.cancelScheduledValues(now);
    level.setValueAtTime(Math.min(volume, level.value), now);
    level.linearRampToValueAtTime(volume * .22, now + .025);
    level.setValueAtTime(volume * .22, now + duration);
    level.linearRampToValueAtTime(volume, now + duration + .2);
  }
  return { sync, duck };
}
