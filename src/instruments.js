import { KT, FT } from './physics/aircraft.js';
import { TOUCH } from './input.js';

const TAU = Math.PI * 2, DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const WHITE = '#f2f2f2', FONT = '"Helvetica Neue", Arial, sans-serif';

// 以下绘图函数都在「单位圆」坐标系里工作（表盘半径 = 1），角度从 12 点方向顺时针计
const polar = (deg, r) => [Math.sin(deg * DEG) * r, -Math.cos(deg * DEG) * r];

function tick(g, deg, r0, r1, width = 0.02, color = WHITE) {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(...polar(deg, r0));
  g.lineTo(...polar(deg, r1));
  g.stroke();
}

function arc(g, from, to, color, r = 0.9, width = 0.06) {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.beginPath();
  g.arc(0, 0, r, (from - 90) * DEG, (to - 90) * DEG);
  g.stroke();
}

function text(g, str, x, y, size = 0.17, color = WHITE) {
  g.fillStyle = color;
  g.font = `600 ${size}px ${FONT}`;
  g.fillText(str, x, y);
}

function needle(g, deg, length, width = 0.045, tail = 0.15) {
  g.save();
  g.rotate(deg * DEG);
  g.fillStyle = WHITE;
  g.beginPath();
  g.moveTo(-width, tail);
  g.lineTo(-width * 0.5, -length * 0.8);
  g.lineTo(0, -length);
  g.lineTo(width * 0.5, -length * 0.8);
  g.lineTo(width, tail);
  g.fill();
  g.restore();
  g.fillStyle = '#222';
  g.beginPath();
  g.arc(0, 0, 0.07, 0, TAU);
  g.fill();
}

// 刻度盘：值域 [min, max] 映射到角度 map(v)，每 step 一小格，每 major 一大格并标数字
function scale(g, map, min, max, step, major, label = (v) => v) {
  for (let v = min; v <= max + 1e-6; v += step) {
    const big = Math.abs(v / major - Math.round(v / major)) < 1e-6;
    tick(g, map(v), big ? 0.76 : 0.84, 0.95, big ? 0.03 : 0.015);
    if (big) text(g, label(v), ...polar(map(v), 0.6));
  }
}

// —— 各仪表：face 画静态表盘（只画一次），draw 画随状态变化的部分 ——
const asiAngle = (kt) => 20 + (clamp(kt, 0, 200) / 200) * 320;
const vsiAngle = (fpm) => -90 + (clamp(fpm, -2000, 2000) / 2000) * 170;
const tachAngle = (rpm) => -135 + (clamp(rpm, 0, 3500) / 3500) * 270;

const GAUGES = [
  { // 空速表
    face(g) {
      arc(g, asiAngle(41), asiAngle(85), '#e8e8e8', 0.83, 0.04); // 白弧：襟翼使用范围
      arc(g, asiAngle(48), asiAngle(129), '#2faa4a'); // 绿弧：正常使用范围
      arc(g, asiAngle(129), asiAngle(163), '#e2b93b'); // 黄弧：警戒范围
      tick(g, asiAngle(163), 0.78, 0.97, 0.04, '#e03131'); // 红线：极限速度
      scale(g, asiAngle, 20, 200, 10, 20);
      text(g, 'KNOTS', 0, 0.3, 0.12, '#aaa');
    },
    draw: (g, s) => needle(g, asiAngle(s.ias / KT), 0.88),
  },
  { // 姿态仪
    draw(g, s) {
      const px = 0.021; // 每度俯仰对应的位移
      g.save();
      g.beginPath();
      g.arc(0, 0, 0.93, 0, TAU);
      g.clip();
      g.rotate(-s.roll);
      g.translate(0, (s.pitch / DEG) * px);
      g.fillStyle = '#2f7fd1';
      g.fillRect(-3, -6, 6, 6);
      g.fillStyle = '#7a4b22';
      g.fillRect(-3, 0, 6, 6);
      g.fillStyle = WHITE;
      g.fillRect(-3, -0.008, 6, 0.016);
      for (let p = -30; p <= 30; p += 5) {
        if (!p) continue;
        const w = p % 10 ? 0.1 : 0.22;
        g.fillRect(-w, -p * px - 0.006, w * 2, 0.012);
        if (p % 10 === 0) text(g, Math.abs(p), w + 0.12, -p * px, 0.11);
      }
      g.translate(0, (-s.pitch / DEG) * px);
      for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) tick(g, b, b % 30 ? 0.86 : 0.8, 0.93, 0.025); // 坡度刻度
      g.restore();
      g.fillStyle = '#ffb21a'; // 固定的小飞机与坡度指针
      g.beginPath();
      g.moveTo(0, -0.79); g.lineTo(-0.06, -0.68); g.lineTo(0.06, -0.68);
      g.fill();
      g.fillRect(-0.5, -0.02, 0.32, 0.04);
      g.fillRect(0.18, -0.02, 0.32, 0.04);
      g.fillRect(-0.03, -0.03, 0.06, 0.06);
    },
  },
  { // 高度表（长针百英尺、短针千英尺）
    face(g) {
      scale(g, (v) => v * 36, 0, 9.8, 0.2, 1, Math.round);
      text(g, 'ALT  ft', 0, -0.3, 0.11, '#aaa');
    },
    draw(g, s) {
      const ft = s.altitude / FT;
      g.fillStyle = '#000';
      g.fillRect(-0.3, 0.22, 0.6, 0.2);
      text(g, Math.round(ft / 10) * 10, 0, 0.325, 0.15, '#9fe870');
      g.save();
      g.rotate((ft / 10000) * TAU);
      g.fillStyle = WHITE;
      g.fillRect(-0.05, -0.5, 0.1, 0.5);
      g.restore();
      needle(g, (ft / 1000) * 360, 0.88, 0.035);
    },
  },
  { // 转弯侧滑仪
    face(g) {
      for (const a of [-110, -90, 90, 110]) tick(g, a, 0.78, 0.95, 0.04);
      text(g, 'L', -0.62, 0.36, 0.14);
      text(g, 'R', 0.62, 0.36, 0.14);
      text(g, '2 MIN', 0, 0.82, 0.1, '#aaa');
    },
    draw(g, s) {
      g.save(); // 小飞机倾斜 20° = 标准转弯率 3°/s
      g.rotate(clamp((s.turnRate / DEG / 3) * 20, -45, 45) * DEG);
      g.fillStyle = WHITE;
      g.fillRect(-0.7, -0.025, 1.4, 0.05);
      g.fillRect(-0.02, -0.25, 0.04, 0.25);
      g.beginPath();
      g.arc(0, 0, 0.1, 0, TAU);
      g.fill();
      g.restore();
      g.fillStyle = '#d8d8d0'; // 侧滑小球
      g.fillRect(-0.42, 0.46, 0.84, 0.2);
      g.fillStyle = '#111';
      g.fillRect(-0.105, 0.46, 0.012, 0.2);
      g.fillRect(0.093, 0.46, 0.012, 0.2);
      g.beginPath();
      g.arc(clamp(s.slip * 2.2, -0.32, 0.32), 0.56, 0.085, 0, TAU);
      g.fill();
    },
  },
  { // 航向仪
    draw(g, s, ap) {
      g.save();
      g.rotate(-s.heading);
      for (let d = 0; d < 360; d += 5) {
        tick(g, d, d % 10 ? 0.86 : 0.8, 0.95, 0.015);
        if (d % 30 === 0) {
          g.save();
          g.rotate(d * DEG);
          text(g, { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] ?? d / 10, 0, -0.64, d % 90 ? 0.15 : 0.19);
          g.restore();
        }
      }
      if (ap.on) { // 自动驾驶的目标航向游标
        g.rotate(ap.hdg);
        g.fillStyle = '#35d0e0';
        g.fillRect(-0.07, -0.97, 0.14, 0.09);
      }
      g.restore();
      g.strokeStyle = '#ffb21a';
      g.lineWidth = 0.035;
      g.beginPath();
      g.moveTo(0, -0.42); g.lineTo(0, 0.38);
      g.moveTo(-0.3, 0); g.lineTo(0.3, 0);
      g.moveTo(-0.12, 0.3); g.lineTo(0.12, 0.3);
      g.stroke();
      tick(g, 0, 0.74, 0.97, 0.04, '#ffb21a');
    },
  },
  { // 升降速度表
    face(g) {
      scale(g, vsiAngle, -2000, 2000, 100, 500, (v) => Math.abs(v) / 100);
      text(g, 'UP', -0.38, -0.2, 0.11, '#aaa');
      text(g, 'DN', -0.38, 0.2, 0.11, '#aaa');
      text(g, '100 ft/min', 0.22, 0, 0.1, '#aaa');
    },
    draw: (g, s) => needle(g, vsiAngle((s.vs / FT) * 60), 0.88),
  },
  { // 转速表
    face(g) {
      arc(g, tachAngle(2100), tachAngle(2700), '#2faa4a');
      tick(g, tachAngle(2700), 0.78, 0.97, 0.04, '#e03131');
      scale(g, tachAngle, 0, 3500, 100, 500, (v) => v / 100);
      text(g, 'RPM ×100', 0, 0.42, 0.11, '#aaa');
    },
    draw: (g, s) => needle(g, tachAngle(s.rpm), 0.88),
  },
];

export class Instruments {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio, 2);
    const d = (this.d = Math.round(clamp(innerWidth / (TOUCH ? 13 : 8), 84, 168))); // 单个仪表直径 (CSS px)，触屏留出摇杆和油门的位置
    this.scale = (d / 2) * dpr;
    this.canvas.width = d * GAUGES.length * dpr;
    this.canvas.height = d * dpr;
    this.canvas.style.width = d * GAUGES.length + 'px';
    // 静态表盘预渲染到离屏画布
    this.faces = GAUGES.map((gauge) => {
      const c = Object.assign(document.createElement('canvas'), { width: d * dpr, height: d * dpr }), g = c.getContext('2d');
      this.frame(g, 0);
      g.fillStyle = '#2a2c30';
      g.beginPath();
      g.arc(0, 0, 1, 0, TAU);
      g.fill();
      g.fillStyle = '#0b0c0e';
      g.beginPath();
      g.arc(0, 0, 0.955, 0, TAU);
      g.fill();
      gauge.face?.(g);
      return c;
    });
  }

  // 把坐标系移到第 i 个表盘中心，并缩放成单位圆
  frame(g, i) {
    g.setTransform(this.scale, 0, 0, this.scale, this.scale * (2 * i + 1), this.scale);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineCap = 'butt';
  }

  draw(state, ap) {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    GAUGES.forEach((gauge, i) => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(this.faces[i], i * this.scale * 2, 0);
      this.frame(g, i);
      gauge.draw(g, state, ap);
    });
  }
}
