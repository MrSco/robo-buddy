# Redesign: Robo Buddy owns its own idle trigger

Implementation spec, 2026-09-13. Companion to [screensaver-power.md](screensaver-power.md), which
is the investigation this comes out of. **Read that first** — it records two approaches that were
tried and do not work, and this spec assumes you will not repeat them.

## Why

Robo Buddy registers itself as the Windows screen saver (`SCRNSAVE.EXE`). Windows launches
`robo-buddy.scr /s`, that process relays a request to the resident app and exits within
milliseconds, and the resident draws the real screensaver as ordinary always-on-top windows.

Windows then relaunches the `.scr` every `ScreenSaveTimeOut` seconds, forever, because as far as it
is concerned its screen saver keeps finishing immediately. Each launch/exit cycle resets the power
manager's idle accounting, so the display-off and sleep timers never complete. Captured in
`buddy.log` with `ScreenSaveTimeOut = 60`, display-off at 120 s, sleep at 300 s:

```
16:53:41  screensaver launcher: pid=28364 start desktop=Some("Screen-saver")
16:53:41  screensaver relay: already running; request ignored
16:54:42  screensaver launcher: pid=40060 start desktop=Some("Screen-saver")   (+61s)
16:55:43  screensaver launcher: pid=8988  start desktop=Some("Screen-saver")   (+61s)
16:56:44  screensaver launcher: pid=10368 start desktop=Some("Screen-saver")   (+61s)
16:58:06  screensaver launcher: pid=9772  start desktop=Some("Screen-saver")   (+82s)
16:59:07  screensaver launcher: pid=9476  start desktop=Some("Screen-saver")   (+61s)
17:00:08  screensaver launcher: pid=620   start desktop=Some("Screen-saver")   (+61s)
17:01:09  screensaver launcher: pid=36552 start desktop=Some("Screen-saver")   (+61s)
```

A 120-second timer reset every 61 seconds never fires. Nothing holds a power request while this
happens, which is why `powercfg /requests` reads `None` throughout and the cause stayed hidden for
so long.

The screensaver started from the tray — the same overlay, the same backdrop, no `.scr` — lets the
machine blank at 2 min and sleep at 5 min. So the fix is to always take that path.

## The shape

Robo Buddy stops being the thing Windows launches, and triggers itself.

1. **Never write `SCRNSAVE.EXE`.** The user's own saver stays registered, untouched. This is the
   "leave glmatrix alone" requirement, and it also means restoring is a single flag rather than
   copying a path back.
2. **Suppress Windows' screen saver** by clearing `ScreenSaveActive` while the feature is on, so it
   never fires on top of ours and never relaunches anything.
3. **Poll `GetLastInputInfo`** in the resident and call `screen::screensaver_start` at the
   threshold.
4. **Keep the backdrop as-is.** `screensaver_backdrop` already holds their saver's path and
   `start_backdrop` already runs it with `/s`. Their screen saver keeps playing, as the layer the
   buddy plays in front of.
5. **Delete the whole `.scr` mechanism** — `saver_launch`, the copy, the argument parsing, the
   registry dance.

Ending the screensaver does not change: the cursor and key threads in `input.rs` already tear it
down on input.

## Work items

### 1. New setting: how long before he takes over

`src-tauri/src/settings.rs` — add to `Settings`:

```rust
/// Minutes idle before the screensaver comes up on its own. 0 turns it off.
pub screensaver_after_min: f64,
```

Default `0.0` in the `Default` impl beside the other `screensaver_*` fields
([settings.rs:112](../src-tauri/src/settings.rs#L112)). The struct already carries
`#[serde(default, rename_all = "camelCase")]` ([settings.rs:12](../src-tauri/src/settings.rs#L12)),
so it reaches the frontend as `screensaverAfterMin` with no per-field attribute. Mirror it in
`src/settings-store.ts` (`Settings` interface plus `DEFAULT_SETTINGS`).

### 2. Suppressing and restoring Windows' screen saver

`src-tauri/src/screen.rs`. `apply_screensaver_active()`
([screen.rs:741](../src-tauri/src/screen.rs#L741)) already makes the `SPI_SETSCREENSAVEACTIVE` call
— keep it and use it for both directions.

```rust
const SUPPRESSED: &str = "SCRNSAVE.EXE.RoboBuddySuppressed";
```

- **Suppress:** write `ScreenSaveActive = "0"`, `apply_screensaver_active(false)`, set `SUPPRESSED`
  to `"1"`.
- **Restore:** write `ScreenSaveActive = "1"`, `apply_screensaver_active(true)`, delete
  `SUPPRESSED`.

The marker is what distinguishes "we turned this off" from "the user turned it off themselves".
Without it there is no safe way to re-enable on cleanup.

**Never touch `SCRNSAVE.EXE` in either direction.**

### 3. Idle watcher

`src-tauri/src/input.rs`, beside the other watchers. Poll at 1 s — this does not need the 8 ms
cadence the cursor thread uses.

```rust
fn idle_seconds() -> Option<f64> {
    let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe { GetLastInputInfo(&mut info).ok()? };
    // dwTime is a 32-bit tick count, so this must be GetTickCount and not GetTickCount64,
    // and the subtraction must wrap: both roll over every 49.7 days.
    Some(unsafe { GetTickCount() }.wrapping_sub(info.dwTime) as f64 / 1000.0)
}
```

Start it only when every one of these holds:

| Guard | Why |
|---|---|
| `screensaver_after_min > 0.0` | the feature is on |
| `idle_seconds() >= screensaver_after_min * 60.0` | the actual trigger |
| no `screensaver-0` window | it is already up |
| `desktop_is_visible()` | the session is locked, or another desktop has input |
| `!hide_when_fullscreen \|\| !foreground_is_fullscreen()` | a game or video is running; reuse [input.rs:160](../src-tauri/src/input.rs#L160) |

`desktop_is_visible()` currently lives in `saver_launch.rs`
([saver_launch.rs:32](../src-tauri/src/saver_launch.rs#L32)). **Move it into `input.rs` before
deleting that module** — it is the guard that keeps the screensaver off the lock screen, and it is
the one piece of `saver_launch` worth keeping.

No cooldown is needed after the screensaver ends: whatever input dismissed it has already reset
`GetLastInputInfo`, so the count restarts naturally.

### 4. Replace the registration command

`set_windows_screensaver(app, enable)` ([screen.rs:668](../src-tauri/src/screen.rs#L668)) becomes
something like `set_idle_screensaver(app, minutes)`:

- `minutes > 0` → write `screensaver_after_min`, suppress Windows' saver, return a line saying
  Robo Buddy will come up after N minutes and that their own screen saver still plays behind him.
- `minutes == 0` → write `0.0`, restore Windows' saver.

Keep the existing return-a-status-string shape; `src/settings.ts` already renders it into
`ss-win-status`.

### 5. Settings UI

`settings.html` — replace the **Use Robo Buddy** / **Restore previous** buttons
([settings.html:353](../settings.html#L353)) with a minutes field (0 = off) and keep the
`ss-win-status` paragraph.

`src/settings.ts` — `els.ssWinSet` / `els.ssWinUnset` and their listeners
([settings.ts:821](../src/settings.ts#L821), [settings.ts:840](../src/settings.ts#L840)) become one
change handler calling the new command.

Say plainly in the status text that Windows' own screen saver is turned off while this is on, and
that their choice of saver is kept and still plays behind him. Windows' Screen Saver dialog will
show **(None)** while suppressed — that is expected, and users will otherwise think their setting
was destroyed again.

### 6. Migration

Existing installs have `SCRNSAVE.EXE` pointing at a `.scr` that will no longer relay anything. Run
once at startup, before the idle watcher starts:

1. If `SCRNSAVE.EXE` is our `.scr`, write `SCRNSAVE.EXE.RoboBuddyPrev` back into `SCRNSAVE.EXE`
   (an empty value is fine and means "they had none"), then delete `RoboBuddyPrev`.
2. If step 1 fired, the user clearly wanted an idle screensaver: set `screensaver_after_min` from
   the existing `ScreenSaveTimeOut / 60.0` (clamp to something sane, 1–60) so their timing carries
   over, then suppress.
3. Delete `%LOCALAPPDATA%\Robo Buddy\robo-buddy.scr` best-effort. The installer does not ship it —
   it is written by the app — so nothing replaces it.

Keep `is_our_scr()` ([screen.rs:584](../src-tauri/src/screen.rs#L584)) for step 1; it already
handles DOS short paths and quoted values, which the control panel writes. Delete it once migration
is retired, along with its tests.

### 7. Deletions

- **`src-tauri/src/saver_launch.rs`** — the whole module, after moving `desktop_is_visible` out.
- **`src-tauri/src/lib.rs`**: `mod saver_launch` ([15](../src-tauri/src/lib.rs#L15)),
  `ScreensaverArg` ([30](../src-tauri/src/lib.rs#L30)), `screensaver_arg`
  ([41](../src-tauri/src/lib.rs#L41)), the `/s` short-circuit in `run()`
  ([131](../src-tauri/src/lib.rs#L131)), the single-instance match
  ([141](../src-tauri/src/lib.rs#L141) — collapses to just `input::bring_here`), the `setup()` match
  ([176](../src-tauri/src/lib.rs#L176)), and `saver_launch::listen`
  ([237](../src-tauri/src/lib.rs#L237)).
- **`src-tauri/src/screen.rs`**: `scr_path`, `refresh_scr`, `windows_screensaver_status`,
  `set_windows_screensaver`, `PREV_SAVER`. Keep `apply_screensaver_active`.
- **`lib.rs` invoke_handler**: drop `screen::set_windows_screensaver` and
  `screen::windows_screensaver_status`, add the new command.

Note that `refresh_scr` also disappears, and with it a latent bug worth knowing about: it swallows
its copy error (`let _ = std::fs::copy(...)`), so a `.scr` locked by a running process failed to
update silently. That is how a stale `.scr` survived two reinstalls during this investigation.

One behaviour is genuinely lost: Windows' Screen Saver dialog **Settings** button sent `/c`, which
opened our settings on the Window tab. Nothing will send it once we are not registered.

## Acceptance test

With `screensaver_after_min = 1`, display-off at 2 min, sleep at 5 min:

```bash
pwsh -File scripts/probe-sleep.ps1 -Minutes 8
```

Run elevated, and do not touch the machine. Pass looks like:

- the screensaver comes up at ~60 s
- **no** `screensaver launcher:` lines in `buddy.log` at all — nothing should be launching a `.scr`
- `windowsSaverRunning` stays `false` in every sample
- `idleSeconds` climbs monotonically past 300
- the displays blank at ~120 s and the machine sleeps at ~300 s

If `idleSeconds` resets partway through, the run is void — that is the 12 px deadband in
[input.rs:104](../src-tauri/src/input.rs#L104) letting small real input through without dismissing
the screensaver. Rerun it.

## Do not attempt

Both of these were tried during the investigation and are written up in
[screensaver-power.md](screensaver-power.md):

- **Holding the `.scr` open** so Windows sees a saver of ordinary length. Windows runs a screen
  saver on its own `Screen-saver` desktop and only switches back to the interactive desktop when
  the saver process ends, so the resident is left with nothing it may draw on and gives up after
  three seconds. Screens go black for a second and come back.
- **Having the `.scr` call `SwitchDesktop` itself** to get around that. It is the security boundary
  that makes "On resume, display logon screen" mean anything.

## Known costs

- **"On resume, display logon screen" stops applying.** Windows' saver is off, so nothing triggers
  the lock. Robo Buddy's screensaver never locked anything — it is ordinary windows over the
  desktop — so no behaviour that works today is lost, but the Windows setting silently stops
  meaning anything. If the lock matters, it has to be implemented directly
  (`LockWorkStation` after a configurable delay) rather than inherited.
- **Nothing shows on the lock screen.** Same as today.
- **The user can re-enable Windows' saver behind our back** in the Screen Saver dialog, and then
  both fire. Cheap defence: on each idle tick, if `screensaver_after_min > 0` and `ScreenSaveActive`
  has become `1` while `SUPPRESSED` is set, suppress again.

## Open decisions

- Whether `screensaver_after_min` should default to `0` (off, users opt in) or be seeded from
  `ScreenSaveTimeOut` for everyone. The spec assumes off by default, with seeding only for users
  migrating off the `.scr`.
- Whether to keep the `.scr` around purely so Robo Buddy still appears in Windows' Screen Saver
  dropdown. It would need to live in `C:\Windows\System32` for Windows to enumerate it, which needs
  elevation, and picking it there would put us straight back into the relaunch loop. Recommend not.
