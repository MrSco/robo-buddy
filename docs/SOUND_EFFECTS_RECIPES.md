# Robo-Buddy Sound Effects & ElevenLabs Recipe Guide

Robo-Buddy features a dynamic Web Audio engine for realistic physical foley. Sounds are played with:
- **Multi-sample variation pools**: 2–3 variations per event alternated without immediate repeats to eliminate mechanical "machine-gun" audio fatigue.
- **Micro-pitch jitter**: ±4% random pitch deviation on every trigger.
- **Velocity dynamics**: Fall speeds and impact strengths scale playback volume and filter cutoff (e.g. soft taps vs heavy landings).
- **Independent controls**: Master SFX volume slider and footstep mute toggle in Settings.

---

## 1. Sound Events Reference

| Event | Trigger | Default Files | Recommended Duration | Acoustic Tone |
| :--- | :--- | :--- | :--- | :--- |
| `land` | Dropping onto taskbar or window surface | `thud1.wav`, `thud2.wav`, `thud3.wav` | 0.2s – 0.3s | Weighted room impact, floor thud, velocity scaled |
| `bump` | Colliding with screen borders or window walls | `bump1.wav`, `bump2.wav`, `bump3.wav` | 0.08s – 0.12s | Solid contact, glass/wood edge tap |
| `footstep` | Locomotion while walking/wandering | `step1.wav`, `step2.wav`, `step3.wav` | 0.05s – 0.08s | Subtle shoe/sole tap on desk, quiet and tactile |
| `jump` | Hopping or leaping off surfaces | `jump1.wav`, `jump2.wav` | 0.12s – 0.16s | Subtle spring-off, sole release, light rustle |
| `grab` | Cursor clicking and picking up character | `grab1.wav`, `grab2.wav` | 0.14s – 0.18s | Cloth rustle, physical grip/pickup |
| `throw` | Releasing cursor with high fling velocity | `throw1.wav`, `throw2.wav` | 0.2s – 0.25s | Soft airy whoosh |
| `poked` | Clicking or nudging character | `poke1.wav`, `poke2.wav` | 0.06s – 0.1s | Soft physical poke / tactile nudge |
| `bounce` | Bouncing off borders when thrown | `bounce1.wav`, `bounce2.wav` | 0.1s – 0.15s | Elastic physical rebound tap |
| `wake` | Awakening from sleep / doze | `wake1.wav`, `wake2.wav` | 0.3s – 0.4s | Gentle stretch rustle / soft acoustic presence |
| `sleep` | Falling asleep after inactivity | `sleep1.wav`, `sleep2.wav` | 0.35s – 0.45s | Soft settling breath / gentle sigh |
| `bubble` | Speech bubble popping up | `bubble1.wav`, `bubble2.wav` | 0.05s – 0.08s | Clean organic bubble pop |
| `greet` | Startup greeting / say hi command | `greet1.wav`, `greet2.wav` | 0.3s – 0.4s | Warm acoustic chime / welcoming presence |

---

## 2. ElevenLabs Sound Effects Prompt Engineering

When using [ElevenLabs Sound Effects](https://elevenlabs.io/app/sound-effects), follow these principles for the best physical foley:

1. **Acoustic Environment Constraints**: Always include `dry, close mic, zero reverb, isolated sound effect, natural foley, high quality`. Reverb or room echo causes sounds to sound disconnected from a desktop app.
2. **Short Durations**: Lock the duration slider to the recommended range above (0.1s to 0.4s) to avoid trailing silence or audio artifacts.
3. **Generate 3–4 takes**: Pick the two or three cleanest takes with crisp transient attacks and save them as variation pools (`step1.wav`, `step2.wav`, etc.).

### Prompt Recipes

#### Landings (`land`)
- **Prompt**: `short heavy dull thud of a soft body landing on a wooden floor, close microphone, dry, zero reverb, isolated foley impact`
- **Duration**: `0.3s`
- **Prompt Influence**: `0.4`

#### Bumps (`bump`)
- **Prompt**: `quick solid knuckle tap on glass, dry, isolated, crisp transient attack, zero reverb, tactile collision`
- **Duration**: `0.15s`
- **Prompt Influence**: `0.45`

#### Footsteps (`footstep`)
- **Prompt**: `very quiet soft sneaker step on hardwood, short dry tap, zero echo, subtle everyday foley, isolated`
- **Duration**: `0.1s`
- **Prompt Influence**: `0.4`

#### Jumps / Hops (`jump`)
- **Prompt**: `quick fabric rustle and shoe sole lifting off floor, short springy push off, dry, isolated foley`
- **Duration**: `0.15s`
- **Prompt Influence**: `0.35`

#### Grabs (`grab`)
- **Prompt**: `gentle cotton hoodie fabric rustle, soft cloth movement being picked up, close mic, dry, quiet foley`
- **Duration**: `0.2s`
- **Prompt Influence**: `0.35`

#### Throws (`throw`)
- **Prompt**: `soft gentle air whoosh, quick swish through air, low frequency swoosh, dry, isolated`
- **Duration**: `0.25s`
- **Prompt Influence**: `0.4`

#### Pokes (`poked`)
- **Prompt**: `soft squishy fabric tap, gentle organic finger nudge on plush, quiet dry foley`
- **Duration**: `0.1s`
- **Prompt Influence**: `0.4`

#### Speech Bubble (`bubble`)
- **Prompt**: `clean gentle organic bubble pop, high quality UI pop, water droplet chirp, isolated, dry`
- **Duration**: `0.1s`
- **Prompt Influence**: `0.5`

#### Sleep (`sleep`)
- **Prompt**: `soft gentle quiet breath sigh settling down to rest, peaceful organic exhale, dry, quiet`
- **Duration**: `0.4s`
- **Prompt Influence**: `0.35`

#### Wake (`wake`)
- **Prompt**: `gentle fabric shuffle and soft subtle pleasant chime, waking up stretch, warm organic, dry`
- **Duration**: `0.35s`
- **Prompt Influence**: `0.4`

---

## 3. Customizing Sounds in Character Packs

Any character pack can override app defaults by adding a `sounds` block in its `manifest.json`. You can provide either a single file or an array of variations:

```json
{
  "name": "T-800",
  "renderer": "3d",
  "model": "model.glb",
  "sounds": {
    "land": ["sounds/metal_thud1.wav", "sounds/metal_thud2.wav"],
    "footstep": ["sounds/metal_step1.wav", "sounds/metal_step2.wav"],
    "bump": "sounds/metal_clank.wav",
    "grab": "sounds/servo_grip.wav"
  }
}
```

- Any event not defined in `manifest.sounds` automatically falls back to the app's default realistic foley.
- File paths are relative to the character pack folder.

---

## 4. Recommended Free Foley Archives

In addition to ElevenLabs, these royalty-free studio libraries provide clean real-world recordings:
- **Kenney Audio Packs** (CC0 Public Domain): Excellent impacts, footsteps, and UI clicks: [kenney.nl/assets/category:Audio](https://kenney.nl/assets/category:Audio)
- **Freesound.org** (Filter by Creative Commons 0): High fidelity field recordings of footsteps, cloth rustles, and real impacts.
- **Sonniss GDC Game Audio Archives** (Royalty-free commercial game audio): Thousands of professional foley recordings released annually.
