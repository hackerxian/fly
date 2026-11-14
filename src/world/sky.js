import * as THREE from 'three';

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const CLOUD_AREA = 70000; // 云场边长：云在相机周围循环平铺，等效于无限云层

const SKY_FRAG = /* glsl */ `
  uniform vec3 uSun, uZenith, uHorizon, uSunColor;
  uniform float uNight, uDisc;
  varying vec3 vDir;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  void main() {
    vec3 d = normalize(vDir);
    float mu = max(dot(d, uSun), 0.0);
    float t = pow(1.0 - max(d.y, 0.0), 5.0);
    vec3 col = mix(uZenith, uHorizon, t);
    col += uSunColor * (0.5 * pow(mu, 8.0) * t + 0.25 * pow(mu, 200.0)); // 太阳一侧的地平线辉光与日晕
    col += uSunColor * uDisc * 60.0 * smoothstep(0.99992, 0.99996, mu); // 日面
    vec3 cell = floor(d * 240.0); // 星空
    float star = step(0.994, hash(cell)) * smoothstep(0.35, 0.0, length(fract(d * 240.0) - 0.5));
    col += uNight * star * (0.4 + hash(cell + 1.0)) * smoothstep(0.0, 0.25, d.y);
    col = mix(col, uHorizon * 0.55, smoothstep(0.0, -0.25, d.y)); // 地平线以下（供环境反射用）
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const CLOUD_VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aCenter;
  attribute vec2 aPuff; // x = 尺寸, y = 在云体内的相对高度
  uniform vec2 uDrift;
  varying vec2 vUv;
  varying float vShade, vFade;
  void main() {
    vec3 c = aCenter;
    c.xz = mod(c.xz + uDrift - cameraPosition.xz + ${CLOUD_AREA / 2}.0, ${CLOUD_AREA}.0) - ${CLOUD_AREA / 2}.0;
    float edge = max(abs(c.x), abs(c.z)) / ${CLOUD_AREA / 2}.0;
    c.xz += cameraPosition.xz;
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec4 mvPosition = viewMatrix * vec4(c + (right * position.x + up * position.y) * aPuff.x, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    vUv = uv;
    vShade = aPuff.y;
    vFade = smoothstep(1.0, 0.8, edge) * smoothstep(30.0, 300.0, -mvPosition.z); // 平铺边界与贴脸时淡出
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }
`;

const CLOUD_FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uLit, uShade;
  varying vec2 vUv;
  varying float vShade, vFade;
  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vUv - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.25, r) * 0.55 * vFade;
    if (a < 0.003) discard;
    gl_FragColor = vec4(mix(uShade, uLit, vShade), a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

// 由若干柔和面片堆成的积云；底部平、顶部隆起
function buildClouds() {
  const centers = [], puffs = [];
  for (let i = 0; i < 300; i++) {
    const cx = (Math.random() - 0.5) * CLOUD_AREA, cz = (Math.random() - 0.5) * CLOUD_AREA;
    const base = 1500 + Math.random() * 500, w = 500 + Math.random() ** 2 * 1800, hgt = 200 + w * 0.3;
    const count = 8 + Math.floor(w / 110);
    for (let j = 0; j < count; j++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * w * 0.5;
      const y = Math.random() ** 1.6 * (1 - (r / (w * 0.5)) ** 2); // 越靠边越矮
      centers.push(cx + Math.cos(a) * r, base + y * hgt, cz + Math.sin(a) * r * 0.7);
      puffs.push(320 + Math.random() * 380 + w * 0.12, 0.25 + 0.75 * y);
    }
  }
  const g = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
  g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(new Float32Array(centers), 3));
  g.setAttribute('aPuff', new THREE.InstancedBufferAttribute(new Float32Array(puffs), 2));
  g.instanceCount = puffs.length / 2;
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uDrift: { value: new THREE.Vector2() }, uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() },
    }]),
    vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG,
    transparent: true, depthWrite: false, fog: true,
  });
  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}

export class Sky {
  sunDir = new THREE.Vector3();
  night = 0; // 0 白天 … 1 夜晚

  constructor(scene, renderer) {
    this.scene = scene;
    this.uniforms = {
      uSun: { value: this.sunDir }, uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() }, uNight: { value: 0 }, uDisc: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide, depthTest: false, depthWrite: false,
    });
    const sphere = new THREE.SphereGeometry(1, 48, 24);
    this.dome = new THREE.Mesh(sphere, material);
    this.dome.scale.setScalar(2000);
    this.dome.renderOrder = -1;
    this.dome.frustumCulled = false;

    this.sun = new THREE.DirectionalLight();
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 3000 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;

    this.clouds = buildClouds();
    scene.fog = new THREE.FogExp2(0xffffff, 3.2e-5);
    scene.add(this.dome, this.sun, this.sun.target, this.clouds);

    // 天空球渲染成环境贴图，给机身、海面提供天光反射与环境光
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene().add(new THREE.Mesh(sphere, material));
    this.envScene.children[0].scale.setScalar(50);
  }

  // hour: 0–24，6 点日出、18 点日落
  setTime(hour) {
    this.hour = hour;
    const ang = ((hour - 6) / 12) * Math.PI;
    this.sunDir.set(Math.cos(ang), Math.sin(ang) * 0.87, Math.sin(ang) * 0.5).normalize();
    const e = this.sunDir.y;
    const day = smooth(-0.1, 0.25, e), dusk = Math.exp(-((e / 0.2) ** 2));
    this.night = 1 - day;
    const u = this.uniforms;
    u.uZenith.value.setRGB(0.002, 0.003, 0.008).lerp(new THREE.Color(0.07, 0.22, 0.6), day);
    u.uHorizon.value.setRGB(0.006, 0.008, 0.016).lerp(new THREE.Color(0.48, 0.64, 0.86), day)
      .lerp(new THREE.Color(0.75, 0.36, 0.16), dusk * 0.55 * smooth(-0.2, -0.05, e));
    u.uSunColor.value.setRGB(1, 0.4, 0.15).lerp(new THREE.Color(1, 0.95, 0.88), smooth(0, 0.4, e)).multiplyScalar(smooth(-0.08, 0.05, e));
    u.uNight.value = this.night;

    // 太阳落山后改用微弱的月光
    const moon = e < -0.02;
    this.lightDir = moon ? new THREE.Vector3(-0.4, 0.75, -0.5).normalize() : this.sunDir;
    this.sun.color.copy(moon ? new THREE.Color(0.55, 0.65, 1) : u.uSunColor.value);
    this.sun.intensity = moon ? 0.12 : 3.4 * smooth(-0.02, 0.2, e);
    this.scene.fog.color.copy(u.uHorizon.value);

    const cloud = this.clouds.material.uniforms;
    cloud.uLit.value.copy(u.uSunColor.value).lerp(new THREE.Color(1, 1, 1), 0.4).multiplyScalar(0.03 + 1.25 * day);
    cloud.uShade.value.copy(u.uHorizon.value).lerp(u.uZenith.value, 0.35).multiplyScalar(0.75);

    u.uDisc.value = 0; // 环境贴图里不要日面，高光由直射光负责
    this.scene.environment?.dispose();
    this.scene.environment = this.pmrem.fromScene(this.envScene).texture;
    u.uDisc.value = 1;
  }

  // 天空球与阴影相机跟随相机/飞机，云随风漂移
  update(camera, focus, wind, dt) {
    this.dome.position.copy(camera.position);
    this.sun.position.copy(focus).addScaledVector(this.lightDir, 200);
    this.sun.target.position.copy(focus);
    this.clouds.material.uniforms.uDrift.value.x += wind.vel.y * dt;
    this.clouds.material.uniforms.uDrift.value.y -= wind.vel.x * dt;
  }
}
