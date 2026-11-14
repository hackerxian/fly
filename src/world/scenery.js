import * as THREE from 'three';
import { ELEV } from './terrain.js';
import { makeNoise } from './noise.js';

// 机场布局（three 坐标：x 东、z 南）。跑道沿南北方向，中心在原点
export const RUNWAY = { length: 1500, width: 30 };
export const TOWER = new THREE.Vector3(205, ELEV + 25, 115);
// 铺装区域：[x 中心, z 中心, 半宽, 半长]
const PAVED = [
  [0, 0, 15, 750], // 跑道 18/36
  [70, 0, 6, 750], // 平行滑行道
  [42, -738, 34, 7], [42, 0, 34, 7], [42, 738, 34, 7], // 联络道
  [160, 0, 85, 160], // 停机坪
];
export const isPaved = (x, z) => PAVED.some(([cx, cz, hw, hl]) => Math.abs(x - cx) < hw && Math.abs(z - cz) < hl);

// 跑道道面贴图：以米为单位绘制标线，画布上方为北
function runwayTexture(anisotropy) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 8192;
  const g = canvas.getContext('2d');
  const L = RUNWAY.length, W = RUNWAY.width;
  g.scale(canvas.width / W, canvas.height / L);
  g.fillStyle = '#35363a';
  g.fillRect(0, 0, W, L);
  for (let i = 0; i < 9000; i++) { // 沥青斑驳
    const v = 30 + Math.random() * 60;
    g.fillStyle = `rgba(${v},${v},${v},0.1)`;
    g.fillRect(Math.random() * W, Math.random() * L, 0.3 + Math.random() * 2, 1 + Math.random() * 9);
  }
  g.fillStyle = '#e9e9e4';
  g.fillRect(0.7, 0, 0.6, L);
  g.fillRect(W - 1.3, 0, 0.6, L);
  for (let y = 95; y < L - 100; y += 50) g.fillRect(W / 2 - 0.3, y, 0.6, 30); // 中线
  for (let end = 0; end < 2; end++) { // 先画南端，再把画布转 180° 画北端
    for (let i = 0; i < 8; i++) g.fillRect(2.4 + i * 3.2 + (i > 3 ? 1.8 : 0), L - 36, 1.8, 30); // 入口斑马线
    g.fillRect(4.5, L - 345, 6, 45); // 瞄准点标记
    g.fillRect(W - 10.5, L - 345, 6, 45);
    for (const d of [150, 450]) for (const x of [5, 7, 9, 19.8, 21.8, 23.8]) g.fillRect(x, L - d - 22, 1.2, 22); // 接地区标记
    g.fillStyle = 'rgba(10,10,10,0.06)'; // 接地区的轮胎擦痕
    for (let i = 0; i < 260; i++) g.fillRect(W / 2 + (Math.random() - 0.5) * 9, L - 120 - Math.random() * 420, 0.35, 15 + Math.random() * 50);
    g.fillStyle = '#e9e9e4';
    g.translate(W, L);
    g.rotate(Math.PI);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

// 跑道号码单独做成高清贴花
function numberDecal(label, anisotropy) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const g = canvas.getContext('2d');
  g.fillStyle = '#e9e9e4';
  g.font = 'bold 400px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 256, 275);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = anisotropy;
  return new THREE.Mesh(new THREE.PlaneGeometry(9.5, 9).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map, roughness: 0.9, transparent: true, depthWrite: false }));
}

const std = (color, roughness = 0.85, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });

function box(w, h, d, material, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

export class Scenery {
  constructor(scene, terrain, anisotropy) {
    const root = (this.root = new THREE.Group());
    root.position.y = ELEV;
    scene.add(root);

    // —— 道面 ——
    const flat = (w, l, material, x, z, y) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2), material);
      m.position.set(x, y, z);
      m.receiveShadow = true;
      root.add(m);
    };
    flat(RUNWAY.width, RUNWAY.length, std(0xffffff, 0.9, { map: runwayTexture(anisotropy) }), 0, 0, 0.05);
    for (const [label, s] of [['36', 1], ['18', -1]]) { // 南端 36、北端 18（朝向各自的进近方向）
      const decal = numberDecal(label, anisotropy);
      decal.position.set(0, 0.08, s * 702);
      decal.rotation.y = s > 0 ? 0 : Math.PI;
      decal.receiveShadow = true;
      root.add(decal);
    }
    const concrete = std(0x5d5e5c, 0.95), line = std(0xc9a21a, 0.8);
    PAVED.slice(1).forEach(([x, z, hw, hl], i) => flat(hw * 2, hl * 2, concrete, x, z, 0.02 + i * 0.004));
    flat(0.3, RUNWAY.length, line, 70, 0, 0.06); // 滑行道中线

    // —— 建筑：机库、航站楼、塔台 ——
    const wall = std(0xb9bcc0, 0.7), roof = std(0x4a5560, 0.5, { metalness: 0.4 }), dark = std(0x1c1f24, 0.4);
    for (const z of [-115, -55, 5]) {
      root.add(box(34, 9, 46, wall, 222, 0, z), box(0.3, 7, 34, dark, 204.9, 0, z));
      const arch = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, 46, 24, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2), roof);
      arch.scale.y = 0.3;
      arch.position.set(222, 9, z);
      arch.castShadow = true;
      root.add(arch);
    }
    root.add(box(22, 7, 44, wall, 222, 0, 75), box(23, 0.6, 45, roof, 222, 7, 75), box(0.3, 3, 40, dark, 210.9, 2, 75));
    const tx = TOWER.x, tz = TOWER.z;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4, 21, 16), wall);
    shaft.position.set(tx, 10.5, tz);
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(6, 4.6, 4.5, 8), std(0x18303c, 0.1, { metalness: 0.6 }));
    cab.position.set(tx, 23.2, tz);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(6.6, 6.6, 0.6, 8), roof);
    cap.position.set(tx, 25.8, tz);
    for (const m of [shaft, cab, cap]) m.castShadow = true, root.add(m);

    // —— 风向袋 ——
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 6), std(0xdddddd));
    pole.position.set(-45, 3, 420);
    this.sockPivot = new THREE.Group();
    this.sockPivot.position.set(-45, 6, 420);
    this.sock = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.55, 3.6, 12, 1, true).rotateX(Math.PI / 2).translate(0, 0, 1.8),
      std(0xff6a1a, 0.8, { side: THREE.DoubleSide }),
    );
    this.sockPivot.add(this.sock);
    root.add(pole, this.sockPivot);

    // —— 灯光：跑道边灯、入口灯、滑行道灯 ——
    const pos = [], col = [];
    const lamp = (x, z, r, g, b) => (pos.push(x, 0.4, z), col.push(r * 3, g * 3, b * 3));
    for (let z = -750; z <= 750; z += 60) lamp(-16.5, z, 1, 0.95, 0.8), lamp(16.5, z, 1, 0.95, 0.8);
    for (let x = -13.5; x <= 13.5; x += 3) lamp(x, 752, 0.1, 1, 0.2), lamp(x, -752, 0.1, 1, 0.2);
    for (let z = -720; z <= 720; z += 60) lamp(63, z, 0.15, 0.3, 1), lamp(77, z, 0.15, 0.3, 1);
    this.lights = this.points(pos, col, 3);

    // —— PAPI 目视进近坡度指示器：两端各一组 4 灯，位于跑道左侧 ——
    this.papi = [1, -1].flatMap((s) => [0, 1, 2, 3].map((i) => new THREE.Vector3(-s * (24 + i * 8), 0.6, s * 450)));
    this.papiPoints = this.points(this.papi.flatMap((p) => [p.x, p.y, p.z]), new Array(24).fill(1), 5);
    for (const p of this.papi) root.add(box(1.2, 0.6, 1.2, dark, p.x, 0, p.z));

    this.addTrees(scene, terrain);
  }

  points(positions, colors, size) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, transparent: true }));
    this.root.add(p);
    return p;
  }

  // 机场周边的树林（实例化渲染）
  addTrees(scene, terrain) {
    const { fbm } = makeNoise(42);
    const COUNT = 9000;
    const trees = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), COUNT);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), color = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < COUNT;) {
      const x = (Math.random() - 0.5) * 11000, z = (Math.random() - 0.5) * 11000;
      const h = terrain.height(x, z);
      if (h < 3 || h > 350 || fbm(x / 500, z / 500, 3) < 0.08) continue;
      if (Math.abs(x - 60) < 300 && Math.abs(z) < 1100) continue; // 机场范围
      if (Math.abs(x) < 130 && Math.abs(z) < 1900) continue; // 跑道两端净空
      if (Math.abs(terrain.height(x + 6, z) - h) + Math.abs(terrain.height(x, z + 6) - h) > 4) continue; // 陡坡
      const r = 2.2 + Math.random() * 1.8;
      m.compose(new THREE.Vector3(x, h - 0.3, z), q.setFromAxisAngle(up, Math.random() * 6.28), new THREE.Vector3(r, 8 + Math.random() * 8, r));
      trees.setMatrixAt(i, m);
      trees.setColorAt(i++, color.setRGB(0.03 + Math.random() * 0.03, 0.09 + Math.random() * 0.06, 0.03));
    }
    scene.add(trees);
  }

  /** @param eye 飞机位置 (three 坐标)；night 0..1 */
  update(eye, wind, night) {
    // 风向袋指向下风方向，风越大越平
    this.sockPivot.rotation.y = -wind.dir;
    this.sock.rotation.x = (1 - Math.min(wind.speed / 7.7, 1)) * 1.25;
    this.lights.material.opacity = 0.3 + 0.7 * night;
    // PAPI：按飞机相对各灯的仰角显示红/白，下滑道 3° 时两红两白
    const colors = this.papiPoints.geometry.attributes.color;
    this.papi.forEach((p, k) => {
      const angle = Math.atan2(eye.y - ELEV, Math.hypot(eye.x - p.x, eye.z - p.z)) * (180 / Math.PI);
      const white = angle > 3.5 - (k % 4) * 0.333;
      colors.setXYZ(k, 4, white ? 4 : 0.1, white ? 3.6 : 0.1);
    });
    colors.needsUpdate = true;
  }
}
