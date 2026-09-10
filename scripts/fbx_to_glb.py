"""Convert Mixamo FBX animations (downloaded "Without Skin") to GLB with Blender, headless.

Usage:
  blender -b --python scripts/fbx_to_glb.py -- OUT_DIR file1.fbx [file2.fbx ...]

Each FBX becomes OUT_DIR/<name>.glb containing the Mixamo-named armature and its
animation, ready for scripts/retarget_clips.py --map=mixamo --ref=.
"""
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :]
out_dir, files = argv[0], argv[1:]
os.makedirs(out_dir, exist_ok=True)

for path in files:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False, ignore_leaf_bones=True)
    # Name the action after the file so the clip name survives export.
    name = os.path.splitext(os.path.basename(path))[0]
    for obj in bpy.data.objects:
        if obj.animation_data and obj.animation_data.action:
            obj.animation_data.action.name = name
    out = os.path.join(out_dir, f"{name}.glb")
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_animations=True,
        export_skins=True,
        export_apply=True,
        export_yup=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_frame_step=1,
    )
    print(f"converted {path} -> {out}")
