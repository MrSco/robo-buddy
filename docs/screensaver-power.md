> Historical investigation. The implemented design is in [screensaver-idle-redesign.md](screensaver-idle-redesign.md).
> The keep-alive recommendation below was superseded by the later desktop tests. Power-timer
> resets are a causal inference from the launch loop, not a direct measurement.

# Screensaver mode prevents display sleep and system sleep

Investigation log, 2026-09-13. Windows 11 Pro 10.0.26200.

## Summary

When Robo Buddy is registered as the Windows screen saver (`SCRNSAVE.EXE`), the machine never
powers off its displays and never sleeps, no matter how long it sits idle. Controlled tests
isolate the cause to **Windows launching `robo-buddy.scr /s`**, not to anything the app does
while the screensaver is on screen.

`saver_launch::relay()` ([saver_launch.rs:56](../src-tauri/src/saver_launch.rs#L56)) signals a
named event and returns, so the `.scr` process dies within milliseconds. Windows sees its screen
saver terminate almost immediately after starting it, and the power manager's display and sleep
idle timers stop firing. Nothing registers a power request, so the problem is invisible to
`powercfg /requests`.

**The fix is to keep the `.scr` process alive for as long as the screensaver is up.**

## Environment

| | |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| Sleep states | **S3 only** — no Modern Standby (S0 Low Power Idle), no hibernate |
| Active power scheme | High performance (`8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c`) |
| `ScreenSaverIsSecure` | `0` (saver runs on the normal input desktop, not the secure one) |
| `screensaverBackdrop` | `…\XScreenSaverWin-0.79\XScreenSaverWin\glmatrix_scr\glmatrix.scr` |
| Audio devices | NVIDIA HD Audio, Realtek HD Audio, Oculus / Virtual Desktop / Steam Streaming virtual endpoints |

Timeouts were shortened partway through the investigation to make tests fast:

| Setting | Original | Test value |
|---|---|---|
| `ScreenSaveTimeOut` | 300 s (5 min) | **60 s** |
| `VIDEOIDLE` AC (display off) | 1500 s (25 min) | **120 s** |
| `STANDBYIDLE` AC (sleep) | 2700 s (45 min) | **300 s** |

Both shortened values were verified to have landed on the **active** scheme
(`powercfg /q SCHEME_CURRENT SUB_VIDEO VIDEOIDLE` → `0x78`; `SUB_SLEEP STANDBYIDLE` → `0x12c`).
Misconfiguration is ruled out.

## Symptom

With Robo Buddy installed as the Windows screen saver:

- The screensaver starts on cue at `ScreenSaveTimeOut`.
- The displays never power off, at any timeout value.
- The system never sleeps, at any timeout value.
- `powercfg /requests` shows nothing under `DISPLAY`, `SYSTEM` or `AWAYMODE` the entire time.

## Tests

### Test 1 — Robo Buddy registered as the Windows screen saver (FAILS)

`scripts/probe-sleep.ps1 -Minutes 7`, elevated, 84 samples, 13:07:25–13:14:23.
Output: `output/sleep-probe.jsonl`.

```
   0s  idle=   0.4  backdrop=-   DISPLAY=None  SYSTEM=None   EXEC=[PROCESS] …\claude.exe (Electron)
  65s  idle=  65.9  backdrop=Y   DISPLAY=None  SYSTEM=None   <- screensaver up
 131s  idle= 131.3  backdrop=Y   DISPLAY=None  SYSTEM=None   EXEC=None
 185s  idle= 185.6  backdrop=Y   DISPLAY=None  SYSTEM=None   <- display should have blanked at 120s
 307s  idle= 307.4  backdrop=Y   DISPLAY=None  SYSTEM=None   <- system should have slept at 300s
 312s  idle=   3.1  backdrop=Y   DISPLAY=None  SYSTEM=None   <- idle timer reset, screensaver stayed up
 418s  idle= 108.8  backdrop=Y   DISPLAY=None  SYSTEM=None
```

Key observations:

- `DISPLAY`, `SYSTEM` and `AWAYMODE` read `None` in **all 84 samples**. No standing power request
  exists at any point.
- `idleSeconds` (from `GetLastInputInfo`) climbs cleanly past both deadlines to 307 s. Neither
  timer fires.
- The one `EXECUTION` entry is the Claude desktop app; it cleared at t=131 s while idle kept
  climbing. `EXECUTION` requests only prevent process suspension under Modern Standby, which this
  machine does not support. Irrelevant.
- The reset at t=312 s is real input small enough to miss Robo Buddy's 12 px deadband (see
  [Secondary findings](#secondary-findings)). It happened *after* both deadlines had already
  passed, so it does not explain the failure.

### Test 2 — glmatrix as the Windows screen saver, Robo Buddy resident running (PASSES)

`SCRNSAVE.EXE` restored to glmatrix. Robo Buddy left running but its own screensaver never
triggered.

Result: glmatrix started at 1 min, **display off at 2 min, system slept at 5 min.**

Clears the always-on resident — audio loopback thread, 8 ms cursor poll, 15 ms key poll, buddy
WebView2 window — and clears the glmatrix binary itself.

### Test 3 — Robo Buddy's screensaver triggered manually (PASSES)

Same setup as Test 2, but the user started Robo Buddy's screensaver from the buddy's right-click
menu ("Screensaver now"), which calls `screen::screensaver_start` directly with no `.scr`
involved.

Result: Robo Buddy's overlay went up, it spawned its glmatrix backdrop child, Windows' own
glmatrix then fired at 1 min, **display off at 2 min, system slept at 5 min.**

This is the decisive test. It exercises every component of screensaver mode *except* the
`.scr` launch, and power management works perfectly.

### Elimination table

| Component | Present in Test 3 | Power worked |
|---|---|---|
| Resident buddy (audio thread, polling threads, WebView2) | yes | ✅ |
| Overlay screensaver WebView2 windows (one per monitor) | yes | ✅ |
| glmatrix spawned as Robo Buddy's backdrop child | yes | ✅ |
| `robo-buddy.scr` launched by Windows with `/s` | **no** | ✅ |

Only the last row differs from the failing Test 1.

## Root cause

`lib.rs:132` short-circuits before Tauri initialises when launched with `/s`:

```rust
if matches!(screensaver_arg(&std::env::args().collect::<Vec<_>>()), Some(ScreensaverArg::Show)) {
    if let Err(e) = saver_launch::relay() { eprintln!("screensaver launch: {e}"); }
    return;
}
```

and `relay()` ([saver_launch.rs:56](../src-tauri/src/saver_launch.rs#L56)) returns as soon as it
can signal the resident:

```rust
pub fn relay() -> Result<(), String> {
    if signal() { return Ok(()); }   // resident already running -> returns immediately
    start_resident()?;
    …
}
```

So Windows starts its screen saver and the process exits milliseconds later. From Windows' point
of view the saver ran and finished — the same transition as the user dismissing it with input.
The power manager's display and sleep idle accounting stops advancing, while `GetLastInputInfo`
keeps climbing (they are separate clocks). Because no `SetThreadExecutionState`/`PowerSetRequest`
call is involved, `powercfg /requests` stays empty.

Meanwhile the visible screensaver is a set of ordinary always-on-top WebView2 windows owned by
the resident, whose lifetime is completely decoupled from Windows' saver lifecycle. Windows
believes no screen saver is running; `SPI_GETSCREENSAVERRUNNING` would report `FALSE`.

### Still unresolved (does not change the fix)

Whether Windows relaunches `robo-buddy.scr /s` repeatedly (once per `ScreenSaveTimeOut`, each
cycle re-arming the timers) or a single bad exit is enough to suppress them.

**The log cannot answer this today.** At [saver_launch.rs:86](../src-tauri/src/saver_launch.rs#L86)
the early-out sits *above* the log line:

```rust
if app.get_webview_window("screensaver-0").is_some() { continue; }
crate::chat::append_log(app.clone(), "screensaver relay: Windows launch returned; …".into());
```

Every relaunch arriving while the overlay is already up is silent. `buddy.log` shows one relay
entry at 13:08:26 for the whole 7-minute probe, but that means "one launch that found no
overlay", not "one launch". Both mechanisms are fixed by keeping the `.scr` alive.

## Explicitly ruled out — do not re-investigate

- **Power plan misconfiguration.** Verified on the active scheme; see Environment.
- **Standing power requests of any kind.** `DISPLAY`/`SYSTEM`/`AWAYMODE` were `None` across all
  84 probe samples.
- **The WASAPI loopback capture thread** ([audio.rs:328](../src-tauri/src/audio.rs#L328), started
  unconditionally at [lib.rs:238](../src-tauri/src/lib.rs#L238)). It runs forever and ignores
  `musicEnabled`, which looked like a prime suspect for `[DRIVER] … An audio stream is currently
  in use`. That request never appeared, and Test 2 passed with the thread running. *(Still worth
  gating on `musicEnabled` some day for idle CPU, but it is not this bug.)*
- **WebView2 / Chromium media blockers.** No `<video>` in `screensaver.html`, no `navigator.wakeLock`
  anywhere. `screensaverSounds` is `false` and [main.ts:456](../src/main.ts#L456) mutes sound
  effects while the screensaver is on. The STT `AudioContext` is closed properly at
  [chat.ts:514](../src/chat.ts#L514). `talkMode` is `pipeline`, so `live.ts` (persistent mic +
  `<audio>` + `AudioContext`) is not running.
- **The app calling keep-awake APIs.** No `SetThreadExecutionState`, `PowerSetRequest`,
  `PowerCreateRequest`, `SendInput`, `SetCursorPos`, `keybd_event` or `AttachThreadInput` anywhere
  in `src-tauri/`. `raise_buddy` and `start_topmost_thread` use `SetWindowPos` with `SWP_NOACTIVATE`.
- **glmatrix / XScreenSaverWin blocking power.** Zero hits for `SetThreadExecutionState`,
  `SC_MONITORPOWER`, `SC_SCREENSAVE`, `PowerSetRequest`, `SendInput` or `SetCursorPos` across its
  327 `.c` files. Test 2 confirms empirically.
- **Tao swallowing `WM_SYSCOMMAND`.** Tao does block `SC_SCREENSAVE`, but only when the window is
  fullscreen, and it never touches `SC_MONITORPOWER`
  (`tao-0.35.3/src/platform_impl/windows/event_loop.rs:1266`):

  ```rust
  if wparam.0 == SC_SCREENSAVE as _ {
    if window_state.fullscreen.is_some() { result = ProcResult::Value(LRESULT(0)); return; }
  }
  result = ProcResult::DefWindowProc;
  ```

  No window in this app is built fullscreen — the screensaver windows use `.decorations(false)`
  plus `set_position`/`set_size`, and `tauri.conf.json` declares only the 320×440 buddy window.
- **Orphaned backdrop processes.** Checked after the probe; no stray `glmatrix.scr` was running.
- **Polling threads.** 8 ms cursor, 15 ms key, 25 ms hotkey, 150 ms surfaces. They read
  `GetAsyncKeyState`/`GetCursorPos`; reading input state creates no power request and does not
  reset the idle timer. (They would matter on a Modern Standby machine. This one is S3.)
- **`refresh_scr()`** ([screen.rs:646](../src-tauri/src/screen.rs#L646)) is guarded by
  `windows_screensaver_status()`, so it only refreshes the `.scr` copy when Robo Buddy is already
  the registered saver. It does not clobber anything.

## Recommendations

### 1. Keep the `.scr` process alive for the session — ~~*the fix*~~ **TRIED, DOES NOT WORK**

**Implemented and reverted on 2026-09-13. Do not attempt this again.** It is not a matter of
getting the details right; the approach cannot work at all.

Windows runs a screen saver on a **desktop of its own**, named `Screen-saver`, and only switches
the input desktop back to `Default` once the saver process ends. The resident's windows live on
`Default` and it refuses to draw while another desktop has the input — that is what
`desktop_is_visible()` and the 400 ms + 30×100 ms retry loop in `listen()` are for. So:

- `.scr` exits promptly → Windows tears down the `Screen-saver` desktop → the resident sees
  `Default` come back and draws. This is why the original design works.
- `.scr` holds itself open → the desktop never switches back → the resident waits out its three
  seconds, logs `desktop not interactive; request expired`, and gives up. The screens go black for
  a second or two and then return.

Caught in `buddy.log`, with the launcher logging its own desktop:

```
15:11:03  launcher pid=1696   start desktop=Some("Default")        <- drew fine
15:12:12  launcher pid=38720  start desktop=Some("Screen-saver")
15:12:12  relay: request received; resident pid=37368 desktop visible=false
15:12:15  relay: desktop not interactive; request expired
```

The comment that was already in `relay()` said this before the attempt — *"The `.scr` must return
to Windows before we capture/show the ordinary desktop. Never switch desktops ourselves or bypass
the Windows lock screen."* Having the `.scr` call `SwitchDesktop` itself is not a way around it:
that is the deliberate security boundary the second sentence is about.

What follows is the original reasoning, kept only so the dead end is legible.

Add a second named event, set by the resident in `screensaver_stop`. `relay()` should signal the
start event as it does now, then **block on the stop event** instead of returning, so the `.scr`
lives exactly as long as the screensaver is on screen. Windows then sees a normally-behaved
screen saver with a normal lifetime, which Test 2 proves is all it needs.

Details to get right:

- The existing start event is `Local\com.rocco.robobuddy.screensaver-request-v1`
  ([saver_launch.rs:13](../src-tauri/src/saver_launch.rs#L13)). Name the new one consistently and
  create it in the resident's `listen()` so it exists before any `.scr` waits on it.
- Signal the stop event on **every** exit path out of `screensaver_stop`, including the watchdog
  timeout in `screensaver_start` and the error paths that call `screensaver_stop` on failure.
- Give the wait a ceiling (a `WaitForSingleObject` timeout of a few hours) so a `.scr` can never
  be orphaned if the resident dies without signalling.
- If `relay()` had to `start_resident()` first, it still needs to wait afterwards — the current
  retry loop returns `Ok(())` as soon as `signal()` succeeds.

### 2. Adopt the saver being replaced as the backdrop

When `set_windows_screensaver(true)` finds an existing saver in `SCRNSAVE.EXE`, write that path
into `screensaverBackdrop` as well as stashing it for restore. The user's own screen saver then
keeps running — as the layer underneath — and comes back on uninstall.

No new machinery is needed: `start_backdrop` ([screen.rs:760](../src-tauri/src/screen.rs#L760))
already takes a plain path and runs it with `/s`, with no relationship to the registry. Today the
user has to point `screensaverBackdrop` at their old saver by hand after Robo Buddy has already
overwritten the registry value.

### 3. Fix the previous-saver backup

[screen.rs:685](../src-tauri/src/screen.rs#L685):

```rust
if !is_our_scr(&cur, &scr) {
    let _ = desktop.set_value(PREV_SAVER, &cur);
}
```

The guard correctly avoids overwriting the backup with Robo Buddy's own path, but it will happily
save an **empty** `cur`. If the feature is ever enabled while `SCRNSAVE.EXE` is blank, the backup
becomes `""`; anything the user sets afterwards is then overwritten on the next enable with no
record of it.

Wants `&& !cur.trim().is_empty()`.

**Correction.** An earlier draft of this document claimed the user's glmatrix path had already been
lost this way. That was wrong, and the recommendation stands only as a latent bug. The backup is
kept under the value name `SCRNSAVE.EXE.RoboBuddyPrev`
([screen.rs:578](../src-tauri/src/screen.rs#L578)), not `RoboBuddyPrevSaver`; the checks that
reported it empty were reading a value name that has never existed. The real value was holding
`…\glmatrix_scr\glmatrix.scr` correctly the whole time.

### 4. Move the relay log line above the early-out

[saver_launch.rs:86–87](../src-tauri/src/saver_launch.rs#L86) — log the launch first, then decide
whether to act on it. Without this there is no visibility into how often Windows launches the
`.scr`, which blocked this investigation and will block the next one.

### 5. Extend `scripts/probe-sleep.ps1`

Sample `SystemParametersInfoW(SPI_GETSCREENSAVERRUNNING /* 0x0072 */)` alongside the existing
fields. That records Windows' own view of whether a screen saver is running, which is the state
this bug corrupts and which nothing currently observes. No elevation needed for that call.

## The remaining route — own the idle trigger

With recommendation 1 ruled out, the only way to fix the power bug is to stop letting Windows
launch us at all, so there is no launch-and-exit for it to misread and no `Screen-saver` desktop in
the way. Test 3 is the evidence this works: started from the tray, with the overlay up and the
backdrop spawned, the machine blanked at 2 min and slept at 5 min.

Shape of it:

- Leave `SCRNSAVE.EXE` alone entirely — the user's own saver stays registered, which is what they
  asked for. Clear `ScreenSaveActive` instead so Windows does not fire it on top of ours, and put
  it back on disable.
- Poll `GetLastInputInfo` in the resident and call `screensaver_start` directly at the threshold.
  Keep reading `ScreenSaveTimeOut` for the timing so the Windows dialog still sets it.
- Keep spawning `screensaverBackdrop` as today; it already holds their saver.
- `saver_launch` goes away, along with the `.scr` copy and the registry write.

The cost is that "On resume, display logon screen" would no longer apply to our screensaver. It
never locked anything anyway — the overlay is ordinary windows over the desktop — so nothing that
works today is lost, but the Windows setting would silently stop meaning anything.

## Alternative design — ride the user's registered screen saver

Longer-term, the cleanest shape is for Robo Buddy never to touch `SCRNSAVE.EXE` at all: leave the
user's saver registered, poll `SPI_GETSCREENSAVERRUNNING`, and lay the overlay over whatever
Windows started. The user's saver *is* the backdrop, so `screensaverBackdrop` and `start_backdrop`
both disappear, and Windows' saver keeps its normal lifetime so power management just works.

Test 3 is evidence this works: Windows' glmatrix and Robo Buddy's topmost overlay coexisted, and
the machine blanked and slept on schedule. The glmatrix backdrop also survived six minutes covered
by three topmost windows in Test 1 (pid 8852, present in every sample), so at least this saver
tolerates not being foreground.

Two problems to solve before taking this route:

- **Capture timing.** `screensaver_start` photographs the desktop, and by the time
  `SPI_GETSCREENSAVERRUNNING` goes true the saver already covers the screen — see the comment at
  [screen.rs:434](../src-tauri/src/screen.rs#L434) noting the grab fails outright in exactly that
  situation. The capture would have to move earlier: read `ScreenSaveTimeOut`, poll
  `GetLastInputInfo`, and grab a few seconds before the saver is due.
- **Secure desktop.** If the user turns on "On resume, display logon screen", Windows runs the
  saver on the secure desktop where the overlay cannot appear. `desktop_is_visible()`
  ([saver_launch.rs:23](../src-tauri/src/saver_launch.rs#L23)) already has the detection; the
  overlay would need to bail out cleanly.

Recommendations 1–3 give a correct app without this rework, and do not block it later.

## Secondary findings

**12 px cursor deadband.** [input.rs:104](../src-tauri/src/input.rs#L104):

```rust
let moved = (cur.x - ax).abs() > 12 || (cur.y - ay).abs() > 12;
```

Real input smaller than 12 px restarts Windows' idle clock without dismissing Robo Buddy's
screensaver. This is what the `307 → 3.1` reset at t=312 s in Test 1 is — note the backdrop stayed
alive right through it. Not related to the sleep bug, but it means a drifting mouse or a VR
controller can silently restart the idle clock while the screensaver looks undisturbed. **Any
future idle test whose `idleSeconds` resets partway through proves nothing and must be rerun.**
Worth considering whether sub-threshold movement should still count as activity for the app's own
purposes, or whether the deadband should be tightened.

**Audio loopback thread never stops.** [audio.rs:328](../src-tauri/src/audio.rs#L328) runs a WASAPI
loopback capture forever, ignoring `musicEnabled`, and retries every 2 s on failure. Not the cause
of this bug (proven by Test 2 and by the empty `SYSTEM` column), but it is unnecessary idle CPU and
an open audio stream whenever music reactivity is off.
