"""Wrap a Mixamo-rigged GLB as a VRM 1.0 file by adding the VRMC_vrm extension.

Usage: python scripts/glb_to_vrm.py in.glb out.vrm "Name" "Author"
Only the humanoid map + meta are written; the mesh, skin and textures are untouched.
"""
import json, struct, sys

MIXAMO_TO_VRM = {
    "Hips": "hips", "Spine": "spine", "Spine1": "chest", "Spine2": "upperChest",
    "Neck": "neck", "Head": "head",
    "LeftShoulder": "leftShoulder", "LeftArm": "leftUpperArm", "LeftForeArm": "leftLowerArm", "LeftHand": "leftHand",
    "RightShoulder": "rightShoulder", "RightArm": "rightUpperArm", "RightForeArm": "rightLowerArm", "RightHand": "rightHand",
    "LeftUpLeg": "leftUpperLeg", "LeftLeg": "leftLowerLeg", "LeftFoot": "leftFoot", "LeftToeBase": "leftToes",
    "RightUpLeg": "rightUpperLeg", "RightLeg": "rightLowerLeg", "RightFoot": "rightFoot", "RightToeBase": "rightToes",
}
for side in ("Left", "Right"):
    s = side.lower()
    MIXAMO_TO_VRM[f"{side}HandThumb1"] = f"{s}ThumbMetacarpal"
    MIXAMO_TO_VRM[f"{side}HandThumb2"] = f"{s}ThumbProximal"
    MIXAMO_TO_VRM[f"{side}HandThumb3"] = f"{s}ThumbDistal"
    for finger in ("Index", "Middle", "Ring", "Pinky"):
        f = finger.lower() if finger != "Pinky" else "little"
        MIXAMO_TO_VRM[f"{side}Hand{finger}1"] = f"{s}{f.capitalize()}Proximal"
        MIXAMO_TO_VRM[f"{side}Hand{finger}2"] = f"{s}{f.capitalize()}Intermediate"
        MIXAMO_TO_VRM[f"{side}Hand{finger}3"] = f"{s}{f.capitalize()}Distal"

def strip(name: str) -> str:
    for p in ("mixamorig:", "mixamorig"):
        if name.startswith(p):
            return name[len(p):]
    return name

def main(src, dst, name, author):
    with open(src, "rb") as f:
        magic, ver, length = struct.unpack("<III", f.read(12))
        assert magic == 0x46546C67, "not a GLB"
        clen, ctype = struct.unpack("<II", f.read(8))
        g = json.loads(f.read(clen))
        rest = f.read()  # remaining chunks (BIN)
    human = {}
    for i, n in enumerate(g.get("nodes", [])):
        vrm = MIXAMO_TO_VRM.get(strip(n.get("name", "")))
        if vrm:
            human[vrm] = {"node": i}
    required = ["hips","spine","head","leftUpperArm","leftLowerArm","leftHand","rightUpperArm","rightLowerArm",
                "rightHand","leftUpperLeg","leftLowerLeg","leftFoot","rightUpperLeg","rightLowerLeg","rightFoot"]
    missing = [b for b in required if b not in human]
    if missing:
        sys.exit(f"missing required bones: {missing}")
    g.setdefault("extensionsUsed", [])
    if "VRMC_vrm" not in g["extensionsUsed"]:
        g["extensionsUsed"].append("VRMC_vrm")
    g.setdefault("extensions", {})["VRMC_vrm"] = {
        "specVersion": "1.0",
        "meta": {
            "name": name, "version": "1", "authors": [author],
            "licenseUrl": "https://vrm.dev/licenses/1.0/",
            "avatarPermission": "onlyAuthor", "allowExcessivelyViolentUsage": False,
            "allowExcessivelySexualUsage": False, "commercialUsage": "personalNonProfit",
            "allowPoliticalOrReligiousUsage": False, "allowAntisocialOrHateUsage": False,
            "creditNotation": "required", "allowRedistribution": False, "modification": "prohibited",
        },
        "humanoid": {"humanBones": human},
    }
    js = json.dumps(g, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    out = struct.pack("<IIII", 0x46546C67, 2, 12 + 8 + len(js) + len(rest), len(js)) + b"JSON" + js + rest
    with open(dst, "wb") as f:
        f.write(out)
    print(f"wrote {dst}: {len(human)} humanoid bones mapped")

if __name__ == "__main__":
    main(*sys.argv[1:5])
