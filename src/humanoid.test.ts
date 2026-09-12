import { describe, expect, it } from "vitest";
import { humanoidMatch, humanoidNameOf, missingBones, stripMixamo, type BoneName } from "./humanoid";

/** A fake bone map: only the keys matter to `missingBones`. */
const boneSet = (names: BoneName[]) => new Map(names.map((n) => [n, {} as never]));

describe("stripMixamo", () => {
  it("removes the prefix in both spellings", () => {
    expect(stripMixamo("mixamorig:Hips")).toBe("Hips");
    expect(stripMixamo("mixamorigHips")).toBe("Hips");
    expect(stripMixamo("Hips")).toBe("Hips");
  });
});

describe("humanoidNameOf", () => {
  it("reads Mixamo names", () => {
    expect(humanoidNameOf("mixamorig:Hips")).toBe("hips");
    expect(humanoidNameOf("mixamorig:LeftForeArm")).toBe("leftLowerArm");
    expect(humanoidNameOf("Spine1")).toBe("chest");
  });

  it("reads Unreal names", () => {
    expect(humanoidNameOf("upperarm_l")).toBe("leftUpperArm");
    expect(humanoidNameOf("calf_r")).toBe("rightLowerLeg");
    expect(humanoidNameOf("pelvis")).toBe("hips");
  });

  it("reads Valve biped names from Source Filmmaker exports", () => {
    expect(humanoidNameOf("bip_pelvis")).toBe("hips");
    expect(humanoidNameOf("bip_upperArm_R")).toBe("rightUpperArm");
    expect(humanoidNameOf("bip_lowerArm_L")).toBe("leftLowerArm");
    expect(humanoidNameOf("bip_knee_R")).toBe("rightLowerLeg");
    expect(humanoidNameOf("bip_foot_L")).toBe("leftFoot");
    expect(humanoidNameOf("bip_head")).toBe("head");
  });

  it("reads Blender-style generic names", () => {
    expect(humanoidNameOf("upper_arm.L")).toBe("leftUpperArm");
    expect(humanoidNameOf("thigh.R")).toBe("rightUpperLeg");
  });

  it("sees through the counter Sketchfab appends to every bone", () => {
    // The regression that left the first Terminator standing in its bind pose.
    expect(humanoidNameOf("Hips_02")).toBe("hips");
    expect(humanoidNameOf("LeftArm_010")).toBe("leftUpperArm");
    expect(humanoidNameOf("bip_pelvis_02")).toBe("hips");
    expect(humanoidNameOf("Head.001")).toBe("head");
  });

  it("keeps Mixamo's own digits, which have no separator", () => {
    expect(humanoidNameOf("Spine1")).toBe("chest");
    expect(humanoidNameOf("Spine2")).toBe("upperChest");
  });

  it("returns nothing for bones that are not humanoid", () => {
    expect(humanoidNameOf("_rootJoint")).toBeUndefined();
    expect(humanoidNameOf("LeftArmRoll_helper_010")).toBeUndefined();
    expect(humanoidNameOf("")).toBeUndefined();
  });
});

describe("humanoidMatch", () => {
  it("marks a rig-table hit as specific and a loose word as not", () => {
    expect(humanoidMatch("bip_neck")).toEqual({ bone: "neck", specific: true });
    expect(humanoidMatch("mixamorig:Neck")).toEqual({ bone: "neck", specific: true });
    // Only the loose table knows these, so a real rig bone may still replace them.
    expect(humanoidMatch("upper_arm.L")).toEqual({ bone: "leftUpperArm", specific: false });
    expect(humanoidMatch("upperchest")).toEqual({ bone: "upperChest", specific: false });
  });

  it("treats a bare Mixamo bone name as specific, which decides ties by file order", () => {
    // In the Source Filmmaker Terminator both "Neck_038" and "bip_neck_039" exist. "Neck" is
    // itself a Mixamo bone name, so both are specific matches and the first in the file wins.
    // That lands on the helper rather than bip_neck, which looks right because the helper is
    // its parent. Worth knowing if a future rig puts an unrelated bone called "Neck" first.
    expect(humanoidMatch("Neck")).toEqual({ bone: "neck", specific: true });
  });
});

describe("missingBones", () => {
  it("reports nothing when the required set is present", () => {
    const full: BoneName[] = [
      "hips", "spine", "head",
      "leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm",
      "leftUpperLeg", "leftLowerLeg", "rightUpperLeg", "rightLowerLeg",
    ];
    expect(missingBones(boneSet(full))).toEqual([]);
  });

  it("names what a partial rig lacks", () => {
    const missing = missingBones(boneSet(["hips", "spine", "head"]));
    expect(missing).toContain("leftUpperArm");
    expect(missing).toContain("rightLowerLeg");
    expect(missing).not.toContain("hips");
  });
});
