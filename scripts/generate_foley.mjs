import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_SOUNDS = path.join(ROOT, "public", "sounds");
const DIST_SOUNDS = path.join(ROOT, "dist", "sounds");

fs.mkdirSync(PUBLIC_SOUNDS, { recursive: true });
fs.mkdirSync(DIST_SOUNDS, { recursive: true });

const SAMPLE_RATE = 44100;

function createWav(samples) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = SAMPLE_RATE * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // "fmt " subchunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // subchunk1 size (16 for PCM)
  buffer.writeUInt16LE(1, 20);  // audio format (1 = PCM)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample

  // "data" subchunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const intSample = s < 0 ? s * 0x8000 : s * 0x7fff;
    buffer.writeInt16LE(Math.round(intSample), 44 + i * 2);
  }

  return buffer;
}

function saveSound(filename, samples) {
  const wav = createWav(samples);
  fs.writeFileSync(path.join(PUBLIC_SOUNDS, filename), wav);
  fs.writeFileSync(path.join(DIST_SOUNDS, filename), wav);
  console.log(`Generated: ${filename} (${samples.length} samples, ${(samples.length / SAMPLE_RATE * 1000).toFixed(0)}ms)`);
}

// Noise generator
function whiteNoise() {
  return Math.random() * 2 - 1;
}

// Lowpass helper
function makeLowpass(cutoffHz) {
  const rc = 1.0 / (cutoffHz * 2 * Math.PI);
  const dt = 1.0 / SAMPLE_RATE;
  const alpha = dt / (rc + dt);
  let prev = 0;
  return (sample) => {
    prev += alpha * (sample - prev);
    return prev;
  };
}

// Highpass helper
function makeHighpass(cutoffHz) {
  const rc = 1.0 / (cutoffHz * 2 * Math.PI);
  const dt = 1.0 / SAMPLE_RATE;
  const alpha = rc / (rc + dt);
  let prevIn = 0;
  let prevOut = 0;
  return (sample) => {
    prevOut = alpha * (prevOut + sample - prevIn);
    prevIn = sample;
    return prevOut;
  };
}

// ------------------- SOUND DEFINITIONS -------------------

// 1. Thuds (Landings)
function genThud(freq, decayMs, clickStrength = 0.4) {
  const duration = decayMs / 1000;
  const numSamples = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(numSamples);
  const lp = makeLowpass(350);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    // Exponential decay
    const env = Math.exp(-t * (1000 / (decayMs * 0.28)));
    // Pitch drops slightly during impact
    const curFreq = freq * (1 + 0.8 * Math.exp(-t * 80));
    const tone = Math.sin(2 * Math.PI * curFreq * t);
    const harmonic = 0.3 * Math.sin(4 * Math.PI * curFreq * t) * Math.exp(-t * 60);

    // Initial click/transient
    const clickEnv = Math.exp(-t * 300);
    const click = lp(whiteNoise()) * clickStrength * clickEnv;

    samples[i] = (tone * 0.75 + harmonic + click) * env;
  }
  return samples;
}

// 2. Bumps (Wall/border collisions)
function genBump(freq, durationMs) {
  const duration = durationMs / 1000;
  const numSamples = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(numSamples);
  const hp = makeHighpass(120);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 45);
    const curFreq = freq * (1 + 0.5 * Math.exp(-t * 120));
    const tone = Math.sin(2 * Math.PI * curFreq * t);
    const noiseTransient = hp(whiteNoise()) * 0.3 * Math.exp(-t * 180);
    samples[i] = (tone * 0.7 + noiseTransient) * env;
  }
  return samples;
}

// 3. Footsteps
function genFootstep(baseFreq, scuffAmount) {
  const duration = 0.07;
  const numSamples = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(numSamples);
  const lp = makeLowpass(800);
  const hp = makeHighpass(150);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 85);
    const tap = Math.sin(2 * Math.PI * baseFreq * t) * 0.45;
    const scuff = hp(lp(whiteNoise())) * scuffAmount * Math.exp(-t * 60);
    samples[i] = (tap + scuff) * env * 0.6; // gentle amplitude for subtle desktop patter
  }
  return samples;
}

// 4. Jumps (Springy push-off)
function genJump(pitchStart, pitchEnd) {
  const duration = 0.14;
  const numSamples = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const progress = t / duration;
    const curFreq = pitchStart + (pitchEnd - pitchStart) * Math.pow(progress, 0.7);
    const env = Math.sin(progress * Math.PI) * Math.exp(-progress * 1.5);
    const tone = Math.sin(2 * Math.PI * curFreq * t);
    samples[i] = tone * env * 0.75;
  }
  return samples;
}

// 5. Grabs (Cloth rustle / grip)
function genGrab(rustleFreq) {
  const duration = 0.16;
  const numSamples = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(numSamples);
  const lp = makeLowpass(rustleFreq);
  const hp = makeHighpass(300);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const progress = t / duration;
    const env = Math.sin(progress * Math.PI);
    // Modulated noise simulating fabric folds shifting
    const mod = 0.5 + 0.5 * Math.sin(2 * Math.PI * 40 * t);
    const rustle = hp(lp(whiteNoise())) * mod;
    samples[i] = rustle * env * 0.8;
  }
  return samples;
}

// 6. Throws (Air whoosh)
function genThrow(peakFreq) {
  const duration = 0.24;
  const numSamples = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(numSamples);
  const lp = makeLowpass(peakFreq);
  const hp = makeHighpass(200);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const progress = t / duration;
    // Bell curve amplitude
    const env = Math.sin(progress * Math.PI);
    const whoosh = hp(lp(whiteNoise()));
    samples[i] = whoosh * env * 0.85;
  }
  return samples;
}

// 7. Pokes (Soft physical nudge)
function genPoke(freq) {
  const duration = 0.08;
  const numSamples = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 65);
    const curFreq = freq * (1 + 0.4 * Math.exp(-t * 100));
    const tone = Math.sin(2 * Math.PI * curFreq * t);
    samples[i] = tone * env * 0.8;
  }
  return samples;
}

// 8. Bounces (Elastic rebound)
function genBounce(freq) {
  const duration = 0.13;
  const numSamples = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 35);
    const curFreq = freq * (1 - 0.2 * (t / duration));
    const tone = Math.sin(2 * Math.PI * curFreq * t);
    const wobble = 0.25 * Math.sin(4 * Math.PI * curFreq * t);
    samples[i] = (tone + wobble) * env * 0.75;
  }
  return samples;
}

// 9. Wakes (Gentle stretch / awakening chime)
function genWake(f1, f2) {
  const duration = 0.36;
  const numSamples = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const env1 = Math.exp(-t * 8);
    const env2 = t > 0.1 ? Math.exp(-(t - 0.1) * 8) : 0;
    const t1 = Math.sin(2 * Math.PI * f1 * t) * env1;
    const t2 = Math.sin(2 * Math.PI * f2 * (t - 0.1)) * env2;
    samples[i] = (t1 * 0.5 + t2 * 0.6) * 0.7;
  }
  return samples;
}

// 10. Sleep (Gentle settling breath/sigh)
function genSleep(sighFreq) {
  const duration = 0.42;
  const numSamples = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(numSamples);
  const lp = makeLowpass(sighFreq);
  const hp = makeHighpass(180);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const progress = t / duration;
    // Slow swell and long gentle fade
    const env = Math.sin(Math.pow(progress, 0.6) * Math.PI) * (1 - progress * 0.7);
    const breath = hp(lp(whiteNoise()));
    samples[i] = breath * env * 0.5;
  }
  return samples;
}

// 11. Bubble Pop (Speech bubble pop)
function genBubble(startFreq, endFreq) {
  const duration = 0.06;
  const numSamples = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const progress = t / duration;
    const curFreq = startFreq + (endFreq - startFreq) * Math.pow(progress, 0.5);
    const env = Math.exp(-t * 90);
    const tone = Math.sin(2 * Math.PI * curFreq * t);
    samples[i] = tone * env * 0.8;
  }
  return samples;
}

// 12. Greet (Warm welcome chime)
function genGreet(note1, note2) {
  const duration = 0.35;
  const numSamples = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const env1 = Math.exp(-t * 9);
    const env2 = t > 0.12 ? Math.exp(-(t - 0.12) * 8) : 0;
    const s1 = (Math.sin(2 * Math.PI * note1 * t) + 0.2 * Math.sin(4 * Math.PI * note1 * t)) * env1;
    const s2 = (Math.sin(2 * Math.PI * note2 * (t - 0.12)) + 0.2 * Math.sin(4 * Math.PI * note2 * t)) * env2;
    samples[i] = (s1 * 0.5 + s2 * 0.6) * 0.75;
  }
  return samples;
}

console.log("Generating realistic physical foley sound effects...");

// Landings
saveSound("thud1.wav", genThud(72, 220, 0.45));
saveSound("thud2.wav", genThud(84, 195, 0.35));
saveSound("thud3.wav", genThud(68, 240, 0.50));

// Bumps
saveSound("bump1.wav", genBump(280, 110));
saveSound("bump2.wav", genBump(330, 95));
saveSound("bump3.wav", genBump(250, 120));

// Footsteps
saveSound("step1.wav", genFootstep(140, 0.4));
saveSound("step2.wav", genFootstep(165, 0.38));
saveSound("step3.wav", genFootstep(150, 0.45));

// Jumps
saveSound("jump1.wav", genJump(130, 260));
saveSound("jump2.wav", genJump(145, 290));

// Grabs
saveSound("grab1.wav", genGrab(1800));
saveSound("grab2.wav", genGrab(2200));

// Throws
saveSound("throw1.wav", genThrow(1600));
saveSound("throw2.wav", genThrow(1900));

// Pokes
saveSound("poke1.wav", genPoke(240));
saveSound("poke2.wav", genPoke(290));

// Bounces
saveSound("bounce1.wav", genBounce(160));
saveSound("bounce2.wav", genBounce(185));

// Wakes
saveSound("wake1.wav", genWake(440, 659.25));
saveSound("wake2.wav", genWake(523.25, 783.99));

// Sleep
saveSound("sleep1.wav", genSleep(900));
saveSound("sleep2.wav", genSleep(1100));

// Bubble pops
saveSound("bubble1.wav", genBubble(380, 850));
saveSound("bubble2.wav", genBubble(420, 920));

// Greetings
saveSound("greet1.wav", genGreet(523.25, 659.25)); // C5 -> E5
saveSound("greet2.wav", genGreet(587.33, 880.00)); // D5 -> A5

console.log("All realistic foley sounds generated successfully!");
