import { Vector3 } from 'three';

export const RHO0 = 1.225;

// 国际标准大气（对流层）：给定海拔(m)，返回密度 kg/m³
export function airDensity(alt) {
  const T = 288.15 - 0.0065 * alt;
  return (101325 * (T / 288.15) ** 5.2559) / (287.05 * T);
}

const randn = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;

// 稳定风 + 紊流。紊流用一阶高斯-马尔可夫过程近似 Dryden 模型
export class Wind {
  dir = 0; // 风的来向 (rad，0 = 北风)
  speed = 0; // m/s
  turb = 0; // 紊流强度 (阵风均方根, m/s)
  vel = new Vector3(); // 当前风速矢量 (NED)
  rollGust = 0; // 左右机翼的垂直阵风差 (m/s)，引起滚转扰动
  gust = new Vector3();

  update(dt) {
    const a = dt / 2.5;
    const s = this.turb * Math.sqrt(2 * a);
    const g = this.gust;
    g.x += -g.x * a + s * randn();
    g.y += -g.y * a + s * randn();
    g.z += -g.z * a + s * 0.7 * randn();
    this.rollGust += -this.rollGust * a * 2.5 + s * randn();
    this.vel.set(-Math.cos(this.dir) * this.speed + g.x, -Math.sin(this.dir) * this.speed + g.y, g.z);
  }
}
