"""Extract a skeleton-only GLB (node hierarchy + rest transforms, no mesh) from a rigged GLB.
The app uses it as the canonical source rig for every clip in the shared library.
Usage: python scripts/make_canonical_rig.py public/characters/rocco/rocco.glb public/clips/canonical.glb
"""
import json, struct, sys

src, dst = sys.argv[1], sys.argv[2]
with open(src, "rb") as f:
    f.read(12); clen, _ = struct.unpack("<II", f.read(8)); g = json.loads(f.read(clen))
nodes = g["nodes"]
keep = [i for i, n in enumerate(nodes) if "mesh" not in n]
remap = {old: new for new, old in enumerate(keep)}
out_nodes = []
for i in keep:
    n = nodes[i]
    o = {"name": n.get("name", f"node{i}")}
    for k in ("translation", "rotation", "scale"):
        if k in n: o[k] = n[k]
    ch = [remap[c] for c in n.get("children", []) if c in remap]
    if ch: o["children"] = ch
    out_nodes.append(o)
parents = {c for n in out_nodes for c in n.get("children", [])}
roots = [i for i in range(len(out_nodes)) if i not in parents]
gltf = {"asset": {"version": "2.0", "generator": "robo-buddy canonical rig"}, "scene": 0, "scenes": [{"nodes": roots}], "nodes": out_nodes}
js = json.dumps(gltf, separators=(",", ":")).encode(); js += b" " * ((4 - len(js) % 4) % 4)
with open(dst, "wb") as f:
    f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js))); f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
print(f"wrote {dst}: {len(out_nodes)} nodes, roots {roots}")
