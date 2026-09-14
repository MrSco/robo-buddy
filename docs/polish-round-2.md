# Polish round two

Written 2026-09-14 against commit `f337b3a`, which is installed and running. Every file and line
reference below was checked against the working tree at that commit. Re-check them if the tree has
moved on.

Still no users beyond the author's machine, so no settings migration is needed anywhere here.

## Where round one landed

`f337b3a` is committed, the tree is clean, and 78 frontend tests pass. The installed executable in
`AppData\Local\Robo Buddy` matches the release build byte for byte and its stamp reads
`f337b3a 2026-09-14` with no dirty marker, so it was built from a clean tree per
[AGENTS.md](../AGENTS.md). All eight items from [polish-0.4.md](polish-0.4.md) landed, cracked
glass is the default, and the new physics and intensity settings have matching Rust fields and
clamps. The previous agent's own notes are in [polish-verification.md](polish-verification.md) and
are honest about what they did and did not prove.

Windows **do** break into pieces. That was briefly thought broken; it was hidden behind item 1
below.

---

## 1. Cutout masks are far too low resolution

**The headline bug.** Displaced windows have soft, blurry, stretched crack edges, and the blur is
heavy enough that it hides the shattering working correctly underneath it.

Two separate downscales stack up, and both get stretched back to full size at draw time.

| Stage | Raster size | Where |
|---|---|---|
| Source artwork | 250 to 384 px on the long side | `public/cracks/` |
| Cutout mask | 256 by 256, square, regardless of the window | [screensaver-fracture.ts:133](../src/screensaver-fracture.ts#L133) |
| Masked window content | capped at 640 px on the long side | [screensaver-fracture.ts:143](../src/screensaver-fracture.ts#L143) |
| Drawn at | the window's real size | [screensaver.ts:762](../src/screensaver.ts#L762) |

For a window about fourteen hundred pixels wide, the mask is stretched more than five times
horizontally and under three times vertically. It is forced square, so the crack shapes are
distorted as well as soft, and the window's own pixels are separately upscaled from the six
hundred and forty pixel cap.

**Recommended fix: make the boundary resolution independent.** Trace the artwork's alpha edge once
into a polygon, simplify it, cache it per texture, and clip with a path instead of compositing a
bitmap mask. A path scales to any window at any aspect ratio with no softness at all, and the
artwork stays the source of the shape. This is what the original plan called for; it was built as
a bitmap mask instead, which is the direct cause of the blur.

**Second, stop downscaling the window content.** The six hundred and forty pixel cap exists to
bound memory, but it applies to the intact window as well as to fragments. Only fragments need a
raster cap. Draw the displaced window from its original image, clipped to the traced path, and
leave the cap on `fractureImage` alone.

**If the path trace turns out to be too much work**, the fallback is to raise the mask raster and
give it the window's aspect ratio rather than a fixed square, which removes the distortion and most
of the softness for a lot less effort. Treat that as the compromise, not the target.

**Done when:** a displaced window has a crisp, correctly proportioned broken edge at any window
size, and its content is as sharp as it was on the desktop.

---

## 2. He gets stuck attacking empty space

He plants himself somewhere, often where a window used to be, and throws punches at nothing
indefinitely instead of moving on.

Two causes compound, both in the attack scheduler.

**An attack fires whether or not anything is in range.** In
[havoc.ts:61](../src/havoc.ts#L61) the nearest target may be undefined, and the code carries on
regardless, falling back to a random direction. So with nothing nearby he still commits to a full
attack, and will do so again as soon as the cooldown expires.

**Attacks starve the travel scheduler.** `free` is false for the whole duration of an attack, at
[main.ts:1045](../src/main.ts#L1045), so the behaviour scheduler cannot pick a walk, a charge or a
climb while one is playing. Only three seconds in every fourteen are reserved for uninterrupted
travel, at [havoc.ts:53](../src/havoc.ts#L53). At the shipped intensity the cooldown between
attacks is short enough that most of the remaining time is spent attacking, so he rarely gets far
enough to find a new target.

**Recommended fix:** require a target for most attacks. Keep shadow-boxing as an occasional flourish
rather than the default, for instance by only allowing a targetless attack after he has travelled
recently, or by capping consecutive targetless attacks and forcing a travel leg once the cap is
hit. Then widen the reserved travel window so a full attack cadence cannot consume it.

**Note the knock-on.** Each punch adds a fraction of the damage needed to shatter a window, at
[screensaver.ts:404](../src/screensaver.ts#L404), so a window needs several connected hits. While
he is shadow-boxing none of them land, which is why the shattering looked absent. Fixing this
should visibly increase how often windows come apart, with no change to the shatter code.

**Done when:** watching for a minute, he never throws more than a couple of unanswered punches
before moving, and he closes on windows rather than orbiting them.

---

## 3. The speech bubble shows nothing while transcribing

Half of a request from the previous session is still open. The chat input now keeps your words
while he answers, but the bubble never shows them, so with the talk box closed there is no feedback
anywhere that a recording was understood.

`bubble.listen()` already exists and is wired, but only to the live voice path at
[main.ts:632](../src/main.ts#L632). The Whisper path at [chat.ts:541](../src/chat.ts#L541) sets the
input value and returns without touching the bubble.

**Fix:** show the transcript through the same bubble path the live voice uses, and clear it when the
reply arrives. The machinery exists, so this is small.

**Done when:** speaking with the talk box closed puts the recognised words above his head.

---

## 4. Attack contact timing is a fixed fraction

Damage fires at a constant fraction through whichever attack clip is playing, defined at
[havoc.ts:1](../src/havoc.ts#L1). That is an approximation, not an authored contact point, and the
bundled attack clips run to noticeably different lengths, so the same fraction lands at a different
moment in each one.

**Decide by watching it** once item 2 is fixed and he is actually connecting. If one clip reads
clearly wrong, add a small per-clip contact table rather than tuning the shared constant, since
moving the constant trades one clip's accuracy for another's.

---

## 5. Vibe has never transcribed anything

The settings preset exists and writes an endpoint, but nothing has exercised a real request: no
model was loaded in Vibe when it was built. The port was taken from what was observed at the time
and is expected to change between runs.

**Needs you first.** Load a model in Vibe and enable its API server, then the preset can be checked
end to end. Until then this is untested code, not working code.

---

## 6. Release housekeeping

- **The version still says 0.4.0** despite a substantial feature commit, so the version no longer
  distinguishes this build from the previous one.
- **There is no installer for `f337b3a`.** The bundle on disk is the older one from the previous
  day. The current build was copied into place by hand, so nothing shippable matches what is
  running.
- **No rollback binary was kept.** The previous executable is not in the install directory or
  anywhere else I could find, so reverting means rebuilding from `c9abd51`.

**Do the version bump and regenerate the installer before any further feature work**, so that what
is running is identifiable and reproducible.

---

## 7. Verification debt

Carried forward from [polish-verification.md](polish-verification.md), none of it addressed since.

- **The screensaver smoke test used mocked native IPC.** An installed-build check of native
  permissions was called out as still needed.
- **No unattended display-off and sleep run for this build.** The earlier overnight success belongs
  to the pre-polish build, and `f337b3a` touched the simulation clock and the fullscreen pause,
  both adjacent to idle behaviour. Start this at the end of a session, since it costs a night
  either way.
- **Native unit tests have never run on this host.** They fail to launch with an entrypoint error,
  so `cargo check` passing is not evidence that they pass. Worth one attempt at diagnosing the
  launch failure, and worth writing off quickly if it is a toolchain problem rather than a code
  one.

---

## 8. Deferred, recorded so it is not rediscovered

- **Streaming partial words** during transcription. The current client returns text only after a
  completed recording, so partials need a different request shape.
- **Windows + H** is documented in a tooltip and a hint, deliberately, and is not an integration.
  Leaving it as documentation is the right call unless you want otherwise.

---

## Suggested order

1. **Cutout mask resolution** (1). It is the most visible problem, and it is currently hiding other
   work that is already correct, so everything is easier to judge afterwards.
2. **Stuck attacking** (2). Cheap relative to its impact, and it should make shattering visibly
   more frequent on its own.
3. **Bubble transcript** (3). Small, and it closes a request already made.
4. **Version bump and installer** (6). Do this before more features, not after.
5. **Verification debt** (7), with the overnight run started at the end of a session.
6. **Contact timing** (4) and **Vibe** (5) last, because both need a person watching or a model
   loaded rather than more code.

## Testing notes

Trigger the screensaver with the installed executable and `/s`, read state off the buddy window
title, and end it with a cursor sweep or a held key. Do not drive the mouse or keyboard to test
anything else. The idle lease is described in
[screensaver-idle-redesign.md](screensaver-idle-redesign.md); read it before changing anything near
it. Commit before building, and build from a clean tree, so the settings footer names the exact
commit.
