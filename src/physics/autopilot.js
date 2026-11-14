const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// 简易双轴自动驾驶：保持航向与高度
export class Autopilot {
  on = false;
  alt = 0; // 目标高度 m
  hdg = 0; // 目标航向 rad
  pitchRef = 0; // 俯仰指令的积分项

  engage(ac) {
    this.on = true;
    this.alt = ac.altitude;
    this.hdg = ac.heading;
    this.pitchRef = ac.pitch;
  }

  update(ac, dt) {
    if (!this.on) return;
    if (ac.stall > 0.5) return void (this.on = false); // 失速时自动断开
    const c = ac.controls;
    // 航向误差 → 目标坡度 → 副翼
    const bank = clamp(wrap(this.hdg - ac.heading) * 1.5, -25 * DEG, 25 * DEG);
    c.aileron = clamp((bank - ac.roll) * 2 - ac.omega.x * 0.8, -1, 1);
    // 高度误差 → 目标升降率 → 目标俯仰角 → 升降舵，稳态舵量逐渐转移到配平
    const vsErr = clamp((this.alt - ac.altitude) * 0.15, -4, 4) - ac.vs;
    this.pitchRef = clamp(this.pitchRef + vsErr * 0.012 * dt, -10 * DEG, 12 * DEG);
    const pitchCmd = clamp(this.pitchRef + vsErr * 0.015, -12 * DEG, 15 * DEG);
    c.elevator = clamp((pitchCmd - ac.pitch) * 4 - ac.omega.y * 1.2, -1, 1);
    c.trim = clamp(c.trim + c.elevator * 0.3 * dt, -1, 1);
  }
}
