// Both tracks are bundled locally. See assets/audio/CREDITS.txt.
export function createBackgroundMusic(getContext, enabled, getTrack = () => 'bossa') {
  const tracks = {
    bossa: { file: 'bgm-bossa.mp3', adjustment: .6917813, offset: 0 },
    wallpaper: { file: 'bgm-wallpaper.mp3', adjustment: .33892175462452356, offset: 0 },
  };
  let source, gain, playingTrack, startedAt = 0, duckUntil = 0;
  const volume = .16;
  function prepare(audio, adjustment) {
    const edge = Math.round(audio.sampleRate * .005);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const samples = audio.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) {
        const fade = Math.min(1, i / edge, (samples.length - i - 1) / edge);
        samples[i] *= adjustment * fade;
      }
    }
    return audio;
  }

  function stop(fade = 0) {
    if (!source) return;
    const context = getContext();
    playingTrack.offset = (playingTrack.offset + context.currentTime - startedAt) % playingTrack.buffer.duration;
    const endingSource = source, endingGain = gain;
    endingSource.onended = () => { endingSource.disconnect(); endingGain.disconnect(); };
    if (fade) {
      endingGain.gain.cancelAndHoldAtTime(context.currentTime);
      endingGain.gain.linearRampToValueAtTime(0, context.currentTime + fade);
    }
    endingSource.stop(context.currentTime + fade);
    source = null; gain = null; playingTrack = null;
  }

  function sync() {
    const context = getContext();
    if (!enabled() || document.hidden || !context || context.state !== 'running') { stop(); return; }
    const track = tracks[getTrack()] || tracks.bossa;
    if (source && playingTrack !== track) stop(.12);
    if (source) return;
    if (!track.buffer) {
      // A late download rechecks the current screen, mute and visibility.
      track.decoding ??= fetch(new URL(`./assets/audio/${track.file}`, import.meta.url))
        .then(response => { if (!response.ok) throw Error('BGM unavailable'); return response.arrayBuffer(); })
        .then(bytes => context.decodeAudioData(bytes)).then(audio => {
          track.buffer = prepare(audio, track.adjustment);
          sync();
        }).catch(() => {});
      return;
    }
    source = context.createBufferSource();
    gain = context.createGain();
    source.buffer = track.buffer;
    source.loop = true;
    gain.gain.setValueAtTime(0, context.currentTime);
    const ducked = duckUntil > context.currentTime;
    gain.gain.linearRampToValueAtTime(ducked ? volume * .22 : volume, context.currentTime + .35);
    if (ducked) {
      const holdUntil = Math.max(duckUntil, context.currentTime + .35);
      gain.gain.setValueAtTime(volume * .22, holdUntil);
      gain.gain.linearRampToValueAtTime(volume, holdUntil + .2);
    }
    source.connect(gain).connect(context.destination);
    startedAt = context.currentTime;
    playingTrack = track;
    source.start(0, track.offset);
  }

  function duck(duration) {
    const context = getContext();
    if (!context) return;
    const now = context.currentTime;
    duckUntil = Math.max(duckUntil, now + duration);
    if (!source) return;
    const level = gain.gain;
    level.cancelScheduledValues(now);
    level.setValueAtTime(Math.min(volume, level.value), now);
    level.linearRampToValueAtTime(volume * .22, now + .025);
    level.setValueAtTime(volume * .22, duckUntil);
    level.linearRampToValueAtTime(volume, duckUntil + .2);
  }
  return { sync, duck };
}
