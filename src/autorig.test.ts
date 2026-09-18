import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  boneTransferMap,
  buildHumanoidBoneDefs,
  checkSkeletonContainment,
  createRiggedGroup,
  transferSkinWeights,
  createSkeleton,
  distToSegmentSq,
  inferRigParamsFromSkeleton,
  isModelRigged,
  hasMeshGeometry,
  orientAndGetBounds,
  computeMeshBounds,
  type RigParams,
} from "./autorig";

describe("autorig", () => {
  it("detects unrigged vs rigged models", () => {
    const unrigged = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
    unrigged.add(mesh);

    expect(isModelRigged(unrigged)).toBe(false);
    expect(hasMeshGeometry(unrigged)).toBe(true);

    // Create a rigged skeleton
    const hips = new THREE.Bone();
    hips.name = "mixamorig:Hips";
    const spine = new THREE.Bone();
    spine.name = "mixamorig:Spine";
    const head = new THREE.Bone();
    head.name = "mixamorig:Head";
    const lArm = new THREE.Bone();
    lArm.name = "mixamorig:LeftArm";
    const rArm = new THREE.Bone();
    rArm.name = "mixamorig:RightArm";
    const lLeg = new THREE.Bone();
    lLeg.name = "mixamorig:LeftUpLeg";
    const rLeg = new THREE.Bone();
    rLeg.name = "mixamorig:RightUpLeg";
    const lFoot = new THREE.Bone();
    lFoot.name = "mixamorig:LeftFoot";

    hips.add(spine);
    spine.add(head);
    spine.add(lArm);
    spine.add(rArm);
    hips.add(lLeg);
    hips.add(rLeg);
    lLeg.add(lFoot);

    const rigged = new THREE.Group();
    const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
    rigged.add(hips);
    rigged.add(skinned);
    skinned.bind(new THREE.Skeleton([hips, spine, head, lArm, rArm, lLeg, rLeg, lFoot]));

    expect(isModelRigged(rigged)).toBe(true);
  });

  it("calculates distance from point to line segment accurately", () => {
    const a = new THREE.Vector3(0, 0, 0);
    const b = new THREE.Vector3(0, 2, 0);

    // Point exactly on midpoint
    expect(distToSegmentSq(new THREE.Vector3(0, 1, 0), a, b)).toBeCloseTo(0);

    // Point offset by 1 unit perpendicular to midpoint
    expect(distToSegmentSq(new THREE.Vector3(1, 1, 0), a, b)).toBeCloseTo(1);

    // Point beyond end of segment B (closest to B)
    expect(distToSegmentSq(new THREE.Vector3(0, 3, 0), a, b)).toBeCloseTo(1);

    // Point before start of segment A (closest to A)
    expect(distToSegmentSq(new THREE.Vector3(0, -1, 0), a, b)).toBeCloseTo(1);
  });

  it("builds 22 Mixamo humanoid bones with proper A-pose and T-pose arm angles", () => {
    const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.2), new THREE.Vector3(0.5, 2, 0.2));
    const size = new THREE.Vector3(1, 2, 0.4);
    const center = new THREE.Vector3(0, 1, 0);

    const aPoseDefs = buildHumanoidBoneDefs(box, size, center, "a_pose");
    expect(aPoseDefs.length).toBe(22);

    const lArmA = aPoseDefs.find((d) => d.name === "mixamorig:LeftArm")!;
    const lForeArmA = aPoseDefs.find((d) => d.name === "mixamorig:LeftForeArm")!;
    expect(lArmA).toBeDefined();
    expect(lForeArmA).toBeDefined();

    // In A-pose, forearm is lower in Y than shoulder/upper arm
    expect(lForeArmA.head.y).toBeLessThan(lArmA.head.y);

    const tPoseDefs = buildHumanoidBoneDefs(box, size, center, "t_pose");
    expect(tPoseDefs.length).toBe(22);

    const lArmT = tPoseDefs.find((d) => d.name === "mixamorig:LeftArm")!;
    const lForeArmT = tPoseDefs.find((d) => d.name === "mixamorig:LeftForeArm")!;

    // In T-pose, arm joints share the same horizontal Y plane
    expect(lForeArmT.head.y).toBeCloseTo(lArmT.head.y, 2);
  });

  it("creates valid skeleton and bone hierarchy", () => {
    const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.2), new THREE.Vector3(0.5, 2, 0.2));
    const size = new THREE.Vector3(1, 2, 0.4);
    const center = new THREE.Vector3(0, 1, 0);

    const defs = buildHumanoidBoneDefs(box, size, center, "a_pose");
    const { rootBone, bones, skeleton, boneMap } = createSkeleton(defs);

    expect(rootBone.name).toBe("mixamorig:Hips");
    expect(bones.length).toBe(22);
    expect(skeleton.bones.length).toBe(22);

    // Check parent-child links
    const hips = boneMap.get("mixamorig:Hips")!;
    const spine = boneMap.get("mixamorig:Spine")!;
    expect(spine.parent).toBe(hips);

    const spine2 = boneMap.get("mixamorig:Spine2")!;
    const lShoulder = boneMap.get("mixamorig:LeftShoulder")!;
    expect(lShoulder.parent).toBe(spine2);
  });

  it("normalises Z-up orientation to Y-up", () => {
    const zUpModel = new THREE.Group();
    // Height is along Z (4.0), while Y is only 1.0
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 4), new THREE.MeshBasicMaterial());
    zUpModel.add(mesh);

    const { size } = orientAndGetBounds(zUpModel);
    // Height is along Y now, and every character comes out the same height; the 4:1 shape survives.
    expect(size.y).toBeCloseTo(1.8, 1);
    expect(size.z).toBeCloseTo(size.y / 4, 1);
  });

  it("autoRigs an unrigged model and exports valid GLB with skeleton", async () => {
    const { autoRig } = await import("./autorig");
    const model = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.8, 8), new THREE.MeshBasicMaterial());
    body.name = "Body";
    body.position.set(0, 0.9, 0);
    model.add(body);

    const glbBuffer = await autoRig(model, "a_pose");
    expect(glbBuffer).toBeDefined();
    expect(glbBuffer.byteLength).toBeGreaterThan(100);

    // Parse the exported GLB header & JSON
    const view = new DataView(glbBuffer);
    const magic = view.getUint32(0, true);
    expect(magic).toBe(0x46546c67); // "glTF"

    const jsonLen = view.getUint32(12, true);
    const jsonBytes = new Uint8Array(glbBuffer, 20, jsonLen);
    const jsonStr = new TextDecoder().decode(jsonBytes);
    const gltf = JSON.parse(jsonStr);

    expect(gltf.skins).toBeDefined();
    expect(gltf.skins.length).toBeGreaterThan(0);
    expect(gltf.skins[0].joints.length).toBe(22);

    // Verify materials in exported GLTF are opaque and not BLEND
    if (gltf.materials) {
      for (const mat of gltf.materials) {
        expect(mat.alphaMode).not.toBe("BLEND");
      }
    }
  });

  it("produces zero rest-pose displacement on skinned vertices", () => {
    const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.2), new THREE.Vector3(0.5, 2, 0.2));
    const size = new THREE.Vector3(1, 2, 0.4);
    const center = new THREE.Vector3(0, 1, 0);

    const defs = buildHumanoidBoneDefs(box, size, center, "a_pose");
    const { rootBone, skeleton } = createSkeleton(defs);

    const scene = new THREE.Group();
    scene.add(rootBone);
    scene.updateMatrixWorld(true);
    rootBone.updateMatrixWorld(true);
    skeleton.calculateInverses();

    // Verify bone inverses are not degenerate/identity
    for (const inv of skeleton.boneInverses) {
      expect(inv.elements[12] !== 0 || inv.elements[13] !== 0 || inv.elements[14] !== 0).toBe(true);
    }

    const geom = new THREE.CylinderGeometry(0.3, 0.3, 1.8, 8);
    const pos = geom.getAttribute("position");
    const skinIndices = new Uint16Array(pos.count * 4);
    const skinWeights = new Float32Array(pos.count * 4);

    for (let i = 0; i < pos.count; i++) {
      skinIndices[i * 4] = 0;
      skinWeights[i * 4] = 0.5;
      skinIndices[i * 4 + 1] = 1;
      skinWeights[i * 4 + 1] = 0.5;
    }
    geom.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
    geom.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));

    const skinned = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
    scene.add(skinned);
    skinned.updateMatrixWorld(true);
    skinned.bind(skeleton);

    // Compute GPU skinning equation at rest pose: sum(w_j * bone_j * inv_j * pos)
    const vOriginal = new THREE.Vector3();
    const vDeformed = new THREE.Vector3();
    const m = new THREE.Matrix4();
    let maxDiff = 0;

    for (let i = 0; i < pos.count; i++) {
      vOriginal.fromBufferAttribute(pos, i);
      vDeformed.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        const boneIdx = skinIndices[i * 4 + j];
        const weight = skinWeights[i * 4 + j];
        if (weight === 0) continue;
        const b = skeleton.bones[boneIdx];
        const inv = skeleton.boneInverses[boneIdx];
        m.multiplyMatrices(b.matrixWorld, inv);
        vDeformed.addScaledVector(vOriginal.clone().applyMatrix4(m), weight);
      }
      const diff = vOriginal.distanceTo(vDeformed);
      if (diff > maxDiff) maxDiff = diff;
    }

    expect(maxDiff).toBeLessThan(1e-5);
  });

  it("positions knee and foot bones with custom leg angle, stance, and outward splay", () => {
    const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.3), new THREE.Vector3(0.5, 2, 0.3));
    const size = new THREE.Vector3(1, 2, 0.6);
    const center = new THREE.Vector3(0, 1, 0);

    const defs = buildHumanoidBoneDefs(box, size, center, {
      pose: "a_pose",
      legWidth: 1.0,
      kneeWidth: 1.4,
      footWidth: 1.8,
      footForward: 1.2,
      footAngleDeg: 20,
    });
    const map = new Map(defs.map((d) => [d.name, d]));

    const upLeg = map.get("mixamorig:LeftUpLeg")!;
    const leg = map.get("mixamorig:LeftLeg")!;
    const foot = map.get("mixamorig:LeftFoot")!;
    const toe = map.get("mixamorig:LeftToeBase")!;

    // UpLeg head is at hip width, tail is at knee width (angled outward)
    expect(upLeg.head.x).toBeLessThan(upLeg.tail.x);
    // Leg head is at knee width, tail is at foot width (angled further outward)
    expect(leg.head.x).toBe(upLeg.tail.x);
    expect(leg.tail.x).toBeGreaterThan(leg.head.x);
    // Foot head matches leg tail
    expect(foot.head.x).toBe(leg.tail.x);
    // Outward splay: foot tail X is further out than foot head X due to 20° outward angle
    expect(foot.tail.x).toBeGreaterThan(foot.head.x);
    expect(toe.tail.x).toBeGreaterThan(toe.head.x);

    // Symmetrically negative for Right side
    const rUpLeg = map.get("mixamorig:RightUpLeg")!;
    const rLeg = map.get("mixamorig:RightLeg")!;
    const rFoot = map.get("mixamorig:RightFoot")!;
    const rToe = map.get("mixamorig:RightToeBase")!;

    expect(rUpLeg.head.x).toBeGreaterThan(rUpLeg.tail.x);
    expect(rLeg.head.x).toBe(rUpLeg.tail.x);
    expect(rLeg.tail.x).toBeLessThan(rLeg.head.x);
    expect(rFoot.tail.x).toBeLessThan(rFoot.head.x);
    expect(rToe.tail.x).toBeLessThan(rToe.head.x);
  });

  it("adjusts upper body heights and regional depths", () => {
    const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.3), new THREE.Vector3(0.5, 2, 0.3));
    const size = new THREE.Vector3(1, 2, 0.6);
    const center = new THREE.Vector3(0, 1, 0);

    const baseDefs = buildHumanoidBoneDefs(box, size, center);
    const baseMap = new Map(baseDefs.map((d) => [d.name, d]));

    const modifiedDefs = buildHumanoidBoneDefs(box, size, center, {
      shoulderHeight: 1.15,
      neckHeight: 1.10,
      headHeight: 1.12,
      headDepth: 0.5,
      shoulderDepth: -0.3,
      spineDepth: 0.2,
      kneeDepth: 0.4,
    });
    const modMap = new Map(modifiedDefs.map((d) => [d.name, d]));

    // Shoulders higher
    expect(modMap.get("mixamorig:LeftShoulder")!.tail.y).toBeGreaterThan(baseMap.get("mixamorig:LeftShoulder")!.tail.y);
    expect(modMap.get("mixamorig:LeftArm")!.head.y).toBeGreaterThan(baseMap.get("mixamorig:LeftArm")!.head.y);

    // Neck and Head higher
    expect(modMap.get("mixamorig:Neck")!.head.y).toBeGreaterThan(baseMap.get("mixamorig:Neck")!.head.y);
    expect(modMap.get("mixamorig:Head")!.head.y).toBeGreaterThan(baseMap.get("mixamorig:Head")!.head.y);

    // Z-depth offsets
    const depthScale = size.z * 0.25;
    expect(modMap.get("mixamorig:Head")!.head.z).toBeCloseTo(center.z + 0.5 * depthScale, 4);
    expect(modMap.get("mixamorig:LeftShoulder")!.tail.z).toBeCloseTo(center.z - 0.3 * depthScale, 4);
    expect(modMap.get("mixamorig:Hips")!.head.z).toBeCloseTo(center.z + 0.2 * depthScale, 4);
    expect(modMap.get("mixamorig:LeftUpLeg")!.tail.z).toBeCloseTo(center.z + 0.4 * depthScale, 4);
  });

  it("accurately detects whether skeleton joints are inside or outside mesh geometry", async () => {
    const { checkSkeletonContainment } = await import("./autorig");
    const group = new THREE.Group();
    // A box from -0.5 to 0.5 along X, 0 to 2 along Y, -0.2 to 0.2 along Z
    const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.4), new THREE.MeshBasicMaterial());
    boxMesh.position.set(0, 1, 0);
    group.add(boxMesh);

    const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.2), new THREE.Vector3(0.5, 2, 0.2));
    const size = new THREE.Vector3(1, 2, 0.4);
    const center = new THREE.Vector3(0, 1, 0);

    // Default skeleton inside box
    const insideDefs = buildHumanoidBoneDefs(box, size, center, { headDepth: 0 });
    const resInside = checkSkeletonContainment(group, insideDefs);
    expect(resInside.allInside).toBe(true);
    expect(resInside.outsideCount).toBe(0);

    // Push head way out in front (+Z) outside box
    const outsideDefs = buildHumanoidBoneDefs(box, size, center, { headDepth: 3.0 });
    const resOutside = checkSkeletonContainment(group, outsideDefs);
    expect(resOutside.allInside).toBe(false);
    expect(resOutside.outsideCount).toBeGreaterThan(0);
    expect(resOutside.jointStatus.get("mixamorig:Head")).toBe(false);
  });

  it("generates 52 bones when includeFingers is true", () => {
    const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.2), new THREE.Vector3(0.5, 2, 0.2));
    const size = new THREE.Vector3(1, 2, 0.4);
    const center = new THREE.Vector3(0, 1, 0);

    const defsWithout = buildHumanoidBoneDefs(box, size, center, { includeFingers: false });
    expect(defsWithout.length).toBe(22);

    const defsWith = buildHumanoidBoneDefs(box, size, center, { includeFingers: true });
    expect(defsWith.length).toBe(52); // 22 standard + 30 finger bones

    const boneNames = new Set(defsWith.map((d) => d.name));
    expect(boneNames.has("mixamorig:LeftHandThumb1")).toBe(true);
    expect(boneNames.has("mixamorig:LeftHandThumb3")).toBe(true);
    expect(boneNames.has("mixamorig:LeftHandIndex2")).toBe(true);
    expect(boneNames.has("mixamorig:LeftHandMiddle2")).toBe(true);
    expect(boneNames.has("mixamorig:LeftHandRing2")).toBe(true);
    expect(boneNames.has("mixamorig:LeftHandPinky3")).toBe(true);
    expect(boneNames.has("mixamorig:RightHandThumb1")).toBe(true);
    expect(boneNames.has("mixamorig:RightHandPinky3")).toBe(true);
  });

  it("isolates head and hair meshes from torso and shoulder bones", async () => {
    const { autoRig } = await import("./autorig");
    const group = new THREE.Group();

    // Body mesh
    const bodyMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.4, 8), new THREE.MeshBasicMaterial());
    bodyMesh.name = "Torso";
    bodyMesh.position.set(0, 0.7, 0);
    group.add(bodyMesh);

    // Head mesh (with dreadlocks extending down to shoulder level)
    const headMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 0.6, 8), new THREE.MeshBasicMaterial());
    headMesh.name = "Predatorhead_Dreads";
    headMesh.position.set(0, 1.7, 0);
    group.add(headMesh);

    const glbBuffer = await autoRig(group, "a_pose");
    expect(glbBuffer).toBeDefined();

    const view = new DataView(glbBuffer);
    const jsonLen = view.getUint32(12, true);
    const jsonBytes = new Uint8Array(glbBuffer, 20, jsonLen);
    const jsonStr = new TextDecoder().decode(jsonBytes);
    const gltf = JSON.parse(jsonStr);

    // Get nodes and skin joints
    const joints = gltf.skins[0].joints.map((jIdx: number) => gltf.nodes[jIdx].name);
    const headJointIdx = joints.indexOf("mixamorig:Head");
    const neckJointIdx = joints.indexOf("mixamorig:Neck");
    const spine2JointIdx = joints.indexOf("mixamorig:Spine2");

    expect(headJointIdx).toBeGreaterThanOrEqual(0);
    expect(neckJointIdx).toBeGreaterThanOrEqual(0);
    expect(spine2JointIdx).toBeGreaterThanOrEqual(0);
  });

  it("infers RigParams accurately from an already-rigged model skeleton", () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.8, 8), new THREE.MeshBasicMaterial());
    mesh.position.set(0, 0.9, 0);
    root.add(mesh);

    const { group } = createRiggedGroup(root, {
      pose: "a_pose",
      armAngleDeg: 45,
      shoulderWidth: 1.1,
      headHeight: 1.05,
      includeFingers: true,
    });

    const inferred = inferRigParamsFromSkeleton(group);
    expect(inferred).not.toBeNull();
    expect(inferred!.pose).toBe("a_pose");
    expect(inferred!.armAngleDeg).toBe(45);
    expect(inferred!.includeFingers).toBe(true);
    expect(inferred!.headHeight).toBeCloseTo(1.05, 1);
    expect(inferred!.shoulderWidth).toBeCloseTo(1.1, 1);
  });

  it("adjusts ankleHeight and scales foot/toe positions", () => {
    const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.2), new THREE.Vector3(0.5, 2, 0.2));
    const size = new THREE.Vector3(1, 2, 0.4);
    const center = new THREE.Vector3(0, 1, 0);

    // Standard ankle height (1.0 = 0.07 * H = 0.14)
    const defsStd = buildHumanoidBoneDefs(box, size, center, { ankleHeight: 1.0 });
    const lFootStd = defsStd.find((d) => d.name === "mixamorig:LeftFoot")!;
    expect(lFootStd.head.y).toBeCloseTo(0.14, 2);

    // Lower ankle height (0.5 = 0.035 * H = 0.07)
    const defsLow = buildHumanoidBoneDefs(box, size, center, { ankleHeight: 0.5 });
    const lFootLow = defsLow.find((d) => d.name === "mixamorig:LeftFoot")!;
    expect(lFootLow.head.y).toBeCloseTo(0.07, 2);
  });

  it("supports finger tuning: thumb forward orientation and spread", () => {
    const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.2), new THREE.Vector3(0.5, 2, 0.2));
    const size = new THREE.Vector3(1, 2, 0.4);
    const center = new THREE.Vector3(0, 1, 0);

    // Thumb pointing forward (+Z) by default
    const defsFwd = buildHumanoidBoneDefs(box, size, center, {
      includeFingers: true,
      thumbForward: true,
      fingerSpread: 1.0,
      fingerLength: 1.0,
    });
    const lThumbFwd = defsFwd.find((d) => d.name === "mixamorig:LeftHandThumb1")!;
    const lPinkyFwd = defsFwd.find((d) => d.name === "mixamorig:LeftHandPinky1")!;
    // Thumb should be in front (+Z) of Pinky (-Z)
    expect(lThumbFwd.head.z).toBeGreaterThan(lPinkyFwd.head.z);

    // Thumb inverted (-Z)
    const defsRev = buildHumanoidBoneDefs(box, size, center, {
      includeFingers: true,
      thumbForward: false,
      fingerSpread: 1.0,
    });
    const lThumbRev = defsRev.find((d) => d.name === "mixamorig:LeftHandThumb1")!;
    const lPinkyRev = defsRev.find((d) => d.name === "mixamorig:LeftHandPinky1")!;
    expect(lThumbRev.head.z).toBeLessThan(lPinkyRev.head.z);
  });

  it("isolates leg skinning across midline and clamps spine/torso weights at pelvic crease", () => {
    const root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 2, 16, 20), new THREE.MeshBasicMaterial());
    body.position.set(0, 1, 0);
    root.add(body);

    const { group, skeleton } = createRiggedGroup(root, "a_pose");
    let skinnedMesh: THREE.SkinnedMesh | null = null;
    group.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinnedMesh = o as THREE.SkinnedMesh;
    });
    expect(skinnedMesh).not.toBeNull();

    const geom = skinnedMesh!.geometry;
    const posAttr = geom.getAttribute("position");
    const skinIndexAttr = geom.getAttribute("skinIndex");
    const skinWeightAttr = geom.getAttribute("skinWeight");

    const boneNames = skeleton.bones.map((b) => b.name);
    const spineIndices = new Set(
      boneNames
        .map((name, idx) => ({ name, idx }))
        .filter(({ name }) => name.includes("Spine") || name.includes("Neck") || name.includes("Head") || name.includes("Arm"))
        .map(({ idx }) => idx)
    );

    const leftLegIndices = new Set(
      boneNames
        .map((name, idx) => ({ name, idx }))
        .filter(({ name }) => name.startsWith("mixamorig:Left") && (name.includes("Leg") || name.includes("Foot") || name.includes("Toe")))
        .map(({ idx }) => idx)
    );

    const rightLegIndices = new Set(
      boneNames
        .map((name, idx) => ({ name, idx }))
        .filter(({ name }) => name.startsWith("mixamorig:Right") && (name.includes("Leg") || name.includes("Foot") || name.includes("Toe")))
        .map(({ idx }) => idx)
    );

    for (let i = 0; i < posAttr.count; i++) {
      const vx = posAttr.getX(i);
      const vy = posAttr.getY(i);

      for (let j = 0; j < 4; j++) {
        const boneIdx = skinIndexAttr.getComponent(i, j);
        const weight = skinWeightAttr.getComponent(i, j);
        if (weight <= 0) continue;

        // Vertices strictly on the character's left (x > 0.05) must not bind to right leg bones
        if (vx > 0.05) {
          expect(rightLegIndices.has(boneIdx)).toBe(false);
        }
        // Vertices strictly on the character's right (x < -0.05) must not bind to left leg bones
        if (vx < -0.05) {
          expect(leftLegIndices.has(boneIdx)).toBe(false);
        }

        // Vertices well below the pelvic crease (y < 0.8) must have zero spine/head/arm influence
        if (vy < 0.8) {
          expect(spineIndices.has(boneIdx)).toBe(false);
        }
      }
    }
  });

  it("isolates forearm and wrist vertices from hand bone influence", () => {
    const root = new THREE.Group();
    // Humanoid cylinder
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 2, 16, 20), new THREE.MeshBasicMaterial());
    body.position.set(0, 1, 0);
    root.add(body);

    const { group, skeleton, defs } = createRiggedGroup(root, "a_pose");
    const lHandDef = defs.find((d) => d.name === "mixamorig:LeftHand")!;
    const lHandBoneIdx = skeleton.bones.findIndex((b) => b.name === "mixamorig:LeftHand");
    expect(lHandBoneIdx).toBeGreaterThanOrEqual(0);

    let skinnedMesh: THREE.SkinnedMesh | null = null;
    group.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinnedMesh = o as THREE.SkinnedMesh;
    });
    expect(skinnedMesh).not.toBeNull();

    const geom = skinnedMesh!.geometry;
    const posAttr = geom.getAttribute("position");
    const skinIndexAttr = geom.getAttribute("skinIndex");
    const skinWeightAttr = geom.getAttribute("skinWeight");

    for (let i = 0; i < posAttr.count; i++) {
      const vx = posAttr.getX(i);
      // Vertices inward from the wrist (on forearm/body) must NOT have Hand weight
      if (vx < lHandDef.head.x - 0.05) {
        for (let j = 0; j < 4; j++) {
          const boneIdx = skinIndexAttr.getComponent(i, j);
          const weight = skinWeightAttr.getComponent(i, j);
          if (weight > 0) {
            expect(boneIdx).not.toBe(lHandBoneIdx);
          }
        }
      }
    }
  });

  it("ignores stray bones and normalises miniature scales in orientAndGetBounds", () => {
    const root = new THREE.Group();
    // Mesh is only 0.08m tall
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.08, 8), new THREE.MeshBasicMaterial());
    mesh.position.set(0, 0.04, 0);
    root.add(mesh);

    // Stray FBX dummy bone far down below
    const strayBone = new THREE.Bone();
    strayBone.name = "stray_bone_node";
    strayBone.position.set(0, -114, 0);
    root.add(strayBone);

    // computeMeshBounds ignores the stray bone
    const mb = computeMeshBounds(root);
    const mSize = new THREE.Vector3();
    mb.getSize(mSize);
    expect(mSize.y).toBeCloseTo(0.08, 2);

    // orientAndGetBounds normalises miniature mesh scale to ~1.8m
    const { size } = orientAndGetBounds(root);
    expect(size.y).toBeCloseTo(1.8, 1);

    // createRiggedGroup builds skeleton correctly centered inside 1.8m model
    const { skeleton, rootBone } = createRiggedGroup(root, { pose: "a_pose" });
    expect(skeleton.bones.length).toBe(22);
    const hipsPos = new THREE.Vector3();
    rootBone.getWorldPosition(hipsPos);
    expect(hipsPos.y).toBeGreaterThan(0.7);
    expect(hipsPos.y).toBeLessThan(1.1);
  });

  it("verifies clean retargeting and no exploded vertices on Spartan model with stray bones", async () => {
    (globalThis as any).self = globalThis;
    (globalThis as any).createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    const fs = await import("fs");
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const { buildRig, retargetClip } = await import("./retarget");

    const spartanPath = "c:/Users/Occor/Downloads/spartan_armour_mkv_-_halo_reach-ground-removed.glb";
    if (!fs.existsSync(spartanPath)) return;

    const loader = new GLTFLoader();
    const spartanBuf = fs.readFileSync(spartanPath);
    const spartanGltf = await new Promise<any>((resolve, reject) => {
      loader.parse(spartanBuf.buffer, "", resolve, reject);
    });

    const spartanParams: RigParams = {
      pose: "a_pose",
      headHeight: 1.02,
      neckHeight: 1.07,
      headDepth: -0.13,
      shoulderHeight: 1.12,
      shoulderWidth: 0.90,
      shoulderDepth: -0.53,
      armAngleDeg: 45,
      armLength: 0.97,
      includeFingers: true,
      fingerLength: 1.0,
      fingerSpread: 1.0,
    };

    const { group, skeleton } = createRiggedGroup(spartanGltf.scene, spartanParams);
    expect(skeleton.bones.length).toBe(52);

    // Load Crouch clip
    const clipBuf = fs.readFileSync("public/clips/mixamo/Crouch_Look_Around.glb");
    const clipGltf = await new Promise<any>((resolve, reject) => {
      loader.parse(clipBuf.buffer, "", resolve, reject);
    });

    const canBuf = fs.readFileSync("public/clips/canonical.glb");
    const canGltf = await new Promise<any>((resolve, reject) => {
      loader.parse(canBuf.buffer, "", resolve, reject);
    });
    const canonRig = buildRig(canGltf.scene);
    const targetRig = buildRig(group);

    // Target hip height should match standard humanoid (~0.86m), not 35m
    expect(targetRig.hipHeight).toBeGreaterThan(0.7);
    expect(targetRig.hipHeight).toBeLessThan(1.2);

    const clip = retargetClip(clipGltf.animations[0], canonRig, targetRig);

    // Play Crouch animation with an AnimationMixer
    const mixer = new THREE.AnimationMixer(group);
    const action = mixer.clipAction(clip);
    action.play();

    // Advance mixer into crouch pose
    mixer.update(0.5);
    group.updateMatrixWorld(true);

    // Assert that no bone has exploded
    for (const b of skeleton.bones) {
      const wp = new THREE.Vector3();
      b.getWorldPosition(wp);
      expect(Math.abs(wp.x)).toBeLessThan(3.0);
      expect(Math.abs(wp.y)).toBeLessThan(3.0);
      expect(Math.abs(wp.z)).toBeLessThan(3.0);
    }

    // Assert that skinned vertices do not explode or stretch into space
    const skinnedMeshes: THREE.SkinnedMesh[] = [];
    group.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        skinnedMeshes.push(o as THREE.SkinnedMesh);
      }
    });

    for (const sm of skinnedMeshes) {
      const geom = sm.geometry;
      const pos = geom.attributes.position;
      const si = geom.attributes.skinIndex;
      const sw = geom.attributes.skinWeight;
      for (let i = 0; i < pos.count; i += 10) {
        const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
        const finalP = new THREE.Vector3();
        for (let j = 0; j < 4; j++) {
          const bIdx = si.getComponent(i, j);
          const w = sw.getComponent(i, j);
          if (w > 0) {
            const b = skeleton.bones[bIdx];
            const ibm = skeleton.boneInverses[bIdx];
            finalP.add(p.clone().applyMatrix4(ibm).applyMatrix4(b.matrixWorld).multiplyScalar(w));
          }
        }
        // Skinned vertex must remain in normal crouch humanoid proximity (< 2.5m from origin)
        expect(finalP.length()).toBeLessThan(2.5);
      }
    }
  });

  it("measures and rigs a skinned mesh where its bones put it, not where its raw vertices sit", () => {
    // A doll 0.08 m tall whose one bone scales it up forty times, the way some exports arrive.
    const geom = new THREE.CylinderGeometry(0.015, 0.015, 0.08, 12, 4);
    geom.translate(0, 0.04, 0);
    const n = geom.getAttribute("position").count;
    geom.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
    const weights = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) weights[i * 4] = 1;
    geom.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));

    const bone = new THREE.Bone();
    bone.name = "mixamorig:Hips";
    bone.scale.setScalar(40);
    const root = new THREE.Group();
    const skinned = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
    root.add(bone);
    root.add(skinned);
    // Identity inverse bind: the bone's scale is live, not baked into the bind pose.
    skinned.bind(new THREE.Skeleton([bone], [new THREE.Matrix4()]), new THREE.Matrix4());
    root.updateMatrixWorld(true);

    // Raw geometry says 0.08; the bones say 3.2.
    const raw = new THREE.Vector3();
    geom.computeBoundingBox();
    geom.boundingBox!.getSize(raw);
    expect(raw.y).toBeCloseTo(0.08, 2);
    const seen = new THREE.Vector3();
    computeMeshBounds(root).getSize(seen);
    expect(seen.y).toBeCloseTo(3.2, 1);

    // Brought to the standard height, then re-rigged with the posed shape baked in.
    const b = orientAndGetBounds(root);
    expect(b.size.y).toBeCloseTo(1.8, 1);
    const { group, rootBone } = createRiggedGroup(root, "a_pose");
    const baked = group.children.find((o) => (o as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh;
    baked.geometry.computeBoundingBox();
    const bakedSize = new THREE.Vector3();
    baked.geometry.boundingBox!.getSize(bakedSize);
    expect(bakedSize.y).toBeCloseTo(1.8, 1);
    expect(baked.geometry.getAttribute("skinIndex").count).toBe(n);
    const hips = new THREE.Vector3();
    rootBone.getWorldPosition(hips);
    expect(hips.y).toBeGreaterThan(0.7);
    expect(hips.y).toBeLessThan(1.1);

    // Joints built for the posed body sit inside it. Tested against the raw doll, all of them
    // were outside, which is the "22 joints outside mesh" badge on a model that fits fine.
    const defs = buildHumanoidBoneDefs(b.box, b.size, b.center, "a_pose");
    const res = checkSkeletonContainment(root, defs);
    for (const name of ["mixamorig:Hips", "mixamorig:Spine", "mixamorig:Neck", "mixamorig:Head", "mixamorig:LeftFoot", "mixamorig:RightFoot"]) {
      expect(res.jointStatus.get(name), name).toBe(true);
    }
  });

  it("leaves a model alone when asked only where its joints are", () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 0.4), new THREE.MeshBasicMaterial());
    mesh.position.set(0, 1.5, 0);
    group.add(mesh);
    const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.2), new THREE.Vector3(0.5, 3, 0.2));
    const defs = buildHumanoidBoneDefs(box, new THREE.Vector3(1, 3, 0.4), new THREE.Vector3(0, 1.5, 0), "a_pose");
    checkSkeletonContainment(group, defs);
    // Still 3 m tall and unmoved: a containment check must not rescale the model it inspects.
    expect(group.scale.y).toBe(1);
    expect(mesh.position.y).toBe(1.5);
  });

  /** A humanoid skeleton the way a numbered Sketchfab export spells it, with a twist bone and a stray root. */
  function sketchfabSkeleton(): { bones: THREE.Bone[]; byName: Map<string, THREE.Bone> } {
    const byName = new Map<string, THREE.Bone>();
    const make = (name: string, parent?: string) => {
      const b = new THREE.Bone();
      b.name = name;
      byName.set(name, b);
      if (parent) byName.get(parent)!.add(b);
      return b;
    };
    make("_rootJoint");
    make("mixamorigHips_01", "_rootJoint");
    make("mixamorigSpine_02", "mixamorigHips_01");
    make("mixamorigHead_05", "mixamorigSpine_02");
    make("mixamorigLeftArm_010", "mixamorigSpine_02");
    make("LeftArmTwist_011", "mixamorigLeftArm_010");
    make("mixamorigLeftForeArm_012", "mixamorigLeftArm_010");
    make("mixamorigLeftHand_013", "mixamorigLeftForeArm_012");
    make("mixamorigLeftHandIndex1_014", "mixamorigLeftHand_013");
    make("mixamorigRightArm_030", "mixamorigSpine_02");
    make("mixamorigRightForeArm_031", "mixamorigRightArm_030");
    make("mixamorigLeftUpLeg_055", "mixamorigHips_01");
    make("mixamorigLeftLeg_056", "mixamorigLeftUpLeg_055");
    make("mixamorigRightUpLeg_060", "mixamorigHips_01");
    make("mixamorigRightLeg_061", "mixamorigRightUpLeg_060");
    return { bones: [...byName.values()], byName };
  }

  it("maps an old humanoid skeleton onto the new one by role, and walks up for the rest", () => {
    const { bones } = sketchfabSkeleton();
    const box = new THREE.Box3(new THREE.Vector3(-0.4, 0, -0.2), new THREE.Vector3(0.4, 1.8, 0.2));
    const defs = buildHumanoidBoneDefs(box, new THREE.Vector3(0.8, 1.8, 0.4), new THREE.Vector3(0, 0.9, 0), { includeFingers: false });
    const at = (name: string) => defs.findIndex((d) => d.name === name);
    const map = boneTransferMap(new THREE.Skeleton(bones), defs)!;
    expect(map).not.toBeNull();
    const src = (name: string) => bones.findIndex((b) => b.name === name);
    expect(map[src("mixamorigHips_01")]).toBe(at("mixamorig:Hips"));
    expect(map[src("mixamorigLeftHand_013")]).toBe(at("mixamorig:LeftHand"));
    expect(map[src("mixamorigRightLeg_061")]).toBe(at("mixamorig:RightLeg"));
    // No fingers on the new skeleton: the finger follows the hand. A twist bone follows its arm.
    expect(map[src("mixamorigLeftHandIndex1_014")]).toBe(at("mixamorig:LeftHand"));
    expect(map[src("LeftArmTwist_011")]).toBe(at("mixamorig:LeftArm"));
    // Above the hips there is nothing to follow but the hips.
    expect(map[src("_rootJoint")]).toBe(at("mixamorig:Hips"));

    // Not a humanoid: nothing to carry over.
    const odd = ["a", "b", "c"].map((n) => { const b = new THREE.Bone(); b.name = n; return b; });
    expect(boneTransferMap(new THREE.Skeleton(odd), defs)).toBeNull();
  });

  it("pools weights that land on one bone and keeps the four heaviest, renormalised", () => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(3 * 3), 3));
    // v0: three old bones, two of which now share a new one. v1: nothing weighted. v2: five-way split needs trimming.
    geom.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array([0, 1, 2, 3, 0, 0, 0, 0, 0, 1, 2, 3]), 4));
    geom.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array([0.5, 0.3, 0.2, 0, 0, 0, 0, 0, 0.1, 0.15, 0.3, 0.45]), 4));
    const map = new Int32Array([5, 5, 7, 9]);
    const outI = new Uint16Array(3 * 4);
    const outW = new Float32Array(3 * 4);
    transferSkinWeights(geom, map, outI, outW);
    expect(Array.from(outI.slice(0, 4))).toEqual([5, 7, 0, 0]);
    expect(outW[0]).toBeCloseTo(0.8, 5);
    expect(outW[1]).toBeCloseTo(0.2, 5);
    expect(outW[2]).toBe(0);
    expect(Array.from(outI.slice(4, 8))).toEqual([0, 0, 0, 0]);
    expect(Array.from(outW.slice(4, 8))).toEqual([1, 0, 0, 0]);
    // 0.1 and 0.15 both go to bone 5 (0.25), 0.3 to 7, 0.45 to 9: heaviest first.
    expect(Array.from(outI.slice(8, 12))).toEqual([9, 7, 5, 0]);
    expect(outW[8]).toBeCloseTo(0.45, 5);
    expect(outW[9]).toBeCloseTo(0.3, 5);
    expect(outW[10]).toBeCloseTo(0.25, 5);
  });

  it("re-rigs an already skinned humanoid with its own weights rather than fresh ones", () => {
    const { bones, byName } = sketchfabSkeleton();
    // Stand the bones up so the skeleton reads as Y-up and the mesh has somewhere to be.
    byName.get("mixamorigHips_01")!.position.set(0, 0.9, 0);
    byName.get("mixamorigHead_05")!.position.set(0, 0.7, 0);
    byName.get("mixamorigLeftUpLeg_055")!.position.set(0.1, -0.05, 0);
    byName.get("mixamorigRightUpLeg_060")!.position.set(-0.1, -0.05, 0);
    byName.get("mixamorigLeftArm_010")!.position.set(0.3, 0.55, 0);
    byName.get("mixamorigRightArm_030")!.position.set(-0.3, 0.55, 0);
    // A thin 1.8 m body; every vertex above shoulder height weighted to the LEFT HAND on purpose,
    // which distance-based weighting would never do and a transfer must preserve.
    const geom = new THREE.CylinderGeometry(0.1, 0.1, 1.8, 8, 6);
    geom.translate(0, 0.9, 0);
    const n = geom.getAttribute("position").count;
    const hand = bones.findIndex((b) => b.name === "mixamorigLeftHand_013");
    const hips = bones.findIndex((b) => b.name === "mixamorigHips_01");
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    const pos = geom.getAttribute("position");
    let tagged = 0;
    for (let i = 0; i < n; i++) {
      const high = pos.getY(i) > 1.4;
      si[i * 4] = high ? hand : hips;
      sw[i * 4] = 1;
      if (high) tagged++;
    }
    geom.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
    geom.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
    const root = new THREE.Group();
    const skinned = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
    root.add(byName.get("_rootJoint")!);
    root.add(skinned);
    root.updateMatrixWorld(true);
    skinned.bind(new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4())), new THREE.Matrix4());
    expect(isModelRigged(root)).toBe(true);

    const { group, defs } = createRiggedGroup(root, { includeFingers: false });
    const out = group.children.find((o) => (o as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh;
    const outIdx = out.geometry.getAttribute("skinIndex");
    const leftHand = defs.findIndex((d) => d.name === "mixamorig:LeftHand");
    let stillHand = 0;
    for (let i = 0; i < outIdx.count; i++) if (outIdx.getX(i) === leftHand) stillHand++;
    expect(tagged).toBeGreaterThan(0);
    expect(stillHand).toBe(tagged);
  });
});
