# Resident idle screensaver

Implemented 2026-09-13. This replaces the original proposal to persistently clear ScreenSaveActive.

## Behavior

Robo Buddy detects session inactivity and starts the existing desktop destruction overlay directly.
It no longer registers or refreshes a Windows `.scr` relay. The background choices are:

- Use my Windows screensaver: read the user's current SCRNSAVE.EXE when the overlay starts.
- Choose another screensaver: keep an explicit background path.
- No background screensaver: black behind the destruction effect.

An existing explicit background is retained. During migration, a background matching the previous
Windows saver becomes the automatic Windows choice. Existing Robo Buddy registrations migrate back
to the backed-up Windows saver and carry their timeout into Buddy's idle setting. A missing backup
is an error, not a request to erase the user's selection. New installs default to automatic mode off.

## Windows ownership and crash recovery

Only migration writes SCRNSAVE.EXE. While automatic mode is enabled, a small native helper uses
SPI_SETSCREENSAVEACTIVE without SPIF_UPDATEINIFILE. No active flag or suppression marker is persisted.
The helper acknowledges successful suppression before Buddy enables the idle watcher. Its stdin is
a pipe owned by the resident. Disabling, normal exit, or abrupt parent death closes that pipe and
restores the original runtime active state. Restarting Windows uses the unchanged persisted state.

If the user changes Windows screensaver preferences, Buddy stops automatic mode and honors the new
selection. The helper applies the latest persisted active flag if preferences changed during its
lease, rather than leaving temporary suppression behind. If the helper itself exits, the resident
restores the state and disables automatic mode. Simultaneously terminating both processes externally
can leave runtime suppression until the next session; this is not a persisted system change.

Password-protected screensavers and screensaver policies retain control: automatic Buddy mode is
unavailable while those settings apply. It does not silently remove Windows' locking behavior or
switch desktops. Manual overlay mode remains available.

The backdrop belongs to a kill-on-close Windows job, so resident crashes also terminate its background
process. Backdrop recovery setup failure falls back to black instead of leaving an unmanaged saver.

## Idle behavior

A one-second watcher uses session GetLastInputInfo and wrapping 32-bit tick subtraction. It checks
that Buddy's desktop is visible and honors the existing fullscreen preference. Only one startup is
allowed per input episode, including failed captures and readiness-watchdog exits. Concurrent manual
and automatic starts are serialized. Windows' normal display-off and sleep settings are unchanged.

## Evidence and verification

The investigation logs show repeated relay launches approximately 61 seconds apart. Their effect on
Windows power-manager idle accounting is the leading causal inference; it was not directly traced.
Manual overlay tests passed display/sleep timing, but also included a Windows-launched glmatrix.
The final automatic configuration therefore still needs its own unattended power test.

- `pnpm test`: frontend regressions, including screensaver capabilities.
- `rustc --test src-tauri/src/idle_episode.rs -o output/idle-episode-tests.exe`: independent timing,
  rollover, blocked fullscreen, and no-repeat-after-failure tests.
- `pwsh -File scripts/test-idle-recovery.ps1 -Exe <exe>`: real helper suppression/restoration,
  preserved registry values, external re-enable, and forced parent termination.
- Native compilation and frontend production build.
- `cargo test --lib` currently cannot start on this host: STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139).

For final power acceptance, set Buddy idle to one minute, Windows display-off to two minutes and
sleep to five, then run `scripts/probe-sleep.ps1 -Minutes 8` elevated without input. Confirm the
Buddy idle-start log, no Robo Buddy relay launches, display-off and an actual Windows sleep/resume
event. Sampling pauses while asleep, so do not require continuous samples beyond the sleep deadline.
Verify wake/input removes all layers and that quitting Buddy lets Windows run the original saver.

The separate ntdll heap-corruption crash remains undiagnosed; this redesign is not evidence of its fix.
