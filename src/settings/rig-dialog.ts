import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { clone as cloneWithSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  buildHumanoidBoneDefs,
  checkSkeletonContainment,
  createRiggedGroup,
  inferRigParamsFromSkeleton,
  orientAndGetBounds,
  type PoseChoice,
  type RigParams,
} from "../autorig";
import { buildRig, canonicalRig, hasOwnSkeleton, retargetClip, type Rig } from "../retarget";
import { loadModel, restoreBindPose } from "../character";
import { listLibrary, type LibraryClip } from "../library";

export interface RigDialogOptions {
  modelName: string;
  root?: THREE.Object3D;
  params?: RigParams;
}

export type RigDialogResult =
  | { action: "rig"; pose: PoseChoice; params: RigParams }
  | { action: "static" }
  | { action: "cancel" };

/**
 * Display an interactive 3D in-app studio for previewing and adjusting the humanoid skeleton.
 * Self-contained: runs in any DOM document (Settings window or Buddy window).
 */
export function showRigDialog(opts: RigDialogOptions): Promise<RigDialogResult> {
  return new Promise<RigDialogResult>((resolve) => {
    // Backdrop
    const overlay = document.createElement("div");
    overlay.className = "rig-dialog-overlay";
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(6px);
      z-index: 100000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      box-sizing: border-box;
      animation: rig-fade-in 0.15s ease-out;
    `;

    // Modal Card
    const card = document.createElement("div");
    card.className = "rig-dialog-card";
    card.style.cssText = `
      background: var(--panel, #1a1c22);
      border: 1px solid var(--border, #2d303a);
      border-radius: 14px;
      padding: 20px;
      width: 1040px;
      max-width: 96vw;
      height: 86vh;
      max-height: 92vh;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7);
      color: var(--text, #e8e9ee);
      font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 14px;
      overflow: hidden;
    `;

    card.innerHTML = `
      <style>
        @keyframes rig-fade-in { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
        .rig-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
        }
        .rig-title {
          margin: 0;
          font-size: 17px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .rig-desc {
          margin: 4px 0 0;
          font-size: 12px;
          color: var(--muted, #9a9daa);
          line-height: 1.35;
        }
        .rig-body {
          display: flex;
          gap: 16px;
          flex: 1;
          min-height: 0;
        }
        .rig-viewport-container {
          flex: 1.25;
          background: #0f1014;
          border: 1px solid var(--border, #2d303a);
          border-radius: 10px;
          position: relative;
          overflow: hidden;
          min-height: 380px;
          display: flex;
        }
        .rig-viewport-canvas {
          width: 100%;
          height: 100%;
          display: block;
          cursor: grab;
        }
        .rig-viewport-canvas:active {
          cursor: grabbing;
        }
        .rig-viewport-top-bar {
          position: absolute;
          top: 10px;
          left: 10px;
          right: 10px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          pointer-events: none;
          z-index: 10;
          gap: 8px;
        }
        .rig-viewport-bottom-bar {
          position: absolute;
          bottom: 10px;
          left: 10px;
          right: 10px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          pointer-events: none;
          z-index: 10;
          gap: 8px;
          flex-wrap: wrap;
        }
        .rig-viewport-hint {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.6);
          background: rgba(0, 0, 0, 0.65);
          padding: 4px 8px;
          border-radius: 4px;
          white-space: nowrap;
          flex-shrink: 0;
          backdrop-filter: blur(4px);
        }
        .rig-containment-badge {
          font-size: 11px;
          font-weight: 600;
          padding: 4px 10px;
          border-radius: 4px;
          background: rgba(40, 167, 69, 0.2);
          border: 1px solid rgba(40, 167, 69, 0.5);
          color: #38ef7d;
          display: flex;
          align-items: center;
          gap: 5px;
          transition: all 0.2s;
          white-space: nowrap;
          flex-shrink: 0;
          pointer-events: auto;
          backdrop-filter: blur(4px);
        }
        .rig-containment-badge.warning {
          background: rgba(220, 53, 69, 0.25);
          border-color: rgba(220, 53, 69, 0.7);
          color: #ff4d4f;
        }
        .rig-viewport-controls {
          pointer-events: auto;
          display: flex;
          gap: 5px;
          align-items: center;
          flex-shrink: 0;
        }
        .rig-mini-btn {
          font-size: 11px;
          padding: 4px 9px;
          border-radius: 4px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: rgba(20, 22, 28, 0.85);
          color: #e8e9ee;
          cursor: pointer;
          white-space: nowrap;
          flex-shrink: 0;
          user-select: none;
          backdrop-filter: blur(4px);
          pointer-events: auto !important;
          transition: background 0.15s, border-color 0.15s;
        }
        .rig-mini-btn:hover {
          background: rgba(45, 50, 65, 0.95);
          border-color: rgba(255, 255, 255, 0.35);
        }
        .rig-mini-btn.active {
          background: var(--accent, #5b9cff);
          border-color: var(--accent, #5b9cff);
          color: #fff;
          font-weight: 600;
        }
        .rig-sidebar {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 12px;
          overflow-y: auto;
          padding-right: 4px;
        }
        .rig-section {
          background: var(--field, #23262f);
          border: 1px solid var(--border, #2d303a);
          border-radius: 8px;
          padding: 10px 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .rig-section-title {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--muted, #9a9daa);
        }
        .rig-pose-selector {
          display: flex;
          gap: 8px;
        }
        .rig-pose-card {
          flex: 1;
          padding: 8px 10px;
          border-radius: 6px;
          border: 1px solid var(--border, #2d303a);
          background: rgba(0, 0, 0, 0.2);
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          transition: border-color 0.15s, background 0.15s;
        }
        .rig-pose-card.selected {
          border-color: var(--accent, #5b9cff);
          background: rgba(91, 156, 255, 0.1);
        }
        .rig-pose-card input {
          accent-color: var(--accent, #5b9cff);
          cursor: pointer;
          margin: 0;
        }
        .rig-pose-label {
          font-size: 12px;
          font-weight: 600;
        }
        .rig-slider-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .rig-slider-header {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          color: var(--text, #e8e9ee);
        }
        .rig-slider-val {
          color: var(--muted, #9a9daa);
        }
        .rig-slider {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 4px;
          border-radius: 2px;
          background: rgba(255, 255, 255, 0.12);
          outline: none;
        }
        .rig-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: var(--accent, #5b9cff);
          cursor: pointer;
          transition: transform 0.1s;
        }
        .rig-slider::-webkit-slider-thumb:hover {
          transform: scale(1.2);
        }
        .rig-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding-top: 4px;
        }
        .rig-btn-row {
          display: flex;
          gap: 8px;
        }
        .rig-btn {
          padding: 8px 16px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          border: 1px solid var(--border, #2d303a);
          background: var(--field, #23262f);
          color: var(--text, #e8e9ee);
          transition: filter 0.15s, background 0.15s;
        }
        .rig-btn:hover {
          background: rgba(255, 255, 255, 0.08);
        }
        .rig-btn-primary {
          background: var(--accent, #5b9cff);
          border-color: var(--accent, #5b9cff);
          color: #fff;
          font-weight: 600;
        }
        .rig-btn-primary:hover {
          filter: brightness(1.1);
        }
      </style>

      <div class="rig-header">
        <div>
          <h2 class="rig-title"><span>🦴</span> Skeleton Studio</h2>
          <p class="rig-desc">Preview and align the <span id="rig-joint-count">${opts.params?.includeFingers ? 52 : 22}</span>-joint Mixamo humanoid skeleton inside <strong style="color: #fff;">${opts.modelName}</strong>.</p>
        </div>
      </div>

      <div class="rig-body">
        <!-- 3D Viewport -->
        <div class="rig-viewport-container">
          <canvas class="rig-viewport-canvas" id="rig-canvas"></canvas>
          <div class="rig-viewport-top-bar">
            <span class="rig-containment-badge" id="containment-badge">🟢 All ${opts.params?.includeFingers ? 52 : 22} joints inside mesh</span>
            <div class="rig-viewport-controls">
              <button type="button" class="rig-mini-btn" id="btn-view-front" title="Snap camera to front view">Front</button>
              <button type="button" class="rig-mini-btn" id="btn-view-side" title="Snap camera to side profile view">Side</button>
              <button type="button" class="rig-mini-btn" id="btn-view-orbit" title="Snap camera to 3/4 perspective">3D Orbit</button>
              <button type="button" class="rig-mini-btn" id="btn-reset-cam" title="Reset camera to center">Reset Cam</button>
            </div>
          </div>
          <div class="rig-viewport-bottom-bar">
            <div style="display: flex; gap: 6px; align-items: center; pointer-events: auto;">
              <span class="rig-viewport-hint">🖱️ Left: Orbit • Right: Pan • Wheel: Zoom</span>
              <button type="button" class="rig-mini-btn active" id="btn-xray" title="Toggle mesh translucency">X-Ray: ON</button>
              <button type="button" class="rig-mini-btn" id="btn-skin" hidden title="Animate the model on the skin weights it already has, or on the ones Auto-Rig will give it">Skin: Current</button>
            </div>
            <div class="rig-viewport-controls" id="anim-preview-controls">
              <span style="font-size: 10px; color: var(--muted, #9a9daa); margin-right: 2px;">Preview:</span>
              <button type="button" class="rig-mini-btn active" id="btn-anim-pose" title="Static bind pose">Pose</button>
              <button type="button" class="rig-mini-btn" id="btn-anim-idle" title="Play Breathing Idle (Mixamo)">Idle</button>
              <button type="button" class="rig-mini-btn" id="btn-anim-walk" title="Play Walk animation">Walk</button>
              <button type="button" class="rig-mini-btn" id="btn-anim-crouch" title="Play Crouch Look Around (Mixamo)">Crouch</button>
              <button type="button" class="rig-mini-btn" id="btn-anim-dance" title="Play Robot Hip Hop (Mixamo)">Dance</button>
              <select class="rig-mini-btn" id="sel-anim-library" title="Preview any animation from library" style="padding: 3px 6px; max-width: 140px; cursor: pointer; text-overflow: ellipsis;">
                <option value="">More Clips...</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Sidebar Controls -->
        <div class="rig-sidebar">
          <!-- Pose Preset -->
          <div class="rig-section">
            <span class="rig-section-title">Base Pose Preset</span>
            <div class="rig-pose-selector">
              <label class="rig-pose-card selected" id="lbl-apose">
                <input type="radio" name="rig-pose" value="a_pose" checked />
                <div>
                  <div class="rig-pose-label">A-Pose</div>
                  <div style="font-size: 10px; color: var(--muted, #9a9daa);">Arms ~45° down</div>
                </div>
              </label>
              <label class="rig-pose-card" id="lbl-tpose">
                <input type="radio" name="rig-pose" value="t_pose" />
                <div>
                  <div class="rig-pose-label">T-Pose</div>
                  <div style="font-size: 10px; color: var(--muted, #9a9daa);">Arms horizontal</div>
                </div>
              </label>
            </div>
          </div>

          <!-- Head & Neck Alignment -->
          <div class="rig-section">
            <span class="rig-section-title">Head & Neck Alignment</span>
            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Head Height</span>
                <span class="rig-slider-val" id="val-head-height">100%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-head-height" min="70" max="130" value="100" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Neck Height</span>
                <span class="rig-slider-val" id="val-neck-height">100%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-neck-height" min="70" max="130" value="100" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Head & Neck Depth</span>
                <span class="rig-slider-val" id="val-head-depth">0%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-head-depth" min="-100" max="100" value="0" />
            </div>
          </div>

          <!-- Arm & Shoulder Alignment -->
          <div class="rig-section">
            <span class="rig-section-title">Arm & Shoulder Alignment</span>
            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Shoulder Height</span>
                <span class="rig-slider-val" id="val-shoulder-height">100%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-shoulder-height" min="70" max="130" value="100" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Shoulder Width</span>
                <span class="rig-slider-val" id="val-shoulder-width">100%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-shoulder-width" min="70" max="140" value="100" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Shoulders Depth</span>
                <span class="rig-slider-val" id="val-shoulder-depth">0%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-shoulder-depth" min="-100" max="100" value="0" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Arm Droop Angle</span>
                <span class="rig-slider-val" id="val-arm-angle">45°</span>
              </div>
              <input type="range" class="rig-slider" id="sld-arm-angle" min="15" max="75" value="45" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Arm Length</span>
                <span class="rig-slider-val" id="val-arm-len">100%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-arm-len" min="70" max="130" value="100" />
            </div>

            <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.08);">
              <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 11px; font-weight: 500; user-select: none;">
                <input type="checkbox" id="chk-fingers" style="accent-color: var(--accent, #5b9cff); cursor: pointer;" />
                <span>Include 5-Finger Hand Bones (30 digits)</span>
              </label>
              <div id="finger-controls" style="display: none; flex-direction: column; gap: 8px; margin-top: 8px; padding: 8px 10px; background: rgba(0,0,0,0.25); border: 1px solid var(--border, #2d303a); border-radius: 6px;">
                <div class="rig-slider-group">
                  <div class="rig-slider-header">
                    <span>Finger Length</span>
                    <span class="rig-slider-val" id="val-finger-len">100%</span>
                  </div>
                  <input type="range" class="rig-slider" id="sld-finger-len" min="50" max="150" value="100" />
                </div>
                <div class="rig-slider-group">
                  <div class="rig-slider-header">
                    <span>Finger Spread</span>
                    <span class="rig-slider-val" id="val-finger-spread">100%</span>
                  </div>
                  <input type="range" class="rig-slider" id="sld-finger-spread" min="50" max="150" value="100" />
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px;">
                  <span style="font-size: 11px; color: var(--text, #e8e9ee);">Thumb Direction</span>
                  <button type="button" class="rig-mini-btn" id="btn-thumb-dir" style="font-size: 10px; padding: 3px 8px;">Thumb: Forward (+Z)</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Hips & Spine Alignment -->
          <div class="rig-section">
            <span class="rig-section-title">Hips & Spine Alignment</span>
            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Hip / Pelvis Height</span>
                <span class="rig-slider-val" id="val-hip-height">100%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-hip-height" min="80" max="120" value="100" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Pelvis / Hip Width</span>
                <span class="rig-slider-val" id="val-leg-width">100%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-leg-width" min="60" max="160" value="100" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Torso / Spine Depth</span>
                <span class="rig-slider-val" id="val-spine-depth">0%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-spine-depth" min="-100" max="100" value="0" />
            </div>
          </div>

          <!-- Legs & Feet Alignment -->
          <div class="rig-section">
            <span class="rig-section-title">Legs & Feet Alignment</span>
            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Knee Stance (Angle)</span>
                <span class="rig-slider-val" id="val-knee-width">100%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-knee-width" min="60" max="180" value="100" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Knee Height</span>
                <span class="rig-slider-val" id="val-knee-height">100%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-knee-height" min="70" max="130" value="100" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Knees Depth</span>
                <span class="rig-slider-val" id="val-knee-depth">0%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-knee-depth" min="-100" max="100" value="0" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Ankle Height (Shin Length)</span>
                <span class="rig-slider-val" id="val-ankle-height">100%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-ankle-height" min="25" max="160" value="100" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Foot / Ankle Width</span>
                <span class="rig-slider-val" id="val-foot-width">100%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-foot-width" min="60" max="200" value="100" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Foot Forward Length</span>
                <span class="rig-slider-val" id="val-foot-fwd">100%</span>
              </div>
              <input type="range" class="rig-slider" id="sld-foot-fwd" min="50" max="200" value="100" />
            </div>

            <div class="rig-slider-group">
              <div class="rig-slider-header">
                <span>Foot Outward Angle</span>
                <span class="rig-slider-val" id="val-foot-angle">0°</span>
              </div>
              <input type="range" class="rig-slider" id="sld-foot-angle" min="-10" max="45" value="0" />
            </div>
          </div>
        </div>
      </div>

      <div class="rig-footer">
        <button type="button" class="rig-btn" id="btn-static" title="Import model without skeleton/animations">Import as Static</button>
        <div class="rig-btn-row">
          <button type="button" class="rig-btn" id="btn-cancel">Cancel</button>
          <button type="button" class="rig-btn rig-btn-primary" id="btn-autorig">Auto-Rig & Import</button>
        </div>
      </div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Setup Three.js 3D Viewport
    const canvas = card.querySelector<HTMLCanvasElement>("#rig-canvas")!;
    let renderer3d: THREE.WebGLRenderer | null = null;
    let animId = 0;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111317);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 1.2);
    scene.add(ambient);
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.8);
    dirLight1.position.set(2, 4, 3);
    scene.add(dirLight1);
    const dirLight2 = new THREE.DirectionalLight(0x5b9cff, 1.0);
    dirLight2.position.set(-2, 2, -3);
    scene.add(dirLight2);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

    // Clone model for preview
    let previewModel: THREE.Object3D | null = null;
    let previewSkinnedGroup: THREE.Object3D | null = null;
    let previewMixer: THREE.AnimationMixer | null = null;
    let boundsBox = new THREE.Box3();
    let boundsSize = new THREE.Vector3(1, 2, 1);
    let boundsCenter = new THREE.Vector3(0, 1, 0);

    if (opts.root) {
      restoreBindPose(opts.root);
      // Not a plain clone: that leaves the copied meshes bound to the original's bones, which
      // are not in this scene, so the mesh and the skeleton drawn over it end up different sizes.
      previewModel = cloneWithSkeleton(opts.root);
      // Deep clone all materials so preview adjustments/X-ray never mutate the source model
      previewModel.traverse((o: any) => {
        if (o.isMesh && o.material) {
          if (Array.isArray(o.material)) {
            o.material = o.material.map((m: any) => m.clone());
          } else {
            o.material = o.material.clone();
          }
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            m.userData.__origProps = {
              transparent: m.transparent,
              opacity: m.opacity,
              depthWrite: m.depthWrite,
            };
          }
        }
      });
      const b = orientAndGetBounds(previewModel);
      boundsBox = b.box;
      boundsSize = b.size;
      boundsCenter = b.center;
      scene.add(previewModel);
    }

    // Camera framing & Orbit/Pan controls
    const maxDim = Math.max(boundsSize.x, boundsSize.y, boundsSize.z);
    const camDist = maxDim * 1.6;
    const initialCamPos = new THREE.Vector3(
      boundsCenter.x,
      boundsCenter.y + camDist * 0.15,
      boundsCenter.z + camDist,
    );
    camera.position.copy(initialCamPos);
    camera.lookAt(boundsCenter);

    const controls = new OrbitControls(camera, canvas);
    controls.target.copy(boundsCenter);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = Math.max(0.1, maxDim * 0.2);
    controls.maxDistance = maxDim * 6.0;

    // Suppress right-click context menu so right-drag pan is smooth
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    canvas.addEventListener("contextmenu", onContextMenu);

    // Camera snap buttons
    card.querySelector<HTMLButtonElement>("#btn-view-front")?.addEventListener("click", () => {
      camera.position.set(boundsCenter.x, boundsCenter.y, boundsCenter.z + camDist);
      controls.target.copy(boundsCenter);
      controls.update();
    });
    card.querySelector<HTMLButtonElement>("#btn-view-side")?.addEventListener("click", () => {
      camera.position.set(boundsCenter.x + camDist, boundsCenter.y, boundsCenter.z);
      controls.target.copy(boundsCenter);
      controls.update();
    });
    card.querySelector<HTMLButtonElement>("#btn-view-orbit")?.addEventListener("click", () => {
      camera.position.set(
        boundsCenter.x + camDist * 0.7,
        boundsCenter.y + camDist * 0.35,
        boundsCenter.z + camDist * 0.7,
      );
      controls.target.copy(boundsCenter);
      controls.update();
    });
    card.querySelector<HTMLButtonElement>("#btn-reset-cam")?.addEventListener("click", () => {
      camera.position.copy(initialCamPos);
      controls.target.copy(boundsCenter);
      controls.update();
    });

    // X-Ray Mode
    let xrayEnabled = true;
    const btnXray = card.querySelector<HTMLButtonElement>("#btn-xray");
    // Which skin the clip preview animates. A model that arrived with a skeleton is shown on its
    // own weights by default -- what the desktop and the Animations tab show -- and can be flipped
    // to the ones Auto-Rig & Import would give it. A model with no skin has only the new ones.
    let skinMode: "current" | "new" = opts.root && hasOwnSkeleton(opts.root) ? "current" : "new";
    const btnSkin = card.querySelector<HTMLButtonElement>("#btn-skin");
    if (btnSkin && skinMode === "current") btnSkin.hidden = false;
    function updateXrayButton() {
      if (!btnXray) return;
      btnXray.textContent = xrayEnabled ? "X-Ray: ON" : "X-Ray: OFF";
      btnXray.classList.toggle("active", xrayEnabled);
    }
    function applyXray() {
      const targets = [previewModel, previewSkinnedGroup].filter(Boolean);
      for (const target of targets) {
        target?.traverse((o: any) => {
          if (o.isMesh && o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
              const orig = m.userData.__origProps;
              if (xrayEnabled) {
                m.transparent = true;
                m.opacity = 0.55;
                m.depthWrite = true;
              } else if (orig) {
                m.transparent = orig.transparent;
                m.opacity = orig.opacity;
                m.depthWrite = orig.depthWrite;
              } else {
                m.transparent = false;
                m.opacity = 1.0;
                m.depthWrite = true;
              }
              m.needsUpdate = true;
            }
          }
        });
      }
      updateXrayButton();
    }
    applyXray();

    // 3D Skeleton Visualizer Group
    const skeletonVisualizer = new THREE.Group();
    scene.add(skeletonVisualizer);

    const jointGeo = new THREE.SphereGeometry(Math.max(0.015, boundsSize.y * 0.022), 12, 12);
    const jointGeoFinger = new THREE.SphereGeometry(Math.max(0.003, boundsSize.y * 0.005), 8, 8);
    const jointMatCyan = new THREE.MeshBasicMaterial({ color: 0x00f0ff, depthTest: false, transparent: true });
    const jointMatGold = new THREE.MeshBasicMaterial({ color: 0xffd700, depthTest: false, transparent: true });
    const jointMatRed = new THREE.MeshBasicMaterial({ color: 0xff3b30, depthTest: false, transparent: true });
    const ringGeo = new THREE.RingGeometry(Math.max(0.018, boundsSize.y * 0.026), Math.max(0.024, boundsSize.y * 0.034), 16);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff3b30, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.85 });
    const lineMatArm = new THREE.LineBasicMaterial({ color: 0x00d4ff, linewidth: 2, depthTest: false });
    const lineMatFinger = new THREE.LineBasicMaterial({ color: 0x5b9cff, linewidth: 1, depthTest: false });
    const lineMatLeg = new THREE.LineBasicMaterial({ color: 0x38ef7d, linewidth: 2, depthTest: false });
    const lineMatSpine = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 3, depthTest: false });
    const lineMatRed = new THREE.LineBasicMaterial({ color: 0xff3b30, linewidth: 2, depthTest: false });

    // Parameters state
    const params: RigParams = {
      pose: "a_pose",
      armAngleDeg: 45,
      shoulderWidth: 1.0,
      armLength: 1.0,
      hipHeight: 1.0,
      legWidth: 1.0,
      kneeWidth: 1.0,
      kneeHeight: 1.0,
      ankleHeight: 1.0,
      footWidth: 1.0,
      footForward: 1.0,
      footAngleDeg: 0,
      shoulderHeight: 1.0,
      neckHeight: 1.0,
      headHeight: 1.0,
      headDepth: 0,
      spineDepth: 0,
      shoulderDepth: 0,
      kneeDepth: 0,
      includeFingers: false,
      fingerLength: 1.0,
      fingerSpread: 1.0,
      thumbForward: true,
      ...(opts.params ?? {}),
    };

    // If no explicit params were passed, but the model has an existing humanoid skeleton,
    // infer the params directly from the model's actual bone positions!
    if (!opts.params && opts.root) {
      const inferred = inferRigParamsFromSkeleton(opts.root);
      if (inferred) {
        Object.assign(params, inferred);
      }
    }

    const containmentBadge = card.querySelector<HTMLElement>("#containment-badge");
    let containmentTimer = 0;

    function runContainmentCheck() {
      const defs = buildHumanoidBoneDefs(boundsBox, boundsSize, boundsCenter, params);
      const containment = checkSkeletonContainment(previewModel, defs);

      if (containmentBadge) {
        if (containment.allInside) {
          containmentBadge.className = "rig-containment-badge";
          containmentBadge.textContent = `🟢 All ${containment.insideCount} joints inside mesh`;
        } else {
          containmentBadge.className = "rig-containment-badge warning";
          containmentBadge.textContent = `⚠️ ${containment.outsideCount} joint${containment.outsideCount > 1 ? "s" : ""} outside mesh`;
        }
      }
    }

    function updateSkeletonVisualizer(debounceContainment = true) {
      while (skeletonVisualizer.children.length > 0) {
        skeletonVisualizer.remove(skeletonVisualizer.children[0]);
      }

      const defs = buildHumanoidBoneDefs(boundsBox, boundsSize, boundsCenter, params);
      const defMap = new Map(defs.map((d) => [d.name, d]));

      for (const d of defs) {
        const isSpine = d.name.includes("Hips") || d.name.includes("Spine") || d.name.includes("Neck") || d.name.includes("Head");
        const isLeg = d.name.includes("Leg") || d.name.includes("Foot") || d.name.includes("Toe");
        const isFinger = d.name.includes("Thumb") || d.name.includes("Index") || d.name.includes("Middle") || d.name.includes("Ring") || d.name.includes("Pinky");

        const mat = isSpine ? jointMatGold : jointMatCyan;
        const jMesh = new THREE.Mesh(isFinger ? jointGeoFinger : jointGeo, mat);
        jMesh.position.copy(d.head);
        skeletonVisualizer.add(jMesh);

        if (d.parent && defMap.has(d.parent)) {
          const parentDef = defMap.get(d.parent)!;
          const lineGeo = new THREE.BufferGeometry().setFromPoints([parentDef.head, d.head]);
          const lineMat = isFinger
            ? lineMatFinger
            : isSpine
            ? lineMatSpine
            : isLeg
            ? lineMatLeg
            : lineMatArm;
          const line = new THREE.Line(lineGeo, lineMat);
          skeletonVisualizer.add(line);
        }
      }

      if (debounceContainment) {
        window.clearTimeout(containmentTimer);
        containmentTimer = window.setTimeout(runContainmentCheck, 120);
      } else {
        runContainmentCheck();
      }
    }
    updateSkeletonVisualizer(false);

    // Animation Preview Controls & Invalidation State
    let currentAnim = "pose";
    const cachedClips = new Map<string, THREE.AnimationClip>();
    let cachedCanon: Rig | null = null;
    let animDirty = true;

    function invalidateAnim() {
      animDirty = true;
      cachedClips.clear();
      const sel = card.querySelector<HTMLSelectElement>("#sel-anim-library");
      if (sel) sel.value = "";
      if (currentAnim !== "pose") {
        void setPreviewAnimation("pose");
      }
    }

    // DOM Controls Binding - Head & Neck
    const sldHeadHeight = card.querySelector<HTMLInputElement>("#sld-head-height")!;
    const valHeadHeight = card.querySelector<HTMLElement>("#val-head-height")!;
    const sldNeckHeight = card.querySelector<HTMLInputElement>("#sld-neck-height")!;
    const valNeckHeight = card.querySelector<HTMLElement>("#val-neck-height")!;
    const sldHeadDepth = card.querySelector<HTMLInputElement>("#sld-head-depth")!;
    const valHeadDepth = card.querySelector<HTMLElement>("#val-head-depth")!;

    sldHeadHeight.addEventListener("input", () => {
      params.headHeight = parseFloat(sldHeadHeight.value) / 100;
      valHeadHeight.textContent = `${sldHeadHeight.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldNeckHeight.addEventListener("input", () => {
      params.neckHeight = parseFloat(sldNeckHeight.value) / 100;
      valNeckHeight.textContent = `${sldNeckHeight.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldHeadDepth.addEventListener("input", () => {
      params.headDepth = parseFloat(sldHeadDepth.value) / 100;
      valHeadDepth.textContent = `${sldHeadDepth.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    // DOM Controls Binding - Arms & Shoulders
    const sldShoulderHeight = card.querySelector<HTMLInputElement>("#sld-shoulder-height")!;
    const valShoulderHeight = card.querySelector<HTMLElement>("#val-shoulder-height")!;
    const sldShoulderWidth = card.querySelector<HTMLInputElement>("#sld-shoulder-width")!;
    const valShoulderWidth = card.querySelector<HTMLElement>("#val-shoulder-width")!;
    const sldShoulderDepth = card.querySelector<HTMLInputElement>("#sld-shoulder-depth")!;
    const valShoulderDepth = card.querySelector<HTMLElement>("#val-shoulder-depth")!;
    const sldArmAngle = card.querySelector<HTMLInputElement>("#sld-arm-angle")!;
    const valArmAngle = card.querySelector<HTMLElement>("#val-arm-angle")!;
    const sldArmLen = card.querySelector<HTMLInputElement>("#sld-arm-len")!;
    const valArmLen = card.querySelector<HTMLElement>("#val-arm-len")!;

    sldShoulderHeight.addEventListener("input", () => {
      params.shoulderHeight = parseFloat(sldShoulderHeight.value) / 100;
      valShoulderHeight.textContent = `${sldShoulderHeight.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldShoulderWidth.addEventListener("input", () => {
      params.shoulderWidth = parseFloat(sldShoulderWidth.value) / 100;
      valShoulderWidth.textContent = `${sldShoulderWidth.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldShoulderDepth.addEventListener("input", () => {
      params.shoulderDepth = parseFloat(sldShoulderDepth.value) / 100;
      valShoulderDepth.textContent = `${sldShoulderDepth.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldArmAngle.addEventListener("input", () => {
      params.armAngleDeg = parseFloat(sldArmAngle.value);
      valArmAngle.textContent = `${params.armAngleDeg}°`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldArmLen.addEventListener("input", () => {
      params.armLength = parseFloat(sldArmLen.value) / 100;
      valArmLen.textContent = `${sldArmLen.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    // 5-Finger Controls
    const chkFingers = card.querySelector<HTMLInputElement>("#chk-fingers");
    const fingerControls = card.querySelector<HTMLElement>("#finger-controls");
    const sldFingerLen = card.querySelector<HTMLInputElement>("#sld-finger-len");
    const valFingerLen = card.querySelector<HTMLElement>("#val-finger-len");
    const sldFingerSpread = card.querySelector<HTMLInputElement>("#sld-finger-spread");
    const valFingerSpread = card.querySelector<HTMLElement>("#val-finger-spread");
    const btnThumbDir = card.querySelector<HTMLButtonElement>("#btn-thumb-dir");

    function updateFingerControlsVisibility() {
      if (fingerControls) {
        fingerControls.style.display = params.includeFingers ? "flex" : "none";
      }
      const rigJointCount = card.querySelector<HTMLElement>("#rig-joint-count");
      if (rigJointCount) {
        rigJointCount.textContent = params.includeFingers ? "52" : "22";
      }
    }

    if (chkFingers) {
      chkFingers.checked = !!params.includeFingers;
      updateFingerControlsVisibility();
      chkFingers.addEventListener("change", () => {
        params.includeFingers = chkFingers.checked;
        updateFingerControlsVisibility();
        invalidateAnim();
        updateSkeletonVisualizer();
      });
    }

    sldFingerLen?.addEventListener("input", () => {
      params.fingerLength = parseFloat(sldFingerLen.value) / 100;
      if (valFingerLen) valFingerLen.textContent = `${sldFingerLen.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldFingerSpread?.addEventListener("input", () => {
      params.fingerSpread = parseFloat(sldFingerSpread.value) / 100;
      if (valFingerSpread) valFingerSpread.textContent = `${sldFingerSpread.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    function updateThumbButtonText() {
      if (!btnThumbDir) return;
      btnThumbDir.textContent = (params.thumbForward ?? true) ? "Thumb: Forward (+Z)" : "Thumb: Backward (-Z)";
      btnThumbDir.classList.toggle("active", !(params.thumbForward ?? true));
    }

    btnThumbDir?.addEventListener("click", () => {
      params.thumbForward = !(params.thumbForward ?? true);
      updateThumbButtonText();
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    // DOM Controls Binding - Hips & Spine
    const sldHipHeight = card.querySelector<HTMLInputElement>("#sld-hip-height")!;
    const valHipHeight = card.querySelector<HTMLElement>("#val-hip-height")!;
    const sldLegWidth = card.querySelector<HTMLInputElement>("#sld-leg-width")!;
    const valLegWidth = card.querySelector<HTMLElement>("#val-leg-width")!;
    const sldSpineDepth = card.querySelector<HTMLInputElement>("#sld-spine-depth")!;
    const valSpineDepth = card.querySelector<HTMLElement>("#val-spine-depth")!;

    sldHipHeight.addEventListener("input", () => {
      params.hipHeight = parseFloat(sldHipHeight.value) / 100;
      valHipHeight.textContent = `${sldHipHeight.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldLegWidth.addEventListener("input", () => {
      params.legWidth = parseFloat(sldLegWidth.value) / 100;
      valLegWidth.textContent = `${sldLegWidth.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldSpineDepth.addEventListener("input", () => {
      params.spineDepth = parseFloat(sldSpineDepth.value) / 100;
      valSpineDepth.textContent = `${sldSpineDepth.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    // DOM Controls Binding - Legs & Feet
    const sldKneeWidth = card.querySelector<HTMLInputElement>("#sld-knee-width")!;
    const valKneeWidth = card.querySelector<HTMLElement>("#val-knee-width")!;
    const sldKneeHeight = card.querySelector<HTMLInputElement>("#sld-knee-height")!;
    const valKneeHeight = card.querySelector<HTMLElement>("#val-knee-height")!;
    const sldKneeDepth = card.querySelector<HTMLInputElement>("#sld-knee-depth")!;
    const valKneeDepth = card.querySelector<HTMLElement>("#val-knee-depth")!;
    const sldAnkleHeight = card.querySelector<HTMLInputElement>("#sld-ankle-height")!;
    const valAnkleHeight = card.querySelector<HTMLElement>("#val-ankle-height")!;
    const sldFootWidth = card.querySelector<HTMLInputElement>("#sld-foot-width")!;
    const valFootWidth = card.querySelector<HTMLElement>("#val-foot-width")!;
    const sldFootFwd = card.querySelector<HTMLInputElement>("#sld-foot-fwd")!;
    const valFootFwd = card.querySelector<HTMLElement>("#val-foot-fwd")!;
    const sldFootAngle = card.querySelector<HTMLInputElement>("#sld-foot-angle")!;
    const valFootAngle = card.querySelector<HTMLElement>("#val-foot-angle")!;

    sldKneeWidth.addEventListener("input", () => {
      params.kneeWidth = parseFloat(sldKneeWidth.value) / 100;
      valKneeWidth.textContent = `${sldKneeWidth.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldKneeHeight.addEventListener("input", () => {
      params.kneeHeight = parseFloat(sldKneeHeight.value) / 100;
      valKneeHeight.textContent = `${sldKneeHeight.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldKneeDepth.addEventListener("input", () => {
      params.kneeDepth = parseFloat(sldKneeDepth.value) / 100;
      valKneeDepth.textContent = `${sldKneeDepth.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldAnkleHeight?.addEventListener("input", () => {
      params.ankleHeight = parseFloat(sldAnkleHeight.value) / 100;
      valAnkleHeight.textContent = `${sldAnkleHeight.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldFootWidth.addEventListener("input", () => {
      params.footWidth = parseFloat(sldFootWidth.value) / 100;
      valFootWidth.textContent = `${sldFootWidth.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldFootFwd.addEventListener("input", () => {
      params.footForward = parseFloat(sldFootFwd.value) / 100;
      valFootFwd.textContent = `${sldFootFwd.value}%`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    sldFootAngle.addEventListener("input", () => {
      params.footAngleDeg = parseFloat(sldFootAngle.value);
      valFootAngle.textContent = `${params.footAngleDeg}°`;
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    // Pose Radio Selection
    const lblApose = card.querySelector<HTMLLabelElement>("#lbl-apose")!;
    const lblTpose = card.querySelector<HTMLLabelElement>("#lbl-tpose")!;

    lblApose.addEventListener("click", () => {
      params.pose = "a_pose";
      lblApose.classList.add("selected");
      lblTpose.classList.remove("selected");
      sldArmAngle.disabled = false;
      sldArmAngle.value = "45";
      params.armAngleDeg = 45;
      valArmAngle.textContent = "45°";
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    lblTpose.addEventListener("click", () => {
      params.pose = "t_pose";
      lblTpose.classList.add("selected");
      lblApose.classList.remove("selected");
      sldArmAngle.disabled = true;
      sldArmAngle.value = "0";
      params.armAngleDeg = 0;
      valArmAngle.textContent = "0° (Horizontal)";
      invalidateAnim();
      updateSkeletonVisualizer();
    });

    // Synchronize all DOM controls to initial params (whether inferred from existing skeleton or passed in)
    function syncControlsToParams() {
      sldHeadHeight.value = String(Math.round((params.headHeight ?? 1.0) * 100));
      valHeadHeight.textContent = `${sldHeadHeight.value}%`;
      sldNeckHeight.value = String(Math.round((params.neckHeight ?? 1.0) * 100));
      valNeckHeight.textContent = `${sldNeckHeight.value}%`;
      sldHeadDepth.value = String(Math.round((params.headDepth ?? 0) * 100));
      valHeadDepth.textContent = `${sldHeadDepth.value}%`;

      sldShoulderHeight.value = String(Math.round((params.shoulderHeight ?? 1.0) * 100));
      valShoulderHeight.textContent = `${sldShoulderHeight.value}%`;
      sldShoulderWidth.value = String(Math.round((params.shoulderWidth ?? 1.0) * 100));
      valShoulderWidth.textContent = `${sldShoulderWidth.value}%`;
      sldShoulderDepth.value = String(Math.round((params.shoulderDepth ?? 0) * 100));
      valShoulderDepth.textContent = `${sldShoulderDepth.value}%`;
      sldArmAngle.value = String(Math.round(params.armAngleDeg ?? (params.pose === "t_pose" ? 0 : 45)));
      valArmAngle.textContent = `${sldArmAngle.value}°`;
      sldArmLen.value = String(Math.round((params.armLength ?? 1.0) * 100));
      valArmLen.textContent = `${sldArmLen.value}%`;

      if (chkFingers) {
        chkFingers.checked = !!params.includeFingers;
        updateFingerControlsVisibility();
      }
      if (sldFingerLen) {
        sldFingerLen.value = String(Math.round((params.fingerLength ?? 1.0) * 100));
        if (valFingerLen) valFingerLen.textContent = `${sldFingerLen.value}%`;
      }
      if (sldFingerSpread) {
        sldFingerSpread.value = String(Math.round((params.fingerSpread ?? 1.0) * 100));
        if (valFingerSpread) valFingerSpread.textContent = `${sldFingerSpread.value}%`;
      }
      updateThumbButtonText();

      sldHipHeight.value = String(Math.round((params.hipHeight ?? 1.0) * 100));
      valHipHeight.textContent = `${sldHipHeight.value}%`;
      sldLegWidth.value = String(Math.round((params.legWidth ?? 1.0) * 100));
      valLegWidth.textContent = `${sldLegWidth.value}%`;
      sldSpineDepth.value = String(Math.round((params.spineDepth ?? 0) * 100));
      valSpineDepth.textContent = `${sldSpineDepth.value}%`;

      sldKneeWidth.value = String(Math.round((params.kneeWidth ?? 1.0) * 100));
      valKneeWidth.textContent = `${sldKneeWidth.value}%`;
      sldKneeHeight.value = String(Math.round((params.kneeHeight ?? 1.0) * 100));
      valKneeHeight.textContent = `${sldKneeHeight.value}%`;
      sldKneeDepth.value = String(Math.round((params.kneeDepth ?? 0) * 100));
      valKneeDepth.textContent = `${sldKneeDepth.value}%`;
      if (sldAnkleHeight) {
        sldAnkleHeight.value = String(Math.round((params.ankleHeight ?? 1.0) * 100));
        valAnkleHeight.textContent = `${sldAnkleHeight.value}%`;
      }
      sldFootWidth.value = String(Math.round((params.footWidth ?? 1.0) * 100));
      valFootWidth.textContent = `${sldFootWidth.value}%`;
      sldFootFwd.value = String(Math.round((params.footForward ?? 1.0) * 100));
      valFootFwd.textContent = `${sldFootFwd.value}%`;
      sldFootAngle.value = String(Math.round(params.footAngleDeg ?? 0));
      valFootAngle.textContent = `${sldFootAngle.value}°`;

      if (params.pose === "t_pose") {
        lblTpose.classList.add("selected");
        lblApose.classList.remove("selected");
        sldArmAngle.disabled = true;
        valArmAngle.textContent = "0° (Horizontal)";
      } else {
        lblApose.classList.add("selected");
        lblTpose.classList.remove("selected");
        sldArmAngle.disabled = false;
      }
    }
    syncControlsToParams();
    updateSkeletonVisualizer(false);

    // X-Ray Toggle
    btnXray?.addEventListener("click", () => {
      xrayEnabled = !xrayEnabled;
      applyXray();
    });
    btnSkin?.addEventListener("click", () => {
      skinMode = skinMode === "current" ? "new" : "current";
      btnSkin.textContent = skinMode === "current" ? "Skin: Current" : "Skin: New";
      btnSkin.classList.toggle("active", skinMode === "new");
      // The animated copy is built for one skin or the other; throw it away and, if a quick clip
      // is playing, bring it straight back on the other one.
      invalidateAnim();
      if (currentAnim !== "pose") void setPreviewAnimation(currentAnim);
    });

    // Animation Preview Controls & Playback
    const btnAnimPose = card.querySelector<HTMLButtonElement>("#btn-anim-pose");
    const btnAnimIdle = card.querySelector<HTMLButtonElement>("#btn-anim-idle");
    const btnAnimWalk = card.querySelector<HTMLButtonElement>("#btn-anim-walk");
    const btnAnimCrouch = card.querySelector<HTMLButtonElement>("#btn-anim-crouch");
    const btnAnimDance = card.querySelector<HTMLButtonElement>("#btn-anim-dance");
    const selAnimLibrary = card.querySelector<HTMLSelectElement>("#sel-anim-library");

    const animBtns: Record<string, HTMLButtonElement | null> = {
      pose: btnAnimPose,
      Breathing_Idle: btnAnimIdle,
      Walk_Loop: btnAnimWalk,
      Crouch_Look_Around: btnAnimCrouch,
      Robot_Hip_Hop: btnAnimDance,
    };

    const quickClipUrls: Record<string, string> = {
      Breathing_Idle: "/clips/mixamo/Breathing_Idle.glb",
      Walk_Loop: "/clips/ual/Walk_Loop.glb",
      Crouch_Look_Around: "/clips/mixamo/Crouch_Look_Around.glb",
      Robot_Hip_Hop: "/clips/mixamo/Robot_Hip_Hop.glb",
    };

    // Populate animation library dropdown from shared library
    void (async () => {
      try {
        const allClips = await listLibrary();

        const mixamoDances: LibraryClip[] = [];
        const mixamoIdles: LibraryClip[] = [];
        const actionsLocomotion: LibraryClip[] = [];
        const userClips: LibraryClip[] = [];
        const ualClips: LibraryClip[] = [];

        for (const c of allClips) {
          if (c.source === "user") {
            userClips.push(c);
          } else if (c.source === "mixamo") {
            const n = c.name.toLowerCase();
            if (
              n.includes("dance") || n.includes("hip_hop") || n.includes("twist") ||
              n.includes("style") || n.includes("salsa") || n.includes("samba") ||
              n.includes("bboy") || n.includes("rumba") || n.includes("ymca") ||
              n.includes("shuffling") || n.includes("charleston") || n.includes("running_man") ||
              n.includes("side_to_side")
            ) {
              mixamoDances.push(c);
            } else if (n.includes("idle") || n.includes("bored") || n.includes("texting")) {
              mixamoIdles.push(c);
            } else {
              actionsLocomotion.push(c);
            }
          } else {
            ualClips.push(c);
          }
        }

        const addGroup = (label: string, clips: LibraryClip[]) => {
          if (clips.length === 0 || !selAnimLibrary) return;
          const grp = document.createElement("optgroup");
          grp.label = label;
          for (const c of clips) {
            const opt = document.createElement("option");
            opt.value = c.url;
            opt.dataset.name = c.name;
            opt.textContent = c.name.replace(/_/g, " ");
            grp.appendChild(opt);
          }
          selAnimLibrary.appendChild(grp);
        };

        addGroup("Mixamo Dances", mixamoDances);
        addGroup("Mixamo Idles & Moods", mixamoIdles);
        addGroup("Actions & Locomotion", actionsLocomotion);
        if (userClips.length > 0) addGroup("Custom User Clips", userClips);
        addGroup("Classic / UAL Animations", ualClips);
      } catch (err) {
        console.warn("Could not populate animation library in rig dialog:", err);
      }
    })();

    async function setPreviewAnimation(clipName: string, clipUrl?: string) {
      if (currentAnim === clipName && !animDirty) return;

      for (const [k, btn] of Object.entries(animBtns)) {
        btn?.classList.toggle("active", k === clipName);
      }

      if (selAnimLibrary) {
        selAnimLibrary.value = clipUrl ?? quickClipUrls[clipName] ?? "";
      }

      if (clipName === "pose") {
        currentAnim = "pose";
        if (previewMixer) {
          previewMixer.stopAllAction();
        }
        if (previewSkinnedGroup) {
          scene.remove(previewSkinnedGroup);
          previewSkinnedGroup.traverse((o: any) => {
            if (o.isMesh) {
              if (o.geometry) o.geometry.dispose();
              const mats = Array.isArray(o.material) ? o.material : [o.material];
              for (const m of mats) m?.dispose?.();
            }
          });
          previewSkinnedGroup = null;
        }
        if (previewModel) previewModel.visible = true;
        skeletonVisualizer.visible = true;
        applyXray();
        return;
      }

      if (!previewModel) return;

      const url = clipUrl ?? quickClipUrls[clipName];
      if (!url) return;

      const targetBtn = animBtns[clipName];
      const origText = targetBtn?.textContent ?? "";
      if (targetBtn) targetBtn.textContent = "⏳...";

      try {
        // If skinned group is not built or params changed, rebuild it
        if (!previewSkinnedGroup || animDirty) {
          if (previewSkinnedGroup) {
            scene.remove(previewSkinnedGroup);
            previewSkinnedGroup.traverse((o: any) => {
              if (o.isMesh) {
                if (o.geometry) o.geometry.dispose();
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                for (const m of mats) m?.dispose?.();
              }
            });
            previewSkinnedGroup = null;
          }

          // Clone previewModel and restore original materials on clone for preview
          const modelForRig = cloneWithSkeleton(previewModel);
          modelForRig.traverse((o: any) => {
            if (o.isMesh && o.material) {
              const mats = Array.isArray(o.material) ? o.material : [o.material];
              for (const m of mats) {
                const orig = m.userData?.__origProps;
                if (orig) {
                  m.transparent = orig.transparent;
                  m.opacity = orig.opacity;
                  m.depthWrite = orig.depthWrite;
                } else {
                  m.transparent = false;
                  m.opacity = 1.0;
                  m.depthWrite = true;
                }
                m.needsUpdate = true;
              }
            }
          });

          if (skinMode === "current") {
            // Its own skeleton and weights, exactly as the desktop plays it.
            previewSkinnedGroup = modelForRig;
          } else {
            const { group } = createRiggedGroup(modelForRig, params);
            previewSkinnedGroup = group;
          }
          scene.add(previewSkinnedGroup);
          previewMixer = new THREE.AnimationMixer(previewSkinnedGroup);
          animDirty = false;
          applyXray();
        }

        // Hide static preview model and skeleton visualizer
        previewModel.visible = false;
        skeletonVisualizer.visible = false;

        // Load and retarget clip if not cached
        let clip = cachedClips.get(clipName);
        if (!clip) {
          const extra = await loadModel(url);
          const raw = extra.animations[0];
          if (!raw) throw new Error(`Clip "${clipName}" contains no animations`);
          if (!cachedCanon) {
            cachedCanon = await canonicalRig();
          }
          const sourceRig = hasOwnSkeleton(extra.root) ? buildRig(extra.root) : cachedCanon;
          const targetRig = buildRig(previewSkinnedGroup);
          clip = retargetClip(raw, sourceRig, targetRig);
          clip.name = clipName;
          cachedClips.set(clipName, clip);
        }

        if (previewMixer) {
          previewMixer.stopAllAction();
          const action = previewMixer.clipAction(clip);
          action.reset();
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.play();
        }

        currentAnim = clipName;
      } catch (err) {
        console.warn(`Failed to play preview animation "${clipName}":`, err);
        void setPreviewAnimation("pose");
      } finally {
        if (targetBtn) targetBtn.textContent = origText;
      }
    }

    btnAnimPose?.addEventListener("click", () => {
      if (selAnimLibrary) selAnimLibrary.value = "";
      void setPreviewAnimation("pose");
    });
    btnAnimIdle?.addEventListener("click", () => void setPreviewAnimation("Breathing_Idle"));
    btnAnimWalk?.addEventListener("click", () => void setPreviewAnimation("Walk_Loop"));
    btnAnimCrouch?.addEventListener("click", () => void setPreviewAnimation("Crouch_Look_Around"));
    btnAnimDance?.addEventListener("click", () => void setPreviewAnimation("Robot_Hip_Hop"));

    selAnimLibrary?.addEventListener("change", () => {
      const opt = selAnimLibrary.selectedOptions[0];
      if (!opt || !selAnimLibrary.value) {
        void setPreviewAnimation("pose");
        return;
      }
      const clipName = opt.dataset.name || opt.textContent || "custom";
      const clipUrl = selAnimLibrary.value;
      void setPreviewAnimation(clipName, clipUrl);
    });

    // Render loop & Viewport auto-resizing
    const viewportContainer = card.querySelector<HTMLElement>(".rig-viewport-container")!;
    let resizeObserver: ResizeObserver | null = null;

    try {
      renderer3d = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer3d.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      const resize = () => {
        const rect = viewportContainer.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          camera.aspect = rect.width / rect.height;
          camera.updateProjectionMatrix();
          renderer3d?.setSize(rect.width, rect.height, false);
        }
      };

      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(viewportContainer);
      resize();

      const clock = new THREE.Clock();
      const render = () => {
        controls.update();
        const dt = clock.getDelta();
        if (previewMixer && currentAnim !== "pose") {
          previewMixer.update(dt);
        }
        renderer3d?.render(scene, camera);
        animId = requestAnimationFrame(render);
      };
      animId = requestAnimationFrame(render);
    } catch (e) {
      console.warn("Could not start 3D viewport for rig dialog:", e);
    }

    // Cleanup & Resolve
    const cleanup = (result: RigDialogResult) => {
      if (animId) cancelAnimationFrame(animId);
      if (resizeObserver) resizeObserver.disconnect();
      controls.dispose();
      canvas.removeEventListener("contextmenu", onContextMenu);
      if (previewMixer) previewMixer.stopAllAction();
      if (previewSkinnedGroup) {
        scene.remove(previewSkinnedGroup);
        previewSkinnedGroup.traverse((o: any) => {
          if (o.isMesh) {
            if (o.geometry) o.geometry.dispose();
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) m?.dispose?.();
          }
        });
        previewSkinnedGroup = null;
      }
      if (renderer3d) renderer3d.dispose();
      jointGeo.dispose();
      jointGeoFinger.dispose();
      jointMatCyan.dispose();
      jointMatGold.dispose();
      jointMatRed.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      lineMatArm.dispose();
      lineMatFinger.dispose();
      lineMatLeg.dispose();
      lineMatSpine.dispose();
      lineMatRed.dispose();
      overlay.remove();
      resolve(result);
    };

    const btnAutoRig = card.querySelector<HTMLButtonElement>("#btn-autorig")!;
    const btnStatic = card.querySelector<HTMLButtonElement>("#btn-static")!;
    const btnCancel = card.querySelector<HTMLButtonElement>("#btn-cancel")!;

    btnAutoRig.addEventListener("click", () => {
      btnAutoRig.disabled = true;
      btnStatic.disabled = true;
      btnCancel.disabled = true;
      btnAutoRig.textContent = "Auto-Rigging...";
      cleanup({ action: "rig", pose: params.pose ?? "a_pose", params });
    });

    btnStatic.addEventListener("click", () => cleanup({ action: "static" }));
    btnCancel.addEventListener("click", () => cleanup({ action: "cancel" }));

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup({ action: "cancel" });
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        window.removeEventListener("keydown", onKey);
        cleanup({ action: "cancel" });
      }
    };
    window.addEventListener("keydown", onKey);
  });
}
