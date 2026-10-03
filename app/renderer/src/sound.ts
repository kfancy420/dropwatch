// The in-stock alarm: three rising notes, four times. Made here so there is
// no sound file to ship and it plays the same on every computer.

let context: AudioContext | undefined;

const NOTES = [880, 1174.66, 1396.91];
const NOTE_SEC = 0.13;
const ROUNDS = 4;
const ROUND_SEC = 0.75;

export function playAlarm(): void {
  context ??= new AudioContext();
  const ctx = context;
  void ctx.resume();
  const start = ctx.currentTime + 0.05;
  for (let round = 0; round < ROUNDS; round++) {
    NOTES.forEach((frequency, i) => {
      const at = start + round * ROUND_SEC + i * NOTE_SEC;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.35, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, at + NOTE_SEC * 2.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + NOTE_SEC * 2.4);
    });
  }
}
