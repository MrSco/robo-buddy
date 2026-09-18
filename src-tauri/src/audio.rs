//! System audio capture (WASAPI loopback of the default output device) and
//! lightweight music analysis. Streams `audio` events to the frontend at ~30 Hz.

use rustfft::{num_complex::Complex, Fft, FftPlanner};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const RATE: usize = 44_100;
const FFT_SIZE: usize = 2048;
const HOP: usize = 512;
const HOPS_PER_SEC: f32 = RATE as f32 / HOP as f32; // ~86
const EMIT_INTERVAL: Duration = Duration::from_millis(33);
/// How often to check whether Windows has moved the default output device elsewhere.
const DEVICE_CHECK_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Serialize, Clone, Copy, Default, Debug)]
pub struct AudioFeatures {
    /// Raw loudness of the last hop, linear 0..1.
    pub rms: f32,
    /// Overall energy after slow automatic gain, 0..1. Use this to decide "is music playing".
    pub level: f32,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    /// Spectral-flux onset strength after gain, 0..1.
    pub onset: f32,
    /// True if at least one beat was detected since the previous event.
    pub beat: bool,
    /// Estimated tempo, 0 when unknown.
    pub bpm: f32,
    /// True after ~1 s of digital silence.
    pub silent: bool,
}

fn rms_db_of(samples: &[f32]) -> f32 {
    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt();
    20.0 * rms.max(1e-9).log10()
}

fn bin_for(hz: f32) -> usize {
    ((hz * FFT_SIZE as f32) / RATE as f32).round() as usize
}

/// Slow-attack/slow-release peak tracker used to normalise features to 0..1.
struct Agc {
    max: f32,
    decay: f32,
}

impl Agc {
    fn new(decay: f32) -> Self {
        Self { max: 1e-6, decay }
    }
    fn norm(&mut self, v: f32) -> f32 {
        self.max = (self.max * self.decay).max(v).max(1e-6);
        (v / self.max).clamp(0.0, 1.0)
    }
}

struct Analyzer {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    ring: Vec<f32>,
    pending: Vec<f32>,
    scratch: Vec<Complex<f32>>,
    prev_mags: Vec<f32>,
    flux_hist: VecDeque<f32>,
    onset_env: VecDeque<f32>,
    level_agc: Agc,
    bass_agc: Agc,
    mid_agc: Agc,
    treble_agc: Agc,
    flux_agc: Agc,
    hops: u64,
    last_beat_hop: u64,
    silent_hops: u32,
    bpm_estimates: VecDeque<f32>,
    pub features: AudioFeatures,
    pub beat_pending: bool,
}

impl Analyzer {
    fn new() -> Self {
        let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
        let window = (0..FFT_SIZE)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32).cos())
            .collect();
        Self {
            fft,
            window,
            ring: vec![0.0; FFT_SIZE],
            pending: Vec::with_capacity(HOP * 4),
            scratch: vec![Complex::default(); FFT_SIZE],
            prev_mags: vec![0.0; FFT_SIZE / 2],
            flux_hist: VecDeque::with_capacity(128),
            onset_env: VecDeque::with_capacity(1024),
            level_agc: Agc::new(0.9995),
            bass_agc: Agc::new(0.9995),
            mid_agc: Agc::new(0.9995),
            treble_agc: Agc::new(0.9995),
            flux_agc: Agc::new(0.999),
            hops: 0,
            last_beat_hop: 0,
            silent_hops: 0,
            bpm_estimates: VecDeque::with_capacity(8),
            features: AudioFeatures::default(),
            beat_pending: false,
        }
    }

    fn push(&mut self, mono: &[f32]) {
        self.pending.extend_from_slice(mono);
        while self.pending.len() >= HOP {
            let hop: Vec<f32> = self.pending.drain(..HOP).collect();
            self.ring.rotate_left(HOP);
            self.ring[FFT_SIZE - HOP..].copy_from_slice(&hop);
            self.analyze_hop(&hop);
        }
    }

    fn analyze_hop(&mut self, hop: &[f32]) {
        self.hops += 1;
        let rms = (hop.iter().map(|s| s * s).sum::<f32>() / hop.len() as f32).sqrt();

        for (i, s) in self.scratch.iter_mut().enumerate() {
            *s = Complex::new(self.ring[i] * self.window[i], 0.0);
        }
        self.fft.process(&mut self.scratch);
        let scale = 2.0 / FFT_SIZE as f32;
        let mags: Vec<f32> = self.scratch[..FFT_SIZE / 2].iter().map(|c| c.norm() * scale).collect();

        let band = |lo: f32, hi: f32| -> f32 {
            let (a, b) = (bin_for(lo).max(1), bin_for(hi).min(mags.len() - 1));
            // An inverted range would slice out of bounds and underflow the divisor. It cannot
            // happen at the rate and size fixed above, but neither is worth a crash if they move.
            if b <= a {
                return 0.0;
            }
            mags[a..b].iter().sum::<f32>() / (b - a) as f32
        };
        let bass = band(20.0, 160.0);
        let mid = band(160.0, 2000.0);
        let treble = band(2000.0, 12000.0);
        let total = band(20.0, 12000.0);

        // Spectral flux on the low/mid range, where kicks and snares live.
        let hi = bin_for(4000.0);
        let mut flux = 0.0;
        for i in 1..hi {
            let d = mags[i] - self.prev_mags[i];
            if d > 0.0 {
                flux += d;
            }
        }
        self.prev_mags.copy_from_slice(&mags);

        self.flux_hist.push_back(flux);
        if self.flux_hist.len() > (HOPS_PER_SEC * 0.75) as usize {
            self.flux_hist.pop_front();
        }
        let mean_flux = self.flux_hist.iter().sum::<f32>() / self.flux_hist.len() as f32;
        let onset = self.flux_agc.norm(flux);
        self.onset_env.push_back(onset);
        if self.onset_env.len() > (HOPS_PER_SEC * 8.0) as usize {
            self.onset_env.pop_front();
        }

        let silent = rms < 1e-4;
        if silent {
            self.silent_hops = self.silent_hops.saturating_add(1);
        } else {
            self.silent_hops = 0;
        }

        let min_gap = (HOPS_PER_SEC * 0.25) as u64; // 240 bpm ceiling
        let is_beat = !silent
            && rms_db_of(hop) > -50.0
            && flux > mean_flux * 1.5 + 1e-4
            && onset > 0.25
            && self.hops - self.last_beat_hop >= min_gap;
        if is_beat {
            self.last_beat_hop = self.hops;
            self.beat_pending = true;
        }

        // Four times a second. The autocorrelation still looks back over 8 s, so the figure stays
        // steady, but it is refreshed often enough to follow a tempo change (or the next track)
        // while he is already in the middle of a dance rather than waiting out the current one.
        if self.hops % (HOPS_PER_SEC * 0.25) as u64 == 0 {
            self.estimate_bpm();
        }

        // Absolute loudness gate: the AGC alone would scale background hiss up to
        // full level. Fully closed below -55 dBFS, fully open above -35 dBFS.
        let rms_db = 20.0 * rms.max(1e-9).log10();
        let gate = ((rms_db + 55.0) / 20.0).clamp(0.0, 1.0);
        let gate = gate * gate;

        let f = &mut self.features;
        f.rms = rms.clamp(0.0, 1.0);
        f.level = if silent { 0.0 } else { self.level_agc.norm(total) * gate };
        f.bass = if silent { 0.0 } else { self.bass_agc.norm(bass) * gate };
        f.mid = if silent { 0.0 } else { self.mid_agc.norm(mid) * gate };
        f.treble = if silent { 0.0 } else { self.treble_agc.norm(treble) * gate };
        f.onset = onset;
        f.silent = self.silent_hops > HOPS_PER_SEC as u32;
        if f.silent {
            f.bpm = 0.0;
            self.bpm_estimates.clear();
            self.onset_env.iter_mut().for_each(|v| *v = 0.0);
        }
    }

    /// Autocorrelation of the onset envelope over the last 8 s, searched between 60 and 180 bpm.
    fn estimate_bpm(&mut self) {
        let env: Vec<f32> = self.onset_env.iter().copied().collect();
        if env.len() < (HOPS_PER_SEC * 4.0) as usize {
            return;
        }
        let mean = env.iter().sum::<f32>() / env.len() as f32;
        let centered: Vec<f32> = env.iter().map(|v| v - mean).collect();
        let energy: f32 = centered.iter().map(|v| v * v).sum();
        if energy < 1e-6 {
            return;
        }
        // 70 rather than 60 at the bottom: a beat correlates just as well at half speed, and the
        // slowest readings were nearly always that rather than a genuinely slow track. Anything
        // under 70 is reported at double, which is the figure worth dancing to anyway.
        let lag_min = (HOPS_PER_SEC * 60.0 / 180.0) as usize;
        let lag_max = (HOPS_PER_SEC * 60.0 / 70.0) as usize;
        let mut best = (0usize, 0.0f32);
        for lag in lag_min..=lag_max {
            let mut r = 0.0;
            for i in lag..centered.len() {
                r += centered[i] * centered[i - lag];
            }
            r /= energy;
            // Preference for the range most music sits in, measured on a log scale so that an
            // octave apart is an even distance. Measured linearly, 80 and 160 bpm are both 40
            // from 120 and score the same, and 85 even beats 170 -- exactly the pairs the
            // autocorrelation confuses, since a beat also correlates at half speed. Half-time
            // therefore kept winning on fast tracks and he danced at half the real tempo.
            let bpm = 60.0 * HOPS_PER_SEC / lag as f32;
            let octaves = (bpm / 125.0).ln() / 0.55;
            let w = (-0.5 * octaves * octaves).exp();
            let score = r * w;
            if score > best.1 {
                best = (lag, score);
            }
        }
        if best.1 < 0.05 {
            return;
        }
        let bpm = 60.0 * HOPS_PER_SEC / best.0 as f32;
        // A driver handing over a NaN sample carries it all the way through to here, and a NaN
        // tempo would both reach the meter and, sorted below, take the whole thread down.
        if !bpm.is_finite() {
            return;
        }
        self.bpm_estimates.push_back(bpm);
        if self.bpm_estimates.len() > 5 {
            self.bpm_estimates.pop_front();
        }
        let mut sorted: Vec<f32> = self.bpm_estimates.iter().copied().collect();
        sorted.sort_by(f32::total_cmp);
        self.features.bpm = sorted[sorted.len() / 2];
    }
}

#[cfg(windows)]
fn capture_loop(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

    let enumerator = DeviceEnumerator::new()?;
    // Loopback: open the default *render* device and initialise it for capture.
    let device = enumerator.get_default_device(&Direction::Render)?;
    // Remembered so the loop can notice Windows moving the default out from under it.
    let device_id = device.get_id().unwrap_or_default();
    let mut client = device.get_iaudioclient()?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, RATE, 2, None);
    let blockalign = format.get_blockalign() as usize;
    let (_default_period, min_period) = client.get_device_period()?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    client.initialize_client(&format, &Direction::Capture, &mode)?;
    // The frame reader below takes two 32-bit samples per frame. Were the negotiated format ever
    // narrower it would pop past the end of a packet and panic, which with `panic = "abort"` takes
    // the whole app down; turn it into an ordinary error the retry loop can handle instead.
    if blockalign < 8 {
        return Err(format!("loopback gave an unexpected {blockalign}-byte frame").into());
    }
    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    client.start_stream()?;
    log::info!("audio loopback started on {}", device.get_friendlyname().unwrap_or_default());

    let mut analyzer = Analyzer::new();
    let mut bytes: VecDeque<u8> = VecDeque::with_capacity(RATE * blockalign);
    let mut mono: Vec<f32> = Vec::with_capacity(RATE / 10);
    let mut last_emit = Instant::now();
    let mut last_device_check = Instant::now();

    loop {
        match event.wait_for_event(100) {
            Ok(()) => {
                capture.read_from_device_to_deque(&mut bytes)?;
                mono.clear();
                while bytes.len() >= blockalign {
                    let mut frame = [0u8; 8];
                    for b in frame.iter_mut() {
                        *b = bytes.pop_front().unwrap();
                    }
                    // Drop any extra channels beyond the first two.
                    for _ in 8..blockalign {
                        bytes.pop_front();
                    }
                    let l = f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
                    let r = f32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]);
                    mono.push((l + r) * 0.5);
                }
                analyzer.push(&mono);
            }
            Err(_) => {
                // No packets for 100 ms: the mixer is idle, feed silence so features decay.
                analyzer.push(&vec![0.0; RATE / 10]);
            }
        }
        if last_emit.elapsed() >= EMIT_INTERVAL {
            last_emit = Instant::now();
            let mut f = analyzer.features;
            f.beat = analyzer.beat_pending;
            analyzer.beat_pending = false;
            let _ = app.emit("audio", f);
        }
        // A capture stream stays open, and keeps handing over digital silence, long after its
        // endpoint has stopped being the default one -- no packet ever fails, so the error path
        // above never runs and he would listen to the wrong device until he was restarted. A
        // wireless headset going to sleep, or a headset coming back, is enough to do it. Ask once
        // a second who the default is now, and reopen on the answer changing.
        if last_device_check.elapsed() >= DEVICE_CHECK_INTERVAL {
            last_device_check = Instant::now();
            let now_default = enumerator
                .get_default_device(&Direction::Render)
                .ok()
                .and_then(|d| d.get_id().ok());
            if let Some(id) = now_default {
                if id != device_id {
                    log::info!("default output device changed; reopening the loopback capture");
                    return Ok(());
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn capture_loop(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    Err("audio capture is only implemented for Windows".into())
}

pub fn start_audio_thread(app: AppHandle) {
    thread::Builder::new()
        .name("audio-loopback".into())
        .spawn(move || {
            #[cfg(windows)]
            let _ = wasapi::initialize_mta();
            loop {
                match capture_loop(&app) {
                    // The default device moved. Reopen straight away rather than leaving him deaf
                    // for another two seconds.
                    Ok(()) => thread::sleep(Duration::from_millis(100)),
                    Err(e) => {
                        log::warn!("audio capture stopped: {e}; retrying in 2 s");
                        let _ =
                            app.emit("audio", AudioFeatures { silent: true, ..Default::default() });
                        thread::sleep(Duration::from_secs(2));
                    }
                }
            }
        })
        .expect("spawn audio thread");
}
