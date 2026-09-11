"""Retarget animation clips from one humanoid rig to a Mixamo-named rig and bake them
as standalone GLB clip files (flat Mixamo-named nodes + one animation each).

Method: for every mapped bone, take the source bone's world-space rotation change
relative to its reference pose (a T-pose) and apply that change to the target bone's
reference world rotation, then convert back to the target's local space. Hips
translation is transferred as a world-space offset scaled by the two rigs' hip heights.

Usage:
  python scripts/retarget_clips.py SOURCE.glb TARGET_RIG.glb OUT_DIR [--ref A_TPose] [--map ue] [clip names...]
Without clip names every animation in the source is baked.
"""
import json
import math
import os
import struct
import sys

# ---------------------------------------------------------------- glb / accessors

COMP = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NUM = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(path):
    with open(path, "rb") as f:
        magic, _, _ = struct.unpack("<III", f.read(12))
        assert magic == 0x46546C67, f"{path} is not a GLB"
        clen, _ = struct.unpack("<II", f.read(8))
        g = json.loads(f.read(clen))
        blen, btype = struct.unpack("<II", f.read(8))
        bin_ = f.read(blen) if btype == 0x004E4942 else b""
    return g, bin_


def read_accessor(g, bin_, idx):
    acc = g["accessors"][idx]
    bv = g["bufferViews"][acc["bufferView"]]
    fmt, size = COMP[acc["componentType"]]
    n = NUM[acc["type"]]
    stride = bv.get("byteStride", size * n)
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    out = []
    for i in range(acc["count"]):
        off = base + i * stride
        vals = struct.unpack_from("<" + fmt * n, bin_, off)
        if acc.get("normalized"):
            m = float(2 ** (size * 8 - 1) - 1) if fmt.islower() else float(2 ** (size * 8) - 1)
            vals = tuple(v / m for v in vals)
        out.append(vals[0] if n == 1 else vals)
    return out


# ---------------------------------------------------------------- math

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
    return (-q[0], -q[1], -q[2], q[3])


def q_norm(q):
    n = math.sqrt(sum(c * c for c in q)) or 1.0
    return tuple(c / n for c in q)


def q_rot(q, v):
    r = q_mul(q_mul(q, (v[0], v[1], v[2], 0.0)), q_inv(q))
    return (r[0], r[1], r[2])


def q_slerp(a, b, t):
    d = sum(x * y for x, y in zip(a, b))
    if d < 0:
        b = tuple(-c for c in b)
        d = -d
    if d > 0.9995:
        return q_norm(tuple(x + (y - x) * t for x, y in zip(a, b)))
    th = math.acos(d)
    s = math.sin(th)
    wa, wb = math.sin((1 - t) * th) / s, math.sin(t * th) / s
    return tuple(x * wa + y * wb for x, y in zip(a, b))


def q_axis_angle(axis, ang):
    s = math.sin(ang / 2)
    return (axis[0] * s, axis[1] * s, axis[2] * s, math.cos(ang / 2))


def v_add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def v_sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def v_mul(a, b):
    return tuple(x * y for x, y in zip(a, b))


# ---------------------------------------------------------------- rig

class Rig:
    def __init__(self, g, bin_):
        self.g, self.bin = g, bin_
        self.nodes = g["nodes"]
        self.names = [n.get("name", "") for n in self.nodes]
        self.parent = {}
        for i, n in enumerate(self.nodes):
            for c in n.get("children", []):
                self.parent[c] = i
        # topological order: parents before children
        self.order = []
        seen = set()

        def visit(i):
            if i in seen:
                return
            p = self.parent.get(i)
            if p is not None:
                visit(p)
            seen.add(i)
            self.order.append(i)

        for i in range(len(self.nodes)):
            visit(i)
        self.by_name = {n: i for i, n in enumerate(self.names)}

    def rest(self, i):
        n = self.nodes[i]
        return (
            tuple(n.get("translation", [0, 0, 0])),
            tuple(n.get("rotation", [0, 0, 0, 1])),
            tuple(n.get("scale", [1, 1, 1])),
        )

    def world(self, local):
        """local: {node: (t, r, s)} -> {node: (pos, rot, scale)} world transforms."""
        out = {}
        for i in self.order:
            t, r, s = local[i]
            p = self.parent.get(i)
            if p is None:
                out[i] = (t, r, s)
            else:
                pp, pr, ps = out[p]
                out[i] = (v_add(pp, q_rot(pr, v_mul(ps, t))), q_norm(q_mul(pr, r)), v_mul(ps, s))
        return out

    def find(self, *cands):
        for c in cands:
            if c in self.by_name:
                return self.by_name[c]
        return None


class Anim:
    def __init__(self, rig, anim):
        self.rig = rig
        self.name = anim["name"]
        self.tracks = {}  # (node, path) -> (times, values)
        self.duration = 0.0
        for ch in anim["channels"]:
            s = anim["samplers"][ch["sampler"]]
            times = read_accessor(rig.g, rig.bin, s["input"])
            vals = read_accessor(rig.g, rig.bin, s["output"])
            if s.get("interpolation") == "CUBICSPLINE":
                vals = vals[1::3]  # keep the value, drop the tangents
            self.tracks[(ch["target"]["node"], ch["target"]["path"])] = (times, vals)
            self.duration = max(self.duration, times[-1])

    def sample(self, node, path, t):
        tr = self.tracks.get((node, path))
        if not tr:
            return None
        times, vals = tr
        if t <= times[0]:
            return vals[0]
        if t >= times[-1]:
            return vals[-1]
        lo, hi = 0, len(times) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if times[mid] <= t:
                lo = mid
            else:
                hi = mid
        f = (t - times[lo]) / (times[hi] - times[lo]) if times[hi] > times[lo] else 0.0
        a, b = vals[lo], vals[hi]
        if path == "rotation":
            return q_slerp(q_norm(a), q_norm(b), f)
        return tuple(x + (y - x) * f for x, y in zip(a, b))

    def local_at(self, t):
        local = {}
        for i in range(len(self.rig.nodes)):
            rt, rr, rs = self.rig.rest(i)
            local[i] = (
                self.sample(i, "translation", t) or rt,
                self.sample(i, "rotation", t) or rr,
                self.sample(i, "scale", t) or rs,
            )
        return local


# ---------------------------------------------------------------- bone maps

def ue_map():
    m = {
        "pelvis": "Hips", "spine_01": "Spine", "spine_02": "Spine1", "spine_03": "Spine2",
        "neck_01": "Neck", "Head": "Head",
    }
    for s, S in (("l", "Left"), ("r", "Right")):
        m[f"clavicle_{s}"] = f"{S}Shoulder"
        m[f"upperarm_{s}"] = f"{S}Arm"
        m[f"lowerarm_{s}"] = f"{S}ForeArm"
        m[f"hand_{s}"] = f"{S}Hand"
        m[f"thigh_{s}"] = f"{S}UpLeg"
        m[f"calf_{s}"] = f"{S}Leg"
        m[f"foot_{s}"] = f"{S}Foot"
        m[f"ball_{s}"] = f"{S}ToeBase"
        for src, dst in (("thumb", "Thumb"), ("index", "Index"), ("middle", "Middle"), ("ring", "Ring"), ("pinky", "Pinky")):
            for k in (1, 2, 3):
                m[f"{src}_0{k}_{s}"] = f"{S}Hand{dst}{k}"
    return m


def mixamo_map():
    """Mixamo-named source (e.g. a Mixamo FBX converted to GLB): identity names, prefix optional."""
    names = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"]
    for S in ("Left", "Right"):
        names += [f"{S}Shoulder", f"{S}Arm", f"{S}ForeArm", f"{S}Hand", f"{S}UpLeg", f"{S}Leg", f"{S}Foot", f"{S}ToeBase"]
        for f in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
            names += [f"{S}Hand{f}{k}" for k in (1, 2, 3)]
    m = {}
    for n in names:
        m[f"mixamorig:{n}"] = n
        m[f"mixamorig{n}"] = n
        m[n] = n
    return m


MAPS = {"ue": ue_map, "mixamo": mixamo_map}


def target_index(rig, short):
    return rig.find(f"mixamorig:{short}", f"mixamorig{short}")


# ---------------------------------------------------------------- baking

def bake(src_rig, tgt_rig, clip, src_ref_world, tgt_ref_world, bone_map, fps=30):
    """Return {mixamo_short: [quats]} local rotations and hips [positions] per frame."""
    frames = max(2, int(round(clip.duration * fps)) + 1)
    times = [min(clip.duration, i / fps) for i in range(frames)]

    # Facing fix: if the source T-pose has the left hand at -X, it faces the other way.
    src_l = src_rig.find("hand_l", "mixamorig:LeftHand", "mixamorigLeftHand", "LeftHand")
    flip = src_l is not None and src_ref_world[src_l][0][0] < 0
    yaw180 = q_axis_angle((0, 1, 0), math.pi) if flip else (0, 0, 0, 1)

    tgt_rest_local = {i: tgt_rig.rest(i) for i in range(len(tgt_rig.nodes))}
    mapped = {}  # target node -> source node
    for s_name, short in bone_map.items():
        si = src_rig.find(s_name)
        ti = target_index(tgt_rig, short)
        if si is not None and ti is not None:
            mapped[ti] = si
    tgt_hips = target_index(tgt_rig, "Hips")
    src_hips = src_rig.find("pelvis", "mixamorig:Hips", "mixamorigHips", "Hips", "hips")
    h_ratio = 1.0
    if tgt_hips is not None and src_hips is not None:
        sh = src_ref_world[src_hips][0][1]
        th = tgt_ref_world[tgt_hips][0][1]
        h_ratio = th / sh if abs(sh) > 1e-6 else 1.0

    rot_tracks = {ti: [] for ti in mapped}
    hips_pos = []
    for t in times:
        src_world = src_rig.world(clip.local_at(t))
        world_rot = {}
        world_pos = {}
        for ti in tgt_rig.order:
            rt, rr, rs = tgt_rest_local[ti]
            p = tgt_rig.parent.get(ti)
            p_pos, p_rot = (world_pos.get(p, (0, 0, 0)), world_rot.get(p, (0, 0, 0, 1)))
            if ti in mapped:
                si = mapped[ti]
                delta = q_mul(q_mul(yaw180, src_world[si][1]), q_inv(q_mul(yaw180, src_ref_world[si][1])))
                w = q_norm(q_mul(delta, tgt_ref_world[ti][1]))
                local = q_norm(q_mul(q_inv(p_rot), w))
                # Keep consecutive keyframes on the same hemisphere so slerp never takes
                # the long way round (a one-frame twist that reads as a flicker).
                prev = rot_tracks[ti][-1] if rot_tracks[ti] else None
                if prev is not None and sum(a * b for a, b in zip(prev, local)) < 0:
                    local = tuple(-c for c in local)
                rot_tracks[ti].append(local)
                pos_local = rt
                if ti == tgt_hips and src_hips is not None:
                    off = v_sub(src_world[src_hips][0], src_ref_world[src_hips][0])
                    off = q_rot(yaw180, off)
                    off = tuple(c * h_ratio for c in off)
                    off_local = q_rot(q_inv(p_rot), off)
                    pos_local = v_add(rt, off_local)
                    hips_pos.append(pos_local)
                world_rot[ti] = w
                world_pos[ti] = v_add(p_pos, q_rot(p_rot, pos_local))
            else:
                world_rot[ti] = q_norm(q_mul(p_rot, rr))
                world_pos[ti] = v_add(p_pos, q_rot(p_rot, rt))
    return times, rot_tracks, hips_pos, tgt_hips


def write_clip(path, name, tgt_rig, times, rot_tracks, hips_pos, tgt_hips):
    out_nodes, node_of = [], {}
    for ti in rot_tracks:
        node_of[ti] = len(out_nodes)
        out_nodes.append({"name": tgt_rig.names[ti]})
    parts, views, accs = [], [], []

    def acc(data, ctype, atype, count, minmax=None):
        off = sum(len(p) for p in parts)
        parts.append(data)
        views.append({"buffer": 0, "byteOffset": off, "byteLength": len(data)})
        a = {"bufferView": len(views) - 1, "componentType": ctype, "count": count, "type": atype}
        if minmax:
            a["min"], a["max"] = minmax
        accs.append(a)
        return len(accs) - 1

    n = len(times)
    t_acc = acc(struct.pack(f"<{n}f", *times), 5126, "SCALAR", n, ([times[0]], [times[-1]]))
    samplers, channels = [], []
    for ti, quats in rot_tracks.items():
        flat = [c for q in quats for c in q]
        a = acc(struct.pack(f"<{len(flat)}f", *flat), 5126, "VEC4", n)
        samplers.append({"input": t_acc, "output": a, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": node_of[ti], "path": "rotation"}})
    if hips_pos and tgt_hips in node_of:
        flat = [c for p in hips_pos for c in p]
        a = acc(struct.pack(f"<{len(flat)}f", *flat), 5126, "VEC3", n)
        samplers.append({"input": t_acc, "output": a, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": node_of[tgt_hips], "path": "translation"}})
    blob = b"".join(parts)
    blob += b"\0" * ((4 - len(blob) % 4) % 4)
    gltf = {
        "asset": {"version": "2.0", "generator": "robo-buddy retarget_clips"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(out_nodes)))}],
        "nodes": out_nodes,
        "animations": [{"name": name, "samplers": samplers, "channels": channels}],
        "buffers": [{"byteLength": len(blob)}],
        "bufferViews": views,
        "accessors": accs,
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(blob), 0x004E4942) + blob)


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    opts = {a.split("=")[0]: a.split("=", 1)[1] for a in argv if a.startswith("--") and "=" in a}
    src_path, tgt_path, out_dir = args[:3]
    wanted = args[3:]
    ref_name = opts.get("--ref", "A_TPose")
    bone_map = MAPS[opts.get("--map", "ue")]()

    src = Rig(*read_glb(src_path))
    tgt = Rig(*read_glb(tgt_path))
    anims = {a["name"]: a for a in src.g.get("animations", [])}

    # Reference poses (T-pose) in world space.
    if ref_name in anims:
        ref_clip = Anim(src, anims[ref_name])
        src_ref_world = src.world(ref_clip.local_at(0.0))
    else:
        src_ref_world = src.world({i: src.rest(i) for i in range(len(src.nodes))})
    tgt_ref_world = tgt.world({i: tgt.rest(i) for i in range(len(tgt.nodes))})

    # Sanity: report arm direction and facing of both rigs.
    def arm_dir(rig, world, a, b):
        ia, ib = rig.find(*a), rig.find(*b)
        if ia is None or ib is None:
            return None
        d = v_sub(world[ib][0], world[ia][0])
        n = math.sqrt(sum(c * c for c in d)) or 1
        return tuple(round(c / n, 2) for c in d)

    print("source left arm dir:", arm_dir(src, src_ref_world, ("upperarm_l", "mixamorig:LeftArm", "mixamorigLeftArm", "LeftArm"), ("lowerarm_l", "mixamorig:LeftForeArm", "mixamorigLeftForeArm", "LeftForeArm")))
    print("target left arm dir:", arm_dir(tgt, tgt_ref_world, ("mixamorig:LeftArm", "mixamorigLeftArm"), ("mixamorig:LeftForeArm", "mixamorigLeftForeArm")))
    src_hips = src.find("pelvis", "mixamorig:Hips", "mixamorigHips", "Hips")
    tgt_hips = target_index(tgt, "Hips")
    if src_hips is not None and tgt_hips is not None:
        print("hip heights: src", round(src_ref_world[src_hips][0][1], 3), "tgt", round(tgt_ref_world[tgt_hips][0][1], 3))

    os.makedirs(out_dir, exist_ok=True)
    index = []
    for name, a in anims.items():
        if wanted and name not in wanted:
            continue
        if name == ref_name:
            continue
        clip = Anim(src, a)
        times, rots, hips, th = bake(src, tgt, clip, src_ref_world, tgt_ref_world, bone_map)
        out = os.path.join(out_dir, f"{name}.glb")
        write_clip(out, name, tgt, times, rots, hips, th)
        index.append({"name": name, "file": f"{name}.glb", "duration": round(clip.duration, 3), "loop": name.endswith("_Loop")})
        print(f"baked {name}: {len(times)} frames, {len(rots)} bones -> {os.path.getsize(out)} bytes")
    # The index covers every clip in the folder, not just this run.
    existing = {}
    idx_path = os.path.join(out_dir, "index.json")
    if os.path.exists(idx_path):
        try:
            existing = {e["name"]: e for e in json.load(open(idx_path))}
        except Exception:
            existing = {}
    for e in index:
        existing[e["name"]] = e
    present = {os.path.splitext(f)[0] for f in os.listdir(out_dir) if f.endswith(".glb")}
    merged = [e for n, e in existing.items() if n in present]
    with open(idx_path, "w") as f:
        json.dump(sorted(merged, key=lambda x: x["name"]), f, indent=2)
    print(f"wrote {len(index)} clips to {out_dir}")


if __name__ == "__main__":
    main(sys.argv[1:])
