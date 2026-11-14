// 飞行动力学模型的无头校验：把关键性能与 Cessna 172 手册数据对比
import { Aircraft, KT, FT } from '../src/physics/aircraft.js';
import { Autopilot } from '../src/physics/autopilot.js';
import { Wind } from '../src/physics/atmosphere.js';

const DT = 1 / 240, DEG = Math.PI / 180;
const flat = { height: () => 0, paved: () => true };
const calm = new Wind();
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const results = [];
const check = (name, value, lo, hi, unit = '') => {
  const ok = value >= lo && value <= hi;
  results.push(ok);
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}: ${value.toFixed(1)}${unit}  (期望 ${lo}–${hi})`);
};

// 运行 seconds 秒；每步调用 control(ac, t)
function run(ac, seconds, control = () => {}) {
  for (let t = 0; t < seconds && !ac.crashed; t += DT) {
    control(ac, t);
    ac.step(DT, calm, flat);
  }
}

// 用俯仰保持指示空速（测试用的简单控制器）
function holdSpeed(target) {
  let ref = 0;
  return (ac) => {
    const err = (ac.ias - target) * 0.02;
    ref = clamp(ref + err * 0.3 * DT, -0.3, 0.3);
    ac.controls.elevator = clamp((clamp(ref + err, -0.35, 0.35) - ac.pitch) * 4 - ac.omega.y * 1.2, -1, 1);
    ac.controls.aileron = clamp(-ac.roll * 2 - ac.omega.x * 0.8, -1, 1);
  };
}

function airborne(opts) {
  const ac = new Aircraft();
  ac.place({ alt: 600, speed: 55, throttle: 0.7, ...opts });
  const ap = new Autopilot();
  ap.engage(ac);
  return { ac, ap };
}

console.log('地面');
{
  const ac = new Aircraft();
  ac.place({ alt: 1.0, parkBrake: true });
  run(ac, 15);
  check('停机刹车静置 15 s 的位移', Math.hypot(ac.pos.x, ac.pos.y), 0, 0.3, ' m');
  check('静置俯仰角', ac.pitch / DEG, -1, 3, '°');
  check('怠速转速', ac.rpm, 550, 800, ' rpm');
  ac.controls.throttle = 1;
  run(ac, 10);
  check('地面全油门静态转速', ac.rpm, 2200, 2450, ' rpm');
  check('静态推力', ac.thrust, 1900, 2700, ' N');
  check('全油门刹车能刹住', Math.hypot(ac.pos.x, ac.pos.y), 0, 1.5, ' m');
}

console.log('起飞与爬升');
{
  const ac = new Aircraft();
  ac.place({ alt: 1.0 });
  let liftoff = null, maxYaw = 0;
  const climb = holdSpeed(76 * KT);
  const hdg = (a) => Math.atan2(Math.sin(a.heading), Math.cos(a.heading));
  run(ac, 90, (a, t) => {
    a.controls.throttle = 1;
    a.controls.rudder = clamp(-hdg(a) * 3 - a.omega.z * 1.5, -1, 1);
    if (a.agl > 15) return climb(a);
    // 55 kt 抬轮，保持 10° 俯仰离地
    a.controls.elevator = a.ias > 55 * KT ? clamp((10 * DEG - a.pitch) * 4 - a.omega.y * 1.2, -1, 1) : 0;
    a.controls.aileron = clamp(-a.roll * 2 - a.omega.x * 0.8, -1, 1);
    if (a.onGround) maxYaw = Math.max(maxYaw, Math.abs(hdg(a)));
    else if (!liftoff) liftoff = { dist: a.pos.x, t, ias: a.ias };
  });
  if (ac.crashed) console.log('  坠毁:', ac.crashed);
  check('起飞滑跑距离', liftoff?.dist ?? 9999, 180, 380, ' m');
  check('离地速度', (liftoff?.ias ?? 0) / KT, 50, 68, ' kt');
  check('滑跑中最大偏航', maxYaw / DEG, 0, 6, '°');
  check('海平面爬升率 @76kt', ac.vs / FT * 60, 600, 850, ' fpm');
  check('爬升空速', ac.ias / KT, 73, 79, ' kt');
}

console.log('平飞性能（自动驾驶保持高度）');
{
  const { ac, ap } = airborne({ throttle: 1 });
  run(ac, 150, (a) => ap.update(a, DT));
  check('全油门最大平飞速度', ac.ias / KT, 112, 128, ' kt');
  check('全油门转速', ac.rpm, 2550, 2800, ' rpm');
  check('高度保持误差', Math.abs(ac.altitude - ap.alt), 0, 5, ' m');
  ac.controls.throttle = 0.62;
  run(ac, 150, (a) => ap.update(a, DT));
  console.log(`    62% 油门巡航: ${(ac.ias / KT).toFixed(1)} kt, ${ac.rpm.toFixed(0)} rpm, 配平 ${ac.controls.trim.toFixed(3)}, 俯仰 ${(ac.pitch / DEG).toFixed(1)}°`);
  // 转弯 90°
  ap.hdg = 90 * DEG;
  let maxBank = 0;
  run(ac, 60, (a) => { ap.update(a, DT); maxBank = Math.max(maxBank, Math.abs(a.roll)); });
  check('自动驾驶转向后航向', ac.heading / DEG, 88, 92, '°');
  check('转弯坡度', maxBank / DEG, 15, 27, '°');
  check('转弯后高度误差', Math.abs(ac.altitude - ap.alt), 0, 8, ' m');
}

console.log('失速');
for (const flaps of [0, 3]) {
  const { ac, ap } = airborne({ throttle: 0.5, flaps, speed: 40 });
  run(ac, 30, (a) => ap.update(a, DT)); // 先稳定平飞，再收油门减速
  ac.controls.throttle = 0;
  let warnAt = 0, vMin = 0;
  run(ac, 120, (a) => {
    if (vMin) return;
    ap.update(a, DT);
    if (a.stallWarn && !warnAt) warnAt = a.ias;
    if (!ap.on) vMin = a.ias; // 自动驾驶在失速时断开
  });
  check(`失速速度（襟翼 ${flaps * 10}°）`, vMin / KT, flaps ? 37 : 44, flaps ? 45 : 51, ' kt');
  check('  失速告警提前量', (warnAt - vMin) / KT, 3, 12, ' kt');
}

console.log('无动力滑翔');
{
  const { ac } = airborne({});
  ac.engineOn = false;
  const glide = holdSpeed(65 * KT);
  run(ac, 40, glide);
  const a0 = ac.altitude, n0 = ac.pos.x;
  run(ac, 60, glide);
  check('滑翔比 @65kt', (ac.pos.x - n0) / (a0 - ac.altitude), 7.5, 10.5);
  check('风车转速', ac.rpm, 300, 1300, ' rpm');
}

console.log('动稳定性（松杆）');
{
  const { ac, ap } = airborne({ throttle: 0.62 });
  run(ac, 120, (a) => ap.update(a, DT));
  ac.controls.elevator = 0; ac.controls.aileron = 0;
  ac.omega.z += 0.2; // 偏航扰动 → 荷兰滚
  run(ac, 8);
  check('荷兰滚 8 s 后偏航角速度', Math.abs(ac.omega.z) / DEG, 0, 1.5, '°/s');
  // 长周期（沉浮）振荡：只保持机翼水平，升降舵松杆
  const level = (a) => { a.controls.aileron = clamp(-a.roll * 2 - a.omega.x * 0.8, -1, 1); };
  ac.omega.y += 0.15;
  const swing = (seconds) => {
    let hi = -1e9, lo = 1e9;
    run(ac, seconds, (a) => { level(a); hi = Math.max(hi, a.vs); lo = Math.min(lo, a.vs); });
    return hi - lo;
  };
  const amp1 = swing(40);
  run(ac, 40, level);
  const amp2 = swing(40);
  console.log(`    沉浮振荡升降率摆幅: 0–40 s ${amp1.toFixed(2)} m/s, 80–120 s ${amp2.toFixed(2)} m/s`);
  check('长周期振荡衰减（后段/前段幅值）', amp2 / amp1, 0, 0.8);
  // 螺旋模态：完全松杆 3 分钟
  ac.controls.aileron = 0;
  const alt0 = ac.altitude;
  run(ac, 180);
  check('松杆 3 分钟后高度漂移', Math.abs(ac.altitude - alt0), 0, 80, ' m');
  check('松杆 3 分钟后坡度', Math.abs(ac.roll) / DEG, 0, 20, '°');
}

console.log('着陆');
{
  const ac = new Aircraft();
  ac.place({ alt: 60, speed: 34, throttle: 0.25, flaps: 3 });
  const approach = holdSpeed(62 * KT);
  run(ac, 120, (a) => {
    if (a.onGround) { a.controls.throttle = 0; a.controls.brake = 1; a.controls.elevator = 0.3; a.controls.aileron = 0; return; }
    if (a.agl > 5) return approach(a);
    a.controls.throttle = 0; // 拉平
    a.controls.elevator = clamp((clamp(4 * DEG + (5 - a.agl) * 1.2 * DEG, 0, 9 * DEG) - a.pitch) * 5 - a.omega.y * 1.5, -1, 1);
  });
  console.log(`    结果: ${ac.crashed ?? '安全停稳'}, 地速 ${Math.hypot(ac.vel.x, ac.vel.y).toFixed(2)} m/s, 俯仰 ${(ac.pitch / DEG).toFixed(1)}°`);
  check('着陆未坠毁且停稳', ac.crashed ? 99 : Math.hypot(ac.vel.x, ac.vel.y), 0, 0.5, ' m/s');
}

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} 项未达标` : '\n全部达标');
process.exit(failed ? 1 : 0);
