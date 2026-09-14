# Polish pass after 0.4.0

Reviewed against c9abd51. Updated 2026-09-14 with the author's answers to the eleven review questions.
This is the agreed plan, not a record of implemented changes.

Eight items. No settings migration framework is needed. Changing defaults does not overwrite values
already present in settings.json; use an isolated test profile instead of deleting the author's settings.
Preserve the working resident idle trigger, Windows saver recovery, display-off, sleep, and cleanup.
The author reports successful automatic launch, display-off, sleep, and no overnight crash after the redesign.

## 1. Cracked glass becomes the default

Author choice 11A: cracks by default; keep ambient erosion slow. Do not increase erosion speed as part
of this pass. The author's verified saved erosion speed was 1%, not near the fast end.

Update DEFAULT_SETTINGS in src/settings-store.ts, Rust Settings::default in src-tauri/src/settings.rs,
the control fallback in src/settings.ts, and the module initializer in src/screensaver.ts together.
Keep tiles available. The settings contract test currently checks field names, not equality of default
values: add an explicit default regression check rather than assuming the existing test catches drift.

Done when: a fresh isolated profile starts with cracks, saved choices remain respected, and ambient
speed has not changed.

## 2. Loading feedback in preview panes

src/preview.ts LivePreview.show awaits character loading without feedback. Share one loading helper
across character, library and capture previews; support both 2D and 3D loads. Clear loading on success
or failure only when the request still owns the current token. A superseded request must never clear
the new request's spinner. Handle stop/disposal and show a useful failure message instead of a blank pane.
Include asynchronous clip loading where it otherwise leaves the library preview appearing unresponsive.

Done when: heavy loads show feedback, rapid selections resolve to the latest choice, failed loads do
not spin forever, and stopping or leaving a preview does not leave stale loading state.

## 3. Personality editor follows the dropdown without silent data loss

Author choice 1B: ask before discarding unsaved edits. Replace the previous silent-reload decision.

The src/settings.ts personality change handler currently commits the selection without refreshing
an open editor. Track whether editable fields differ from their saved baseline. If dirty, ask before
switching: Discard and switch, or Cancel. Cancel preserves the previous dropdown selection, active
personality and all edits. Confirm first, then commit the selected profile and call showEditor.
No prompt when nothing changed. Save remains the way to persist profile edits.

Done when: clean switches refresh the editor immediately; cancelling a dirty switch preserves both
profile and edits; confirming loads the new profile. Imported-character profiles and read-only built-ins
must retain their existing save/copy behavior.

## 4. Quiet fullscreen hiding with exact resume

Author choices 4A and 5C: silence incidental effects and idle chatter, but let an explicitly started
conversation continue. Freeze Buddy where he is and resume from there, including midair. Choice 5C
was tentative, but is the selected behavior; do not silently substitute settling to the floor.

src/main.ts applyVisibility currently hides the window but the reduced-rate loop still advances physics
and behavior. Pause autonomous movement, physics, animation progression and incidental sound while hidden.
Keep active conversation processing and native idle detection working. Account for paused simulation
time so deadlines and animation clocks do not jump forward when visibility returns. Do not replay
queued idle chatter or hidden-time impacts. Revalidate support if a previously supporting window vanished;
avoid leaving him suspended on an invalid perch. Screensaver mode remains excluded from fullscreen hiding.

Done when: no incidental hidden-time sounds or movement; active conversations continue; a mid-throw
hide resumes the same flight without a large time step; changed window geometry is handled safely.

## 5. Adjustable screensaver havoc

Author choice 6: combine frequent bursts of jumping and striking with continued roaming, and add an
intensity control. Default should be more continuously aggressive than current behavior, without
abandoning exploration across all monitors. Exact numeric weights are implementation tuning, not an
already-approved specific value.

Add jump-and-punch, airborne strikes, untargeted leaps, and more frequent attacks while moving. Reduce
uneventful walking without removing travel to new targets. Coordinate with the debris interactions in
item 7. Provide graceful behavior for character packs lacking a particular attack animation.

This is not pure weighting in behavior.ts: main.ts currently marks autonomous behavior free only when
grounded. Coordinate physics, action eligibility, animation priority and impact timing. A strike should
apply its impact once at contact, not repeatedly every frame. Do not regress perch escape or dance limits.

Done when: a minute of viewing shows frequent attacks and leaps plus continued travel; changing
intensity visibly changes activity; airborne attacks do not strand him or repeatedly apply one hit.

## 6. Cutout geometry follows the supplied crack artwork

Author choice 7A: use the existing supplied crack artwork as the source of the broken outline.
Do not replace it with an unrelated procedural jagged polygon decorated with decals.

Derive/cache masks and, where necessary, simplified contours from the artwork. Share the exact local
shape between the moving window cutout and the hole left behind. Include the initial desktop hole
construction (currently clearRect near src/screensaver.ts:136), not only the sprite draw and later
edge decoration. Account for overlap, rotation, existing damage and image bounds. Preserve the artwork's
glass detail. Reuse cached geometry through frames and the restore cycle rather than regenerating it.

Done when: sprite and hole match the crack artwork and each other, including rotated pieces, without
rectangular remnants, mismatched gaps, flicker, or per-frame mask rebuilding.

## 7. Shattering and interactive debris

Author choices 8, 9 and 10: havoc from all the proposed causes; persistent piles with performance cleanup;
Buddy can punch, kick, throw and otherwise interact with debris, but cannot climb it.

Punches should cause damage and shed pieces; heavy hits and hard landings can break a window apart
immediately; repeated lighter impacts accumulate toward full failure. Do not interpret the combination
as requiring every light punch to instantly delete the entire window. Keep enough objects in play for
continued interaction. Pieces inherit parent motion plus a bounded impact impulse, with image regions
and boundaries derived from the crack artwork.

The existing punchSprite only measures damage; it does not create shard bodies. The Tile animation
integrates falling motion and removes offscreen tiles; it does not floor-test and settle debris. Reuse
appropriate math, but add explicit shard state, floor collision, settling and lifecycle handling.

Debris is damageable/attackable separately from standable surfaces. Do not simply remove pieces from
all interaction data when excluding them from climbing. Add targeting and hit handling for punches,
kicks and throws, including fragments already lying on the floor. No climbing, even on large fragments.

Pieces may pile up until restore, but can fade after a while to maintain performance. Bound active body
count and retained image memory; let resting bodies sleep; use cached masks and spatially limited
interaction checks. Prefer fading old, settled, unengaged debris before removing a piece Buddy is
currently handling. Exact age/count budgets should be selected from measurements on all three monitors.
Clean up bitmap/canvas resources when pieces retire. Restore clears all debris and reconstructs intact
windows without retaining old collision targets.

Done when: punches, hard landings and accumulated damage all contribute to visible shattering; Buddy
can punch, kick and throw fragments but never climb them; prolonged multi-monitor havoc has bounded
body count and memory; restore returns intact windows and clears all debris.

## 8. Buddy physics controls

Author choices 2B and 3A: Gravity, Bounciness, Throw strength, and Reset. No floor-friction slider.
The controls affect Buddy in BOTH desktop and screensaver modes. Window sprites and debris keep
separate heavy-object physics. Preserve current Buddy physics as the reset baseline.

Replace relevant constants in src/physics.ts with validated instance settings. Gravity must also feed
jump calculations; throw strength applies to release velocity without moving the fixed grip point.
Keep reasonable limits and preserve the current reduced bounce as the default. Add corresponding Rust
fields/defaults and TypeScript fields/defaults, wire updates into the existing physics instance, and
verify persistence. Field order is not what makes the settings contract test work; matching names are.

Done when: the three sliders immediately affect Buddy in either mode, survive reopening/restarting,
Reset restores current baseline behavior, and window/debris physics remain independent. Verify jump
reach, landing stability and grip behavior at slider extremes.

## Implementation order

1. Cracks default and preview feedback.
2. Personality switching and fullscreen pause/resume.
3. Buddy physics controls, then aggression controls and coordinated airborne attacks.
4. Artwork-derived cutouts, shard lifecycle and debris interactions together; these share geometry,
   damage and targeting structures. Integrate attack behavior from item 5 with these targets.

## Verification and release

Use the tray/context-menu Screensaver now for visual testing, and the actual idle trigger for power
regression testing. The installed executable's /s argument no longer starts the overlay after the idle
redesign. Validate all three monitor layouts, input dismissal, CRT/restore synchronization, and cleanup.

Run frontend tests, settings persistence/default checks, and targeted behavior/physics regressions.
Exercise rapid preview-load success/failure races and both outcomes of the unsaved-edit prompt.
Measure a sustained high-intensity debris run; do not accept a short animation as proof of bounded
memory or acceptable performance. Repeat unattended display-off/sleep verification after this pass.

Follow AGENTS.md: commit finished changes before building an installed executable, use a clean tree
with ROBO_BUILD_STRICT=1, rebuild frontend and native code after the commit, then install that build.
