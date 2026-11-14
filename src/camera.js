import * as THREE from 'three';
import { EYE } from './aircraft/model.js';
import { TOWER } from './world/scenery.js';

const MODES = ['chase', 'cockpit', 'tower'];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const look = new THREE.Quaternion(), euler = new THREE.Euler(0, 0, 0, 'YXZ'), target = new THREE.Vector3();

// 三种视角：尾随、座舱、塔台。鼠标拖动环视，滚轮缩放
export class ViewCamera {
  camera = new THREE.PerspectiveCamera(60, 1, 0.1, 150000);
  mode = 'chase';
  yaw = 0; // 环视偏角
  pitch = 0;
  distance = 16;
  follow = 0; // 尾随视角平滑后的航向

  constructor(dom) {
    dom.addEventListener('pointermove', (e) => {
      if (!(e.buttons & 1) || document.pointerLockElement) return;
      this.yaw -= e.movementX * 0.005;
      this.pitch = clamp(this.pitch - e.movementY * 0.005, -1.3, 1.3);
    });
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance = clamp(this.distance * Math.exp(e.deltaY * 0.001), 6, 120);
    }, { passive: false });
    dom.addEventListener('dblclick', () => (this.yaw = this.pitch = 0));
  }

  next() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    this.yaw = this.pitch = 0;
  }

  /** @param model 飞机模型的 Group；heading 航向 (rad)；shake 抖动幅度 (m)；terrain 用于防止相机钻入地面 */
  update(model, heading, shake, dt, terrain) {
    const cam = this.camera;
    if (this.mode === 'cockpit') {
      cam.fov = 68;
      cam.position.copy(EYE).applyMatrix4(model.matrixWorld);
      cam.position.x += (Math.random() - 0.5) * shake;
      cam.position.y += (Math.random() - 0.5) * shake;
      cam.quaternion.copy(model.quaternion).multiply(look.setFromEuler(euler.set(this.pitch, this.yaw, 0)));
    } else if (this.mode === 'chase') {
      cam.fov = 55;
      // 相机只跟随航向（带一点滞后），不随飞机俯仰滚转，便于观察姿态
      this.follow += Math.atan2(Math.sin(heading - this.follow), Math.cos(heading - this.follow)) * (1 - Math.exp(-dt * 2.5));
      const a = -this.follow + this.yaw, el = 0.2 - this.pitch;
      target.copy(model.position).y += 1;
      cam.position.set(Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el)).multiplyScalar(this.distance).add(target);
      cam.position.y = Math.max(cam.position.y, Math.max(terrain.height(cam.position.x, cam.position.z), 0) + 1); // 不低于地表或海面
      cam.lookAt(target);
    } else {
      cam.position.copy(TOWER);
      cam.fov = clamp(2 * Math.atan(18 / cam.position.distanceTo(model.position)) * (180 / Math.PI), 2.5, 55);
      cam.lookAt(model.position);
    }
    cam.updateProjectionMatrix();
  }
}
