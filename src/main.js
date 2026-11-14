import * as THREE from 'three';
import { Aircraft, KT, FT, FLAP_DEG } from './physics/aircraft.js';
import { Autopilot } from './physics/autopilot.js';
import { Wind } from './physics/atmosphere.js';
import { Terrain, ELEV } from './world/terrain.js';
import { Sky } from './world/sky.js';
import { Scenery, isPaved } from './world/scenery.js';
import { AircraftModel } from './aircraft/model.js';
import { ViewCamera } from './camera.js';
import { Input } from './input.js';
import { Instruments } from './instruments.js';
import { Sound } from './audio.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const DT = 1 / 240; // 物理固定步长

// —— 渲染器：HDR 缓冲 + 对数深度（近到座舱、远到百公里外的海平线）——
const renderer = new THREE.WebGLRenderer({
  canvas: $('view'), antialias: true, logarithmicDepthBuffer: true, outputBufferType: THREE.HalfFloatType,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
const terrain = new Terrain(scene);
const sky = new Sky(scene, renderer);
const scenery = new Scenery(scene, terrain, renderer.capabilities.getMaxAnisotropy());
const model = new AircraftModel();
scene.add(model.group);
const view = new ViewCamera(renderer.domElement);
const instruments = new Instruments($('gauges'));
const sound = new Sound();

const ac = new Aircraft(), ap = new Autopilot(), wind = new Wind();
// 物理用 NED 坐标，地形用 three 坐标（x 东、z 南）
const ground = { height: (n, e) => terrain.height(e, -n), paved: (n, e) => isPaved(e, -n) };

// —— 起始位置、天气、时间预设 ——
const STARTS = {
  Digit1: { name: '36 号跑道起飞', n: -690, alt: ELEV + 1, parkBrake: true },
  Digit2: { name: '五边进近（距跑道 6 km）', n: -6500, alt: ELEV + 315, speed: 70 * KT, throttle: 0.3, flaps: 2, trim: -0.13 },
  Digit3: { name: '空中巡航', n: -9000, e: -3000, alt: 1200, heading: 40 * DEG, speed: 100 * KT, throttle: 0.65, trim: -0.08 },
};
const WEATHER = [
  { name: '静风，能见度极佳', dir: 0, kt: 0, turb: 0, fog: 3.2e-5 },
  { name: '微风 330° / 8 kt', dir: 330, kt: 8, turb: 0.5, fog: 3.2e-5 },
  { name: '侧风 270° / 15 kt，阵风颠簸', dir: 270, kt: 15, turb: 1.6, fog: 4.5e-5 },
  { name: '薄雾，能见度约 8 km', dir: 20, kt: 5, turb: 0.3, fog: 2.5e-4 },
];
const HOURS = [10, 13, 17.7, 21];

let running = false, paused = false, start = 'Digit1', weather = 0, hour = 0;

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}

function overlay(title, subtitle) {
  $('overlay').hidden = !title;
  $('title').textContent = title;
  $('subtitle').textContent = subtitle;
  $('start').hidden = true;
}

function reset(key = start) {
  if (!running) return;
  start = key;
  ac.place(STARTS[key]);
  input.ref = null;
  ap.on = false;
  paused = false;
  view.follow = ac.heading;
  overlay();
  toast(STARTS[key].name);
}

function setWeather(i) {
  const w = WEATHER[(weather = i % WEATHER.length)];
  Object.assign(wind, { dir: w.dir * DEG, speed: w.kt * KT, turb: w.turb });
  scene.fog.density = w.fog;
  if (running) toast(`天气：${w.name}`);
}

function setTime(i) {
  sky.setTime(HOURS[(hour = i % HOURS.length)]);
  if (running) toast(`时间 ${Math.floor(sky.hour)}:${String(Math.round((sky.hour % 1) * 60)).padStart(2, '0')}`);
}

// —— 一次性按键 ——
const flaps = (d) => {
  ac.controls.flaps = Math.min(3, Math.max(0, ac.controls.flaps + d));
  toast(`襟翼 ${FLAP_DEG[ac.controls.flaps]}°`);
};
const input = new Input({
  KeyF: () => flaps(1),
  KeyV: () => flaps(-1),
  KeyB: () => (ac.controls.parkBrake = !ac.controls.parkBrake),
  KeyE: () => toast((ac.engineOn = !ac.engineOn) ? '发动机启动' : '发动机关车'),
  KeyG: () => toast((input.assist = !input.assist) ? '操纵辅助：开' : '操纵辅助：关（原始操纵）'),
  KeyZ: () => (ap.on ? (ap.on = false) : ap.engage(ac), toast(ap.on ? '自动驾驶接通：保持当前航向与高度' : '自动驾驶断开')),
  KeyC: () => view.next(),
  KeyM: () => (document.pointerLockElement ? document.exitPointerLock() : renderer.domElement.requestPointerLock()),
  KeyT: () => setTime(hour + 1),
  KeyX: () => setWeather(weather + 1),
  KeyL: () => (model.landingLight.intensity = model.landingLight.intensity ? 0 : 5000),
  KeyH: () => ($('help').hidden = !$('help').hidden),
  KeyR: () => reset(),
  KeyP: () => running && !ac.crashed && ((paused = !paused) ? overlay('已暂停', '按 P 继续飞行') : overlay()),
  Digit1: () => reset('Digit1'),
  Digit2: () => reset('Digit2'),
  Digit3: () => reset('Digit3'),
});

// —— 状态栏 ——
const badge = (on, cls, label) => (on ? `<span class="badge ${cls}">${label}</span>` : '');
function status() {
  const c = ac.controls;
  const html = `油门 <b>${Math.round(c.throttle * 100)}%</b>
    襟翼 <b>${Math.round(ac.flap * 30)}°</b>
    配平 <b>${(c.trim * 100).toFixed(0)}</b>
    燃油 <b>${Math.round(ac.fuel / 0.72)} L</b>
    过载 <b>${ac.gLoad.toFixed(1)} G</b>
    风 <b>${wind.speed ? `${Math.round(wind.dir / DEG) || 360}° / ${Math.round(wind.speed / KT)} kt` : '静风'}</b>
    ${badge(c.parkBrake, 'amber', '停机刹车')}${badge(c.brake > 0, 'amber', '刹车')}
    ${badge(!ac.engineOn || !ac.fuel, 'amber', '发动机停车')}
    ${badge(ap.on, 'cyan', `AP ${String(Math.round(((ap.hdg / DEG) % 360 + 360) % 360) || 360).padStart(3, '0')}° ${Math.round(ap.alt / FT / 10) * 10} ft`)}
    ${badge(!!document.pointerLockElement, 'grey', '鼠标杆')}${badge(!input.assist, 'grey', '操纵辅助关')}
    ${badge(ac.stallWarn, 'red', '失速')}${badge(ac.ias > 163 * KT, 'red', '超速')}`;
  if (html !== status.last) $('status').innerHTML = status.last = html;
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  view.camera.aspect = innerWidth / innerHeight;
}
addEventListener('resize', resize);
resize();

$('start').onclick = () => {
  running = true;
  sound.start();
  overlay();
  toast('按 B 松开停机刹车');
};

// —— 主循环 ——
let last = performance.now(), lag = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const active = running && !paused && !ac.crashed;

  if (active) {
    input.update(dt, ac.controls, ap, ac);
    const wasAp = ap.on;
    for (lag += dt; lag >= DT; lag -= DT) {
      wind.update(DT);
      ap.update(ac, DT);
      ac.step(DT, wind, ground);
    }
    if (wasAp && !ap.on) toast('失速！自动驾驶断开');
    if (ac.touchdown !== null) {
      const fpm = Math.round((ac.touchdown / FT) * 60);
      sound.touchdown(ac.touchdown);
      toast(`接地 ${fpm} ft/min · ${fpm < 150 ? '轻柔，漂亮！' : fpm < 350 ? '正常' : '偏重'}`);
      ac.touchdown = null;
    }
    if (ac.crashed) overlay('坠毁', `${ac.crashed} · 按 R 重新开始`);
  } else if (!running) {
    view.yaw += dt * 0.08; // 开始界面：镜头缓慢环绕
  }

  model.update(ac, active ? dt : 0);
  model.group.updateMatrixWorld();
  const groundSpeed = Math.hypot(ac.vel.x, ac.vel.y);
  const shake = active ? (ac.onGround ? Math.min(groundSpeed / 40, 1) * 0.008 : ac.stall * 0.025) : 0;
  view.update(model.group, ac.heading, shake, dt, terrain);
  terrain.update(view.camera.position, active ? dt : 0);
  sky.update(view.camera, model.group.position, wind, active ? dt : 0);
  scenery.update(model.group.position, wind, sky.night);
  instruments.draw(ac, ap);
  status();
  sound.update(ac, !active);
  renderer.render(scene, view.camera);
}

if (import.meta.env.DEV) window.sim = { ac, ap, wind, view, sky, model, scene, renderer, reset, setTime, setWeather }; // 开发调试入口
setWeather(0);
setTime(0);
ac.place(STARTS[start]);
requestAnimationFrame(frame);
