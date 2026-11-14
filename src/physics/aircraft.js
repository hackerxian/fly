import { Vector3, Quaternion } from 'three';
import { airDensity, RHO0 } from './atmosphere.js';

// 坐标约定：世界系 NED（x 北 / y 东 / z 下），机体系 FRD（x 前 / y 右 / z 下），全部 SI 单位
const G = 9.80665;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
export const KT = 0.514444; // 1 节 = 0.514 m/s
export const FT = 0.3048;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sat = (x) => clamp(x, -1, 1);

// —— Cessna 172 参数（气动导数取自 Roskam 公布的 C172 数据）——
const P = {
  emptyMass: 767, payload: 132, fuelMax: 144, // kg，满油满载 1043 kg
  I: new Vector3(1285, 1825, 2667), // 转动惯量 kg·m²
  S: 16.17, b: 10.91, c: 1.49, // 翼面积、翼展、平均气动弦
  panelY: 0.16 * 10.91, // 左右翼面的等效力臂（贡献约 55% 的滚转阻尼，失速时会消失甚至反号）
  wingZ: -1.1, // 上单翼相对重心的高度

  // 升力 / 阻力
  CL0: 0.31, CLa: 5.1, CLde: 0.43, CLflap: 0.62, CLda: 1.43,
  alphaStall: 20 * DEG, // 线性段与失速段的混合中心（CLmax ≈ 1.6 出现在约 16.5°）
  CD0: 0.028, CDflap: 0.065, kInduced: 0.058, CDbeta: 0.17,

  // 俯仰
  Cm0: 0.04, Cma: -0.7, Cmq: -16, Cmde: -1.12, Cmflap: 0.03,
  // 横航向（机身 + 尾翼部分，机翼部分由左右翼面直接算出）
  CYb: -0.39, CYdr: 0.187,
  Clb: -0.092, Cldr: 0.0147, Clp: -0.21, // Clp：翼尖外洗段始终保留的滚转阻尼
  ClRig: 0.001, // 机翼装配角差：抵消巡航时的螺旋桨反扭矩
  Cnb: 0.0587, Cnr: -0.0937, Cndr: 0.0645,

  // 舵面行程
  elevUp: 22 * DEG, elevDown: 19 * DEG, aileron: 17 * DEG, rudder: 16 * DEG,
  qRef: 0.5 * RHO0 * 52 ** 2, // 超过机动速度后按动压折减舵量（等效于飞行员杆力有限）

  // 发动机（Lycoming O-320，160 hp @ 2700 rpm）与定距螺旋桨
  nRated: 45, torqueRated: 422 + 28, // 额定转速 rev/s、含摩擦的指示扭矩 N·m
  propD: 1.905, propI: 2.3,
};
P.propArea = (Math.PI * P.propD ** 2) / 4;

// 接地点：r 机体系位置，k/c 弹簧阻尼
const GEAR = [
  { r: new Vector3(1.27, 0, 1.1), k: 28000, c: 3000, steer: true }, // 前轮
  { r: new Vector3(-0.38, -1.27, 1.1), k: 40000, c: 4500, brake: true }, // 左主轮
  { r: new Vector3(-0.38, 1.27, 1.1), k: 40000, c: 4500, brake: true }, // 右主轮
  { r: new Vector3(-4.6, 0, 0.05), k: 60000, c: 5000, skid: true }, // 尾部系留环（擦尾）
];
// 机体结构点，触地即坠毁
const HULL = [
  new Vector3(2.1, 0, 0.65), // 螺旋桨
  new Vector3(0, -5.45, -1.0), new Vector3(0, 5.45, -1.0), // 翼尖
  new Vector3(-5.0, 0, -1.7), new Vector3(0.3, 0, -1.0), // 垂尾、机舱顶
  new Vector3(0.5, 0, 0.6), // 机腹
];
const GEAR_LIMIT = 0.32; // 起落架最大压缩量，超过即损坏

// 复用的临时向量
const qInv = new Quaternion(), dq = new Quaternion();
const va = new Vector3(), F = new Vector3(), M = new Vector3();
const rw = new Vector3(), vp = new Vector3(), vt = new Vector3(), nrm = new Vector3();
const fwd = new Vector3(), side = new Vector3(), fg = new Vector3(), Fg = new Vector3(), Mg = new Vector3();

export class Aircraft {
  pos = new Vector3();
  vel = new Vector3();
  quat = new Quaternion(); // 机体 → NED
  omega = new Vector3(); // 机体角速度 p q r
  // 操纵量：杆/舵 -1..1（elevator 正 = 拉杆，aileron 正 = 右滚，rudder 正 = 右舵），flaps 为 0..3 档
  controls = { elevator: 0, aileron: 0, rudder: 0, throttle: 0, trim: 0, flaps: 0, brake: 0, parkBrake: false };
  gear = [0, 0, 0, 0]; // 各接地点压缩量 (m)

  constructor() {
    this.place({});
  }

  // 把飞机摆到指定状态（位置 NED、航向 rad、空速 m/s）
  place({ n = 0, e = 0, alt = 0, heading = 0, speed = 0, throttle = 0, flaps = 0, trim = 0, parkBrake = false }) {
    this.pos.set(n, e, -alt);
    this.quat.setFromAxisAngle(new Vector3(0, 0, 1), heading);
    this.vel.set(speed, 0, 0).applyQuaternion(this.quat);
    this.omega.set(0, 0, 0);
    Object.assign(this.controls, { elevator: 0, aileron: 0, rudder: 0, throttle, trim, flaps, brake: 0, parkBrake });
    this.flap = flaps / 3; // 襟翼实际位置 0..1
    this.n = speed > 0 ? 38 : 11; // 螺旋桨转速 rev/s
    this.fuel = P.fuelMax;
    this.engineOn = true;
    this.crashed = null; // 坠毁原因
    this.touchdown = null; // 最近一次接地的下沉率 (m/s)，由外部读取后清空
    this.onGround = speed === 0;
    this.airTime = 0;
    this.stall = 0;
    this.stallWarn = false;
    this.thrust = 0;
    this.accel = new Vector3(0, 0, -G); // 机体系比力（加速度计读数）
    this.updateOutputs(new Vector3(speed, 0, 0), 0);
  }

  get mass() {
    return P.emptyMass + P.payload + this.fuel;
  }

  /**
   * 推进一个时间步
   * @param wind   { vel: NED 风速, rollGust }
   * @param ground { height(n, e): 地形海拔, paved(n, e): 是否铺装道面 }
   */
  step(dt, wind, ground) {
    if (this.crashed) return;
    const { pos, vel, quat, omega, controls: c } = this;
    const mass = this.mass;
    const rho = airDensity(-pos.z);

    this.flap += clamp(c.flaps / 3 - this.flap, -dt / 7, dt / 7);
    const flap = this.flap;

    // —— 相对气流（机体系）——
    qInv.copy(quat).invert();
    va.copy(vel).sub(wind.vel).applyQuaternion(qInv);
    const V = Math.max(va.length(), 1);
    const alpha = Math.atan2(va.z, va.x);
    const sinB = sat(va.y / V), beta = Math.asin(sinB);
    const qbar = 0.5 * rho * V * V;
    const qS = qbar * P.S;

    // —— 舵面偏角 ——
    const auth = Math.min(1, P.qRef / qbar);
    const stick = clamp(c.elevator * auth + c.trim, -1, 1);
    const de = -stick * (stick > 0 ? P.elevUp : P.elevDown); // 后缘下偏为正
    const da = c.aileron * auth * P.aileron;
    const dr = c.rudder * auth * P.rudder;

    // —— 发动机与螺旋桨 ——
    const n = this.n;
    const J = clamp(va.x / (Math.max(n, 1) * P.propD), 0, 2); // 前进比
    const CT = 0.102 - 0.015 * J - 0.087 * J * J;
    const CP = 0.0587 + 0.0293 * J - 0.0699 * J * J;
    const thrust = CT * rho * n * n * P.propD ** 4;
    const propTorque = (CP * rho * n * n * P.propD ** 5) / TAU;
    const running = this.engineOn && this.fuel > 0;
    let engTorque = -(10 + 0.4 * n) * (running ? 1 : 3); // 摩擦与泵气损失
    if (running) {
      // 进气量受节气门开度与转速两者中较小者限制：大油门时扭矩平直，小油门时功率恒定
      const lever = 0.03 + 0.97 * c.throttle, nr = n / P.nRated;
      const power = P.torqueRated * (1.132 * (rho / RHO0) - 0.132) * Math.min(lever, nr);
      engTorque += power / Math.max(nr, 0.05);
      this.fuel = Math.max(0, this.fuel - 7.5e-8 * power * P.nRated * TAU * dt);
    }
    this.n = Math.max(0, n + ((engTorque - propTorque) / (TAU * P.propI)) * dt);
    this.thrust = thrust;

    // —— 机翼：分左右两块翼面计算，自然得到滚转阻尼、不对称失速（掉翼尖/尾旋）与反向偏航 ——
    const agl = -pos.z - Math.max(ground.height(pos.x, pos.y), 0);
    const hb = (16 * Math.max(agl - P.wingZ, 0.5)) / P.b;
    const groundEffect = (hb * hb) / (1 + hb * hb); // 地面效应：近地时诱导阻力减小
    const a0 = P.alphaStall - flap * 2 * DEG;
    let Fx = thrust, Fz = 0, Mx = -propTorque, Mz = 0;
    let stall = 0, alphaMax = 0;
    for (let s = -1; s <= 1; s += 2) {
      const y = s * P.panelY;
      const ul = va.x - omega.z * y;
      const wl = va.z + omega.x * y + s * wind.rollGust;
      const al = Math.atan2(wl, ul);
      const sa = Math.sin(al), ca = Math.cos(al);
      const q = 0.25 * rho * (ul * ul + wl * wl) * P.S;
      const sg = 1 - 1 / ((1 + Math.exp(30 * (al - a0))) * (1 + Math.exp(-30 * (al + a0 - 3 * DEG))));
      const CLlin = P.CL0 + P.CLflap * flap + P.CLa * al + P.CLde * de - s * P.CLda * da * (1 - 0.5 * sg);
      const CL = (1 - sg) * CLlin + sg * 2.2 * sa * ca; // 失速后过渡到平板模型
      const CD = P.CD0 + P.CDflap * flap * flap + P.CDbeta * Math.abs(beta)
        + (1 - sg) * P.kInduced * CLlin * CLlin * groundEffect + sg * 1.6 * sa * sa;
      const L = q * CL, D = q * CD;
      const fx = L * sa - D * ca, fz = -L * ca - D * sa;
      Fx += fx; Fz += fz;
      Mx += y * fz; Mz -= y * fx;
      stall = Math.max(stall, sg);
      alphaMax = Math.max(alphaMax, al);
    }
    this.stall = stall;
    this.stallWarn = alphaMax > a0 - 7 * DEG && !this.onGround;

    // —— 机身与尾翼（稳定性导数）——
    const wash = Math.max(thrust, 0) / P.propArea; // 螺旋桨滑流在尾翼处增加的动压
    const qElev = (qbar + 0.25 * wash) * P.S, qRud = (qbar + 0.5 * wash) * P.S;
    const V2 = 2 * V;
    const Fy = qS * P.CYb * beta - qRud * P.CYdr * dr;
    Mx += qS * P.b * (P.Clb * beta + P.ClRig + (P.Clp * omega.x * P.b) / V2) - qRud * P.b * P.Cldr * dr;
    const Cm = P.Cm0 + P.Cmflap * flap + P.Cma * Math.sin(alpha) + (P.Cmq * omega.y * P.c) / V2
      - 0.3 * stall * Math.sign(alpha); // 失速后压力中心后移产生低头力矩
    const My = qS * P.c * Cm + qElev * P.c * P.Cmde * de;
    Mz += qS * P.b * (P.Cnb * beta + (P.Cnr * omega.z * P.b) / V2) + qRud * P.b * P.Cndr * dr;
    // 螺旋滑流与 P 因子造成的左偏趋势（大功率、低速、大迎角时明显）
    Mz -= Math.max(thrust, 0) * (0.12 * Math.max(0, 1 - V / 55) + 0.5 * clamp(alpha, -0.3, 0.3));

    // —— 起落架与地面接触 ——
    Fg.set(0, 0, 0); Mg.set(0, 0, 0);
    let contact = false;
    if (agl < 8) {
      const d = 1;
      nrm.set(ground.height(pos.x - d, pos.y) - ground.height(pos.x + d, pos.y),
        ground.height(pos.x, pos.y - d) - ground.height(pos.x, pos.y + d), -2 * d).normalize(); // 地面法线（朝上）
      const brake = c.parkBrake ? 1 : c.brake;
      const rollMu = ground.paved(pos.x, pos.y) ? 0.02 : 0.07;
      const groundSpeed = Math.hypot(vel.x, vel.y);
      GEAR.forEach((g, i) => {
        rw.copy(g.r).applyQuaternion(quat);
        const px = pos.x + rw.x, py = pos.y + rw.y;
        const terrain = ground.height(px, py);
        const depth = Math.max(terrain, 0) + pos.z + rw.z; // > 0 表示压入地面
        this.gear[i] = Math.max(depth, 0);
        if (depth <= 0) return;
        if (terrain < 0) this.crashed = '落水';
        if (depth > GEAR_LIMIT && !g.skid) this.crashed = '着陆过重，起落架损坏';
        contact ||= !g.skid;
        vp.copy(omega).cross(g.r).applyQuaternion(quat).add(vel); // 接地点速度
        const vn = vp.dot(nrm);
        const N = Math.max(0, g.k * depth - g.c * vn);
        vt.copy(vp).addScaledVector(nrm, -vn);
        fg.copy(nrm).multiplyScalar(N);
        if (g.skid) {
          fg.addScaledVector(vt, (-0.4 * N) / Math.max(vt.length(), 0.5));
        } else {
          const steer = g.steer ? (c.rudder * 0.22) / (1 + (groundSpeed / 12) ** 2) : 0; // 前轮转向
          fwd.set(Math.cos(steer), Math.sin(steer), 0).applyQuaternion(quat);
          fwd.addScaledVector(nrm, -fwd.dot(nrm)).normalize();
          side.crossVectors(nrm, fwd);
          const vl = vt.dot(fwd), vs = vt.dot(side);
          fg.addScaledVector(fwd, -(rollMu + (g.brake ? 0.55 * brake : 0)) * N * sat(vl / 0.05));
          fg.addScaledVector(side, -0.8 * N * sat(vs / (0.1 * Math.abs(vl) + 0.2)));
        }
        Fg.add(fg);
        Mg.add(rw.cross(fg)); // 力矩先在 NED 下累加
      });
      for (const h of HULL) {
        rw.copy(h).applyQuaternion(quat);
        const terrain = ground.height(pos.x + rw.x, pos.y + rw.y);
        if (Math.max(terrain, 0) + pos.z + rw.z > 0) this.crashed = terrain < 0 ? '落水' : '机体触地';
      }
    }
    if (contact && !this.onGround && this.airTime > 2) this.touchdown = vel.z;
    this.airTime = contact ? 0 : this.airTime + dt;
    this.onGround = contact;

    // —— 积分（半隐式欧拉）——
    F.set(Fx, Fy, Fz).applyQuaternion(quat).add(Fg);
    M.set(Mx, My, Mz).add(Mg.applyQuaternion(qInv));
    this.accel.copy(F).applyQuaternion(qInv).divideScalar(mass);
    vel.addScaledVector(F, dt / mass);
    vel.z += G * dt;
    pos.addScaledVector(vel, dt);
    const I = P.I, { x: p, y: q, z: r } = omega;
    omega.x += ((M.x - (I.z - I.y) * q * r) / I.x) * dt;
    omega.y += ((M.y - (I.x - I.z) * r * p) / I.y) * dt;
    omega.z += ((M.z - (I.y - I.x) * p * q) / I.z) * dt;
    quat.multiply(dq.set(omega.x * dt * 0.5, omega.y * dt * 0.5, omega.z * dt * 0.5, 1)).normalize();

    this.updateOutputs(va, agl);
  }

  // 供仪表、音效和自动驾驶读取的派生量
  updateOutputs(va, agl) {
    const { x, y, z, w } = this.quat;
    this.roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
    this.pitch = Math.asin(sat(2 * (w * y - z * x)));
    this.heading = (Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) + TAU) % TAU;
    this.altitude = -this.pos.z;
    this.agl = agl;
    this.vs = -this.vel.z;
    this.tas = va.length();
    this.ias = Math.max(va.x, 0) * Math.sqrt(airDensity(this.altitude) / RHO0);
    this.alpha = Math.atan2(va.z, va.x);
    this.rpm = this.n * 60;
    this.gLoad = -this.accel.z / G;
    this.slip = -this.accel.y / Math.max(Math.abs(this.accel.z), 1); // 侧滑仪小球偏移
    // 转弯率（航向变化率）
    this.turnRate = (this.omega.y * Math.sin(this.roll) + this.omega.z * Math.cos(this.roll)) / Math.cos(this.pitch);
  }
}

export const FLAP_DEG = [0, 10, 20, 30];
export const FUEL_MAX = P.fuelMax;
