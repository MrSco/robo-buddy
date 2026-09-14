# Polish verification — 2026-09-14

Implemented the approved choices in polish-0.4.md: cracks by default; guarded preview feedback;
confirmation before discarding personality edits; fullscreen simulation pause with conversations
continuing; Buddy gravity/bounce/throw controls; intensity-driven attacks; artwork-derived window
masks; bounded interactive debris that never enters the climbable-surface list.

Additional requests: damage is delayed to 80% of the selected attack clip (a contact approximation,
not authored per-animation markers). Procedural strikes peak at the same point; charging is suppressed
during strikes. Transcribed text remains in the input while a reply is pending. A Vibe quick setup
uses the existing compatible transcription client and editable endpoint.

## Checks

- 78 frontend tests pass, including settings contract/defaults, gravity/bounce/throw extremes,
  pinned grip, paused simulation deadlines, single-contact attacks, and thirty simulated minutes
  of bounded debris allocation and retirement.
- TypeScript compilation and frontend production build pass. Native `cargo check` passes.
- Browser UI with isolated settings: dirty personality Cancel preserves edits; Discard refreshes
  the editor; Vibe preset saves its endpoint. The author's real settings were not changed.
- Browser preview: superseded success cannot clear a newer spinner; success, error, and stop
  all terminate their own loading state correctly.
- `scripts/screensaver-browser-smoke.js`: all three monitor positions produce punch debris;
  CRT dot belongs only to the primary screen; void is opaque and unstandable; restore clears
  debris and restores window surfaces. This uses mocked native IPC; native permissions also
  have regression coverage and require an installed-build smoke check.
- Browser canvas exercise of all 13 supplied textures produced 2–8 fragments per texture.
  Ten simulated minutes: maximum 48 bodies and 1,428,685 retained image pixels on one monitor;
  95th-percentile update cost below 0.1 ms, worst measured update 16.5 ms after mask warmup.
  These are browser simulation measurements, not whole-desktop GPU or overnight measurements.
  Limits are per monitor: 48 bodies and 2.5 million retained debris pixels (roughly 10 MB RGBA).
  Old pieces fade after 35 seconds, sooner under pressure; hard allocation limits evict oldest
  untouched pieces if necessary. Restore releases their canvases.

## Vibe and dictation

The provided port 60151 was unavailable; the screenshot's port 51136 served OpenAPI documentation.
It exposes `/v1/audio/transcriptions`, already compatible with the existing multipart client.
The model list was empty. Load a model in Vibe and enable its API server, then select the Vibe setup
and adjust the endpoint port if needed. No model was loaded or changed by this work. End-to-end
speech recognition against a loaded Vibe model remains to be checked. The existing chat provider
and credentials remain separate from an independently configured speech endpoint.

Windows + H is documented as a way to type into the focused chat box, followed by Send. It is not
an embedded STT backend, and Robo Buddy does not synthesize the Windows shortcut. Transcription
is returned after a completed recording; streaming partial words are a future enhancement.

## Release limits

The resident idle trigger, saver guard and power handling were left intact. The earlier overnight
success belongs to the pre-polish build; another unattended display-off/sleep run is still needed
for this build. Native unit-test executables previously failed to launch on this host with
STATUS_ENTRYPOINT_NOT_FOUND; native compilation is not a claim that those tests ran.
