"""Bake a synthetic "wave" animation clip as a standalone GLB for a Mixamo-named rig.

The output contains only named empty nodes plus one animation, the same shape a
Mixamo FBX->GLB conversion produces, so it exercises the retarget-by-bone-name path.
Local rotations are derived from the target rig's rest pose so the clip is correct
for that skeleton.

Usage: python scripts/make_wave_clip.py public/characters/rocco/rocco.glb public/characters/rocco/clips/wave.glb
"""
import json
import math
import struct
import sys


def q_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def q_inv(q):
    x, y, z, w = q
    return (-x, -y, -z, w)


def q_rotate_vec(q, v):
    qv = (v[0], v[1], v[2], 0.0)
    r = q_mul(q_mul(q, qv), q_inv(q))
    return (r[0], r[1], r[2])


def q_axis_angle(axis, angle):
    n = math.sqrt(sum(a * a for a in axis)) or 1.0
    s = math.sin(angle / 2)
    return (axis[0] / n * s, axis[1] / n * s, axis[2] / n * s, math.cos(angle / 2))


def read_glb(path):
    with open(path, "rb") as f:
        f.read(12)
        clen, _ = struct.unpack("<II", f.read(8))
        return json.loads(f.read(clen))


def main(rig_path, out_path):
    rig = read_glb(rig_path)
    nodes = rig["nodes"]
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i
    by_name = {n.get("name", ""): i for i, n in enumerate(nodes)}

    def local_q(i):
        return tuple(nodes[i].get("rotation", [0, 0, 0, 1]))

    def world_q(i):
        q = local_q(i)
        p = parent.get(i)
        return q_mul(world_q(p), q) if p is not None else q

    def find(short):
        for cand in (f"mixamorig:{short}", f"mixamorig{short}"):
            if cand in by_name:
                return by_name[cand]
        raise SystemExit(f"bone {short} not found")

    def rotate_world(node, axis, angle, base_local):
        """Same maths as pose.ts rotateWorld: rotate about a world axis, expressed in parent space."""
        p = parent.get(node)
        pw = world_q(p) if p is not None else (0, 0, 0, 1)
        axis_local = q_rotate_vec(q_inv(pw), axis)
        return q_mul(q_axis_angle(axis_local, angle), base_local)

    targets = {
        "RightArm": find("RightArm"),
        "RightForeArm": find("RightForeArm"),
        "Head": find("Head"),
        "Spine1": find("Spine1"),
    }

    fps, dur = 30, 2.0
    frames = int(dur * fps) + 1
    times = [i / fps for i in range(frames)]
    tracks = {k: [] for k in targets}
    Z = (0, 0, 1)
    X = (1, 0, 0)
    for t in times:
        env = min(1.0, t / 0.35) * min(1.0, (dur - t) / 0.4)  # raise, hold, lower
        env = env * env * (3 - 2 * env)
        raise_angle = -1.35 * env  # right arm from T-pose up toward vertical
        wave = 0.55 * math.sin(t * math.tau * 2.5) * env
        tracks["RightArm"].append(rotate_world(targets["RightArm"], Z, raise_angle, local_q(targets["RightArm"])))
        tracks["RightForeArm"].append(rotate_world(targets["RightForeArm"], Z, -0.6 * env + wave, local_q(targets["RightForeArm"])))
        tracks["Head"].append(rotate_world(targets["Head"], Z, -0.18 * env, local_q(targets["Head"])))
        tracks["Spine1"].append(rotate_world(targets["Spine1"], X, 0.0, local_q(targets["Spine1"])))

    # Build a minimal glTF: flat named nodes (Mixamo names), one animation.
    out_nodes = []
    name_to_out = {}
    for short, idx in targets.items():
        name_to_out[short] = len(out_nodes)
        out_nodes.append({"name": nodes[idx]["name"]})

    bin_parts = []
    buffer_views = []
    accessors = []

    def add_accessor(data, comp_type, type_, count, minmax=None):
        offset = sum(len(b) for b in bin_parts)
        bin_parts.append(data)
        buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data)})
        acc = {"bufferView": len(buffer_views) - 1, "componentType": comp_type, "count": count, "type": type_}
        if minmax:
            acc["min"], acc["max"] = minmax
        accessors.append(acc)
        return len(accessors) - 1

    time_acc = add_accessor(struct.pack(f"<{frames}f", *times), 5126, "SCALAR", frames, ([times[0]], [times[-1]]))
    samplers, channels = [], []
    for short, quats in tracks.items():
        flat = [c for q in quats for c in q]
        acc = add_accessor(struct.pack(f"<{len(flat)}f", *flat), 5126, "VEC4", frames)
        samplers.append({"input": time_acc, "output": acc, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": name_to_out[short], "path": "rotation"}})

    bin_blob = b"".join(bin_parts)
    bin_blob += b"\0" * ((4 - len(bin_blob) % 4) % 4)
    gltf = {
        "asset": {"version": "2.0", "generator": "robo-buddy make_wave_clip"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(out_nodes)))}],
        "nodes": out_nodes,
        "animations": [{"name": "Wave", "samplers": samplers, "channels": channels}],
        "buffers": [{"byteLength": len(bin_blob)}],
        "bufferViews": buffer_views,
        "accessors": accessors,
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_blob)
    with open(out_path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(bin_blob), 0x004E4942) + bin_blob)
    print(f"wrote {out_path}: {frames} frames, {len(channels)} channels")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
