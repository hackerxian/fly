import * as THREE from 'three';

const DEG = Math.PI / 180;
// 机体坐标（前, 右, 上；原点在重心，单位 m）→ three 局部坐标（机头朝 -Z）
const P = (fwd, right, up) => new THREE.Vector3(right, up, -fwd);
export const EYE = P(0.12, -0.25, 0.47); // 左座飞行员眼位

const paint = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.35, side: THREE.DoubleSide, ...extra });
const WHITE = paint(0xf1f1ec), ACCENT = paint(0x1b4a9a), DARK = paint(0x16181c, { roughness: 0.6 });
const METAL = paint(0xb8bcc2, { roughness: 0.3, metalness: 0.8 });
const INTERIOR = paint(0x2b2e34, { roughness: 0.9 }), HIDDEN = new THREE.MeshBasicMaterial({ visible: false });
const GLASS = paint(0x0c1218, { roughness: 0.04, metalness: 0.3, transparent: true, opacity: 0.2, depthWrite: false });
const glow = (r, g, b) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });

// 把一串等点数的闭合截面蒙皮成网格；pick(i, j) 决定第 i 段第 j 个面用哪个材质
function loft(rings, materials, pick = () => 0, flat = false) {
  const n = rings[0].length, pos = [], groups = materials.map(() => []);
  const push = (p) => pos.push(p.x, p.y, p.z);
  rings.flat().forEach(push);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j, b = i * n + ((j + 1) % n);
      groups[pick(i, j)].push(a, b, a + n, b, b + n, a + n);
    }
  }
  for (const ring of [rings[0], rings.at(-1)]) { // 两端封口（独立顶点，保持棱边）
    const c = pos.length / 3;
    ring.forEach(push);
    push(ring.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(n));
    for (let j = 0; j < n; j++) groups[0].push(c + j, c + ((j + 1) % n), c + n);
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(groups.flat());
  let start = 0;
  groups.forEach((idx, m) => (g.addGroup(start, idx.length, m), (start += idx.length)));
  if (flat) g = g.toNonIndexed();
  g.computeVertexNormals();
  return new THREE.Mesh(g, materials);
}

// —— 机身：沿纵向的一串超椭圆截面 [前向位置, 半宽, 底, 顶] ——
const FUSELAGE = [
  [2.02, 0.3, -0.42, 0.02], [1.9, 0.47, -0.55, 0.12], [1.45, 0.54, -0.62, 0.2],
  [0.95, 0.57, -0.64, 0.26], // 防火墙、风挡下缘
  [0.42, 0.58, -0.64, 0.76], // 风挡上缘
  [-0.3, 0.58, -0.64, 0.8], [-1.15, 0.55, -0.6, 0.78],
  [-1.95, 0.44, -0.48, 0.58], // 后窗下缘
  [-3.1, 0.27, -0.26, 0.4], [-4.5, 0.12, 0, 0.3], [-5.35, 0.04, 0.14, 0.28],
];
const SEG = 32;

function fuselage() {
  const se = (v) => Math.sign(v) * Math.abs(v) ** (2 / 3); // 超椭圆，截面略方
  const rings = FUSELAGE.map(([f, hw, bottom, top]) =>
    Array.from({ length: SEG }, (_, j) => {
      const a = (j / SEG) * Math.PI * 2;
      return P(f, hw * se(Math.cos(a)), (top + bottom) / 2 + ((top - bottom) / 2) * se(Math.sin(a)));
    }));
  const pick = (i, j) => {
    const side = (j >= 1 && j <= 4) || (j >= 11 && j <= 14);
    if (((i === 3 || i === 6) && j >= 2 && j <= 13) || ((i === 4 || i === 5) && side)) return 1; // 风挡、后窗、侧窗
    return i >= 1 && i <= 8 && (j === 31 || j === 16) ? 2 : 0; // 腰线色带
  };
  // 机舱内衬：略小一圈的深色内壁，窗口处留空
  const liner = rings.slice(2, 9).map((ring) => {
    const c = ring.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(SEG);
    return ring.map((p) => p.clone().lerp(c, 0.04));
  });
  return [loft(rings, [WHITE, GLASS, ACCENT], pick), loft(liner, [INTERIOR, HIDDEN], (i, j) => +(pick(i + 2, j) === 1))];
}

// —— 翼面 ——
// 翼型轮廓 [弦向位置, 厚度]（以弦长为单位）：前段为固定翼面，后段为舵面
const WING_FRONT = [[0, 0], [0.012, 0.02], [0.05, 0.042], [0.12, 0.062], [0.25, 0.078], [0.4, 0.078], [0.55, 0.066], [0.7, 0.048],
  [0.7, -0.022], [0.5, -0.034], [0.3, -0.04], [0.12, -0.037], [0.04, -0.026], [0.01, -0.012]];
const WING_REAR = [[0.7, 0.048], [1, 0.004], [1, -0.002], [0.7, -0.022]];
const TAIL_FRONT = [[0, 0], [0.02, 0.022], [0.1, 0.042], [0.3, 0.05], [0.6, 0.038], [0.6, -0.038], [0.3, -0.05], [0.1, -0.042], [0.02, -0.022]];
const TAIL_REAR = [[0.6, 0.038], [1, 0.004], [1, -0.004], [0.6, -0.038]];

// 各翼面沿展向的站位 → [前缘前向位置, 右, 上, 弦长]
const taper = (y, y0, y1) => Math.max(0, (Math.abs(y) - y0) / (y1 - y0));
const wingAt = (y) => [0.7 - 0.15 * taper(y, 2.5, 5.45), y, 0.86 + Math.abs(y) * 0.03, 1.63 - 0.5 * taper(y, 2.5, 5.45)];
const stabAt = (y) => [-4.15 - 0.2 * taper(y, 0, 1.72), y, 0.3, 1.05 - 0.35 * taper(y, 0, 1.72)];
const finAt = (u) => [-3.75 - 1.0 * taper(u, 0.3, 1.75), 0, u, 1.45 - 0.8 * taper(u, 0.3, 1.75)];

// vertical: 厚度方向沿左右（垂尾）
function surface(stations, profile, material, vertical = false, flat = false) {
  const rings = stations.map(([f, r, u, c]) => profile.map(([x, t]) => (vertical ? P(f - x * c, r + t * c, u) : P(f - x * c, r, u + t * c))));
  return loft(rings, [material], undefined, flat);
}

// 可绕铰链线偏转的舵面；站位按从左到右（或从下到上）排列，正偏角 = 后缘向下（或向右）
function hinged(stations, profile, vertical) {
  const mesh = surface(stations, profile, WHITE, vertical, true);
  const [a, b] = [stations[0], stations.at(-1)].map(([f, r, u, c]) => P(f - profile[0][0] * c, r, u));
  mesh.geometry.translate(-a.x, -a.y, -a.z);
  mesh.position.copy(a);
  mesh.userData.axis = b.sub(a).normalize();
  return mesh;
}
const deflect = (mesh, angle) => mesh.quaternion.setFromAxisAngle(mesh.userData.axis, angle);

// 两点之间的杆件（截面可压扁成流线形）
function beam(a, b, radius, material, squash = 1) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 10).scale(squash, 1, 1), material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

function wheel(radius, center) {
  const w = new THREE.Group();
  w.add(new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.14, 20).rotateZ(Math.PI / 2), DARK));
  w.add(new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.5, radius * 0.5, 0.15, 12).rotateZ(Math.PI / 2), METAL));
  w.position.copy(center);
  w.userData.y = center.y;
  return w;
}

export class AircraftModel {
  group = new THREE.Group();

  constructor() {
    const g = this.group;
    g.add(...fuselage());
    g.add(surface([-5.45, -2.5, 0, 2.5, 5.45].map(wingAt), WING_FRONT, WHITE));
    g.add(surface([-1.72, 0, 1.72].map(stabAt), TAIL_FRONT, WHITE));
    g.add(surface([0.3, 1.75].map(finAt), TAIL_FRONT, WHITE, true));

    // 舵面
    this.flaps = [[-2.5, -0.62], [0.62, 2.5]].map((span) => hinged(span.map(wingAt), WING_REAR));
    this.aileronL = hinged([-5.38, -2.52].map(wingAt), WING_REAR);
    this.aileronR = hinged([2.52, 5.38].map(wingAt), WING_REAR);
    this.elevator = hinged([-1.72, 0, 1.72].map(stabAt), TAIL_REAR);
    this.rudder = hinged([0.3, 1.75].map(finAt), TAIL_REAR, true);
    g.add(...this.flaps, this.aileronL, this.aileronR, this.elevator, this.rudder);

    // 翼撑杆、起落架
    for (const s of [-1, 1]) {
      g.add(beam(P(0.35, s * 0.56, -0.55), P(0.13, s * 2.35, 0.87), 0.035, WHITE, 2.4));
      g.add(beam(P(-0.3, s * 0.4, -0.6), P(-0.38, s * 1.19, -0.9), 0.04, WHITE, 2.2));
    }
    g.add(beam(P(1.3, 0, -0.5), P(1.27, 0, -0.92), 0.035, METAL));
    this.wheels = [wheel(0.18, P(1.27, 0, -0.92)), wheel(0.2, P(-0.38, -1.27, -0.9)), wheel(0.2, P(-0.38, 1.27, -0.9))];
    g.add(...this.wheels);

    // 螺旋桨：低转速显示桨叶，高转速过渡为半透明桨盘
    this.prop = new THREE.Group();
    this.prop.position.copy(P(2.1, 0, -0.2));
    this.blades = new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 0.5, transparent: true });
    for (const s of [1, -1]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.9, 0.02).translate(0, 0.5, 0), this.blades);
      blade.rotation.set(0, 0.35, s > 0 ? 0 : Math.PI, 'ZXY');
      this.prop.add(blade);
    }
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(0.95, 48),
      new THREE.MeshStandardMaterial({ color: 0x30343a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })); // 受环境光影响，夜间不会发亮
    this.disc.renderOrder = 2;
    this.prop.add(this.disc, new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.46, 20).rotateX(-Math.PI / 2).translate(0, 0, -0.08), ACCENT));
    g.add(this.prop);

    // 驾驶舱内饰：仪表板与遮光罩
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.62, 0.3), DARK);
    panel.position.copy(P(0.82, 0, -0.04));
    g.add(panel);
    for (const s of [-1, 1]) { // 整流罩进气口
      const intake = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.03), DARK);
      intake.position.copy(P(2.03, s * 0.16, -0.1));
      g.add(intake);
    }

    // 航行灯（左红右绿尾白）、防撞灯、频闪灯、着陆灯
    const lamp = (material, pos, r = 0.045) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), material);
      m.position.copy(pos);
      g.add(m);
      return m;
    };
    lamp(glow(5, 0.1, 0.1), P(0.3, -5.47, 1.05));
    lamp(glow(0.1, 5, 0.3), P(0.3, 5.47, 1.05));
    lamp(glow(4, 4, 4), P(-5.38, 0, 0.22));
    this.beacon = lamp(glow(8, 0.2, 0.1), P(-4.95, 0, 1.8), 0.06);
    this.strobes = [lamp(glow(12, 12, 12), P(0.1, -5.47, 1.05), 0.05), lamp(glow(12, 12, 12), P(0.1, 5.47, 1.05), 0.05)];
    this.landingLight = new THREE.SpotLight(0xfff2dd, 0, 700, 0.2, 0.7, 1.6);
    this.landingLight.position.copy(P(2.0, 0, -0.45));
    this.landingLight.target.position.copy(P(60, 0, -7));
    g.add(this.landingLight, this.landingLight.target);

    g.traverse((o) => {
      if (o.isMesh && o.material !== this.disc.material) o.castShadow = o.receiveShadow = true;
    });
    this.time = 0;
  }

  /** 与物理状态同步：位姿、舵面、螺旋桨、机轮、灯光 */
  update(ac, dt) {
    const { pos, quat, controls: c } = ac;
    this.group.position.set(pos.y, -pos.z, -pos.x); // NED → three (x 东, y 上, z 南)
    this.group.quaternion.set(quat.y, -quat.z, -quat.x, quat.w);

    const stick = Math.min(1, Math.max(-1, c.elevator + c.trim));
    deflect(this.elevator, -stick * 24 * DEG);
    deflect(this.aileronR, -c.aileron * 17 * DEG);
    deflect(this.aileronL, c.aileron * 17 * DEG);
    deflect(this.rudder, c.rudder * 16 * DEG);
    this.flaps.forEach((f) => deflect(f, ac.flap * 30 * DEG));

    this.prop.rotation.z -= ac.n * Math.PI * 2 * dt;
    const blur = Math.min(1, ac.n / 12);
    this.blades.opacity = 1 - 0.85 * blur;
    this.disc.material.opacity = 0.16 * blur;

    const speed = Math.hypot(ac.vel.x, ac.vel.y);
    this.wheels.forEach((w, i) => {
      w.position.y = w.userData.y + Math.min(ac.gear[i], 0.25);
      if (ac.gear[i] > 0) w.rotation.x -= (speed / 0.2) * dt;
    });

    this.time += dt;
    this.beacon.visible = this.time % 1.2 < 0.12;
    const flash = this.time % 1.5;
    this.strobes.forEach((s) => (s.visible = flash < 0.05 || (flash > 0.15 && flash < 0.2)));
  }
}
