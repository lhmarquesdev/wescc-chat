// Sons da chamada gerados com WebAudio (sem arquivo de som): toque, chamando, entrada, saída e mão levantada.

let ringTimer: number | null = null;
let audioCtx: AudioContext | null = null;

function tone(freqs: number[], ms: number, gain = 0.06, at = 0) {
  try {
    audioCtx ??= new AudioContext();
    const g = audioCtx.createGain();
    const t0 = audioCtx.currentTime + at;
    g.gain.value = gain;
    // Fim suave: um corte seco estala no alto-falante.
    g.gain.setValueAtTime(gain, t0 + Math.max(0, ms / 1000 - 0.03));
    g.gain.linearRampToValueAtTime(0, t0 + ms / 1000);
    g.connect(audioCtx.destination);
    for (const f of freqs) {
      const o = audioCtx.createOscillator();
      o.frequency.value = f;
      o.connect(g);
      o.start(t0);
      o.stop(t0 + ms / 1000);
    }
  } catch {
    // sem áudio disponível
  }
}

export function startRing(kind: 'incoming' | 'outgoing') {
  stopRing();
  const play = () => (kind === 'incoming' ? tone([440, 480], 1200, 0.08) : tone([425], 900, 0.03));
  play();
  ringTimer = window.setInterval(play, kind === 'incoming' ? 3000 : 4000);
}

export function stopRing() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
}

export function ringing() {
  return ringTimer !== null;
}

// Avisos curtos e baixos: subindo ao entrar, descendo ao sair, uma nota só para a mão.
export function chime(kind: 'join' | 'leave' | 'hand') {
  if (kind === 'join') {
    tone([523], 120, 0.03);
    tone([784], 160, 0.03, 0.12);
  } else if (kind === 'leave') {
    tone([784], 120, 0.03);
    tone([523], 160, 0.03, 0.12);
  } else tone([660], 220, 0.03);
}
