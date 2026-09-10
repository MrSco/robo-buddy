# Adding dances and other clips

Robo Buddy plays clips from the shared library in `public/clips/` and from a pack's own
`clips` folder. Every clip is a small GLB with Mixamo-named bones and one animation, baked
for a T-posed Mixamo skeleton (Rocco's rig). `scripts/retarget_clips.py` produces them.

## What ships today

`public/clips/ual/` is the free Standard tier of the Quaternius Universal Animation Library
(CC0), retargeted from its Unreal-style rig. It has good idles, walks, a jump, hits, a kneel,
punches, a roll and exactly **one** dance (`Dance_Loop`, a one-second loop). The Pro tier
($9.99, same license) adds ~80 more clips including several dances; bake it the same way:

```bash
python scripts/retarget_clips.py "UAL1_Pro.glb" public/characters/rocco/rocco.glb public/clips/ual
```

## Mixamo dances (free, needs an Adobe login)

Mixamo cannot be scripted, so the flow is manual:

1. On mixamo.com pick any character, search the animation, and download as **FBX Binary,
   Without Skin, 30 fps**.
2. Convert the FBX to GLB (Blender: File > Import > FBX, then File > Export > glTF 2.0,
   animation on). Any FBX->glTF tool works.
3. Bake it onto the buddy rig so the rest pose and hips height match:
   ```bash
   python scripts/retarget_clips.py "Hip Hop Dancing.glb" public/characters/rocco/rocco.glb public/clips/mixamo --map=mixamo --ref=
   ```
   (`--ref=` empty means "use the file's rest pose as the T-pose reference", which is what a
   Mixamo export gives you.)
4. Reference it from a pack manifest and add it to the `dances` list:
   ```json
   "clips": { "hiphop": "/clips/mixamo/Hip Hop Dancing.glb" },
   "dances": ["dance", "hiphop", "procedural"]
   ```
   Set `beatsPerLoop` on the `dance` state to how many beats one loop of the clip spans so
   it stays on the music's tempo.

## Fortnite emotes and their nearest Mixamo searches

Mixamo has no licensed Fortnite emotes, but these searches land close:

| Emote | Mixamo search |
|---|---|
| Default Dance | "Hip Hop Dancing", "Silly Dancing" |
| Floss | (no direct match) "Wave Hip Hop Dance" |
| Orange Justice | "Snake Hip Hop Dance", "Shuffling" |
| Take the L | "Loser" (idle), "Taunt" |
| Dab | "Dab" is not on Mixamo; "Salute" then a custom pose |
| Fresh (Carlton) | "Swing Dancing" |
| Electro Shuffle | "Shuffling", "Running Man" |
| Best Mates | "Jazz Dancing" |
| Boogie Down / Groove Jam | "Rumba Dancing", "Samba Dancing" |
| Hype | "Ymca Dance", "Arms Hip Hop Dance" |
| Infinite Dab | "Dancing Twerk" (ironic), "Salsa Dancing" |
| Robot | "Robot Hip Hop Dance" |
| Twist | "Twist Dance" |
| Breakdance | "Breakdance 1990", "Breakdance Freeze", "Flair" |
| Chicken | "Chicken Dance" |
| Zany | "Silly Dancing", "Wave Hip Hop Dance" |

Idles worth grabbing while you are there: "Idle", "Breathing Idle", "Happy Idle",
"Bored", "Looking Around", "Standing Arguing", "Texting While Standing", "Sitting".

## Dance selection

Settings > Dance: "Random each time" picks from the pack's `dances` list per song,
"Built-in groove" forces the procedural dance, or pick one clip for a deterministic buddy.

## Clips must animate the whole skeleton

During a crossfade three.js blends any bone a clip does not animate toward the rest
T-pose, which shows up as an arm snapping out for a frame or two. Bake clips from a
source that keys every bone (Mixamo and Quaternius both do). Partial clips such as the
synthetic `wave.glb` are fine for tests but should not be used as reactions.
