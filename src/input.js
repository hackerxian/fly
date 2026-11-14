const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const approach = (v, target, step) => v + clamp(target - v, -step, step);
const dead = (v) => (Math.abs(v) < 0.08 ? 0 : v);
const DEG = Math.PI / 180;

// 键盘 / 鼠标 / 手柄 → 操纵量。一次性按键通过 actions[e.code]() 分发
export class Input {
  keys = new Set();
  mouse = { x: 0, y: 0 }; // 鼠标杆位置 -1..1（指针锁定时生效）
  assist = true; // 操纵辅助：地面方向保持 + 键盘防失速拉杆
  ref = null; // 辅助保持的航向

  constructor(actions) {
    addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (!e.repeat) actions[e.code]?.();
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (!document.pointerLockElement) return;
      this.mouse.x = clamp(this.mouse.x + e.movementX / 350, -1, 1);
      this.mouse.y = clamp(this.mouse.y + e.movementY / 350, -1, 1);
    });
    document.addEventListener('pointerlockchange', () => (this.mouse.x = this.mouse.y = 0));
  }

  axis(neg, pos) {
    return (this.keys.has(pos) ? 1 : 0) - (this.keys.has(neg) ? 1 : 0);
  }

  /** 每帧调用：把输入平滑地写入 controls；自动驾驶接通时方向键改为调节目标航向/高度 */
  update(dt, c, ap, ac) {
    let pitch = this.axis('ArrowUp', 'ArrowDown'), roll = this.axis('ArrowLeft', 'ArrowRight'), yaw = this.axis('KeyA', 'KeyD');
    let throttle = this.axis('KeyS', 'KeyW'), brake = this.keys.has('Space') ? 1 : 0;
    let direct = !!document.pointerLockElement; // 鼠标/手柄是模拟量，直接作为杆位

    const pad = navigator.getGamepads?.().find((p) => p?.connected);
    if (pad) {
      const [lx, ly, rx] = pad.axes.map(dead);
      if (lx || ly) (roll = lx), (pitch = ly), (direct = true);
      yaw ||= rx;
      throttle ||= (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
      brake ||= pad.buttons[0]?.value ?? 0;
    } else if (direct) {
      roll ||= this.mouse.x;
      pitch ||= this.mouse.y;
    }

    if (ap.on) {
      ap.hdg += roll * 0.35 * dt;
      ap.alt = Math.max(0, ap.alt - pitch * 6 * dt);
    } else if (direct) {
      c.aileron = roll;
      c.elevator = pitch;
    } else {
      // 键盘：按住逐渐打舵，松开较快回中；辅助开启时按约 1 秒后的迎角提前减小拉杆，避免拉到失速
      const pull = this.assist && pitch > 0 ? clamp((12 * DEG - ac.alpha - ac.omega.y) / (4 * DEG), 0, 1) : 1;
      c.aileron = approach(c.aileron, roll, (roll ? 2.2 : 4) * dt);
      c.elevator = approach(c.elevator, pitch * pull, (pitch ? 1.4 : 3.5) * dt);
    }
    if (this.assist && ac.onGround && !yaw) {
      // 地面方向舵辅助：没踩舵时保持松舵瞬间的航向（滑跑只需很小的舵量，开关量的按键给不出来）
      const err = (this.ref ??= ac.heading) - ac.heading;
      c.rudder = clamp(Math.atan2(Math.sin(err), Math.cos(err)) * 6 - ac.omega.z * 1.5, -1, 1);
    } else {
      this.ref = ac.heading;
      c.rudder = approach(c.rudder, yaw, (yaw ? 2.5 : 4) * dt);
    }
    c.throttle = clamp(c.throttle + throttle * 0.5 * dt, 0, 1);
    c.trim = clamp(c.trim + this.axis('BracketLeft', 'BracketRight') * 0.12 * dt, -1, 1);
    c.brake = brake;
  }
}
