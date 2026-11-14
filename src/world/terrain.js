import * as THREE from 'three';
import { makeNoise, noiseTexture } from './noise.js';

export const ELEV = 15; // 机场标高 (m)
const WORLD = 51200, RES = 2048, TEXEL = WORLD / RES; // 高度图覆盖边长、分辨率（25 m/纹素）
const CX = 9500, CZ = -9500, ISLAND_R = 19000; // 岛屿中心与半径；机场在世界原点，靠近西南海岸
const N = 128, LEVELS = 8, BASE_CELL = 8; // 每级网格格数、级数、最细一级的格距 (m)

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// 程序化生成一座海岛的高度图：海岸平原 → 丘陵 → 内陆山脉，机场区域整平
function generate() {
  const { fbm, ridged } = makeNoise(20261114);
  const data = new Float32Array(RES * RES);
  for (let j = 0; j < RES; j++) {
    const z = CZ + ((j + 0.5) / RES - 0.5) * WORLD;
    for (let i = 0; i < RES; i++) {
      const x = CX + ((i + 0.5) / RES - 0.5) * WORLD;
      const coast = Math.hypot(x - CX, z - CZ) / ISLAND_R + 0.16 * fbm(x / 9000, z / 9000, 4);
      const land = smooth(1.0, 0.72, coast);
      let h = -50;
      if (land > 0) {
        const inland = smooth(0.9, 0.35, coast);
        const hills = 0.5 + 0.5 * fbm(x / 1800, z / 1800, 5);
        const far = smooth(2500, 11000, Math.hypot(x, z)); // 机场周边压低山势，留出起落航线空间
        h += land * 58 + inland * (hills * 90 + far * ridged(x / 7000, z / 7000, 6) ** 2 * 2600);
        const d = Math.hypot(Math.max(Math.abs(x) - 500, 0), Math.max(Math.abs(z) - 1300, 0));
        h += (ELEV - h) * smooth(900, 0, d);
      }
      data[j * RES + i] = h;
    }
  }
  return data;
}

// N×N 格的方形网格，顶点坐标为整数格点（实际位置与高度在顶点着色器里算）
function gridGeometry() {
  const half = N / 2, w = N + 1, pos = [], nrm = [], idx = [];
  for (let z = -half; z <= half; z++) for (let x = -half; x <= half; x++) pos.push(x, 0, z), nrm.push(0, 1, 0);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const a = z * w + x;
      idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

const HEIGHT_GLSL = /* glsl */ `
  uniform sampler2D uHeightMap;
  uniform sampler2D uNoise;
  uniform vec4 uWorld; // xy = 高度图中心, z = 边长, w = 纹素边长
  varying vec2 vXZ;
  float terrainH(vec2 p) { return texture2D(uHeightMap, (p - uWorld.xy) / uWorld.z + 0.5).r; }
`;

// 在标准 PBR 材质上注入着色器片段，光照、阴影、雾仍由 three 处理
function inject(material, uniforms, { vertex, color, normal, pars = '' }) {
  material.customProgramCacheKey = () => color; // 回调源码相同，需另给缓存键，否则不同材质会共用同一个着色器程序
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n' + HEIGHT_GLSL)
      .replace('#include <begin_vertex>', vertex);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + HEIGHT_GLSL + pars)
      .replace('#include <map_fragment>', color)
      .replace('#include <normal_fragment_maps>', normal);
  };
  return material;
}

const terrainMaterial = (shared, hole) =>
  inject(new THREE.MeshStandardMaterial({ roughness: 0.93, metalness: 0 }), { ...shared, uHole: hole }, {
    pars: 'uniform vec3 uHole;',
    // 外圈顶点逐渐并入下一级粗网格（位置与采样层级同时过渡），各级之间无缝衔接
    vertex: /* glsl */ `
      float cell = modelMatrix[0][0];
      vec2 g = position.xz;
      float k = clamp((max(abs(g.x), abs(g.y)) / ${N / 2}.0 - 0.75) / 0.2, 0.0, 1.0);
      g -= fract(g * 0.5) * 2.0 * k;
      vXZ = modelMatrix[3].xz + g * cell;
      float lod = max(log2(cell / uWorld.w) + k, 0.0);
      vec3 transformed = vec3(g.x, textureLod(uHeightMap, (vXZ - uWorld.xy) / uWorld.z + 0.5, lod).r, g.y);
    `,
    color: /* glsl */ `
      vec2 hd = abs(vXZ - uHole.xy);
      if (max(hd.x, hd.y) < uHole.z) discard; // 中心区域由更细的一级覆盖
      float e = uWorld.w;
      float h = terrainH(vXZ);
      vec3 tN = normalize(vec3(terrainH(vXZ - vec2(e, 0.0)) - terrainH(vXZ + vec2(e, 0.0)), 2.0 * e,
                               terrainH(vXZ - vec2(0.0, e)) - terrainH(vXZ + vec2(0.0, e))));
      vec4 nA = texture2D(uNoise, vXZ / 2300.0); // 大尺度变化
      vec4 nB = texture2D(uNoise, vXZ / 190.0);
      vec4 nC = texture2D(uNoise, vXZ / 11.0); // 近景细节
      float slope = 1.0 - tN.y;

      // 平原上的农田：按不规则格子随机着色
      vec2 fp = vXZ / 260.0 + (nA.gb - 0.5) * 3.0;
      float fr = fract(sin(dot(floor(fp), vec2(127.1, 311.7))) * 43758.5453);
      vec2 fe = abs(fract(fp) - 0.5);
      vec3 field = mix(vec3(0.15, 0.25, 0.06), vec3(0.40, 0.34, 0.14), fr);
      field = mix(field, vec3(0.09, 0.15, 0.05), smoothstep(0.46, 0.5, max(fe.x, fe.y)));
      float farm = smoothstep(0.03, 0.01, slope) * smoothstep(140.0, 70.0, h) * smoothstep(0.42, 0.5, nA.a)
                 * smoothstep(0.0, 200.0, max(abs(vXZ.x) - 600.0, abs(vXZ.y) - 1500.0));

      vec3 grass = mix(vec3(0.10, 0.19, 0.05), vec3(0.21, 0.27, 0.09), nB.r);
      vec3 forest = mix(vec3(0.03, 0.08, 0.025), vec3(0.06, 0.12, 0.04), nC.a);
      vec3 rock = mix(vec3(0.19, 0.17, 0.15), vec3(0.33, 0.31, 0.29), nB.a);
      vec3 col = mix(grass, field, farm);
      col = mix(col, forest, smoothstep(0.48, 0.6, nA.r * 0.6 + nB.a * 0.4 + smoothstep(80.0, 400.0, h) * 0.2) * (1.0 - farm));
      col = mix(col, rock, max(smoothstep(0.2, 0.38, slope + (nB.r - 0.5) * 0.15), 0.8 * smoothstep(750.0, 1100.0, h)));
      col = mix(col, vec3(0.85, 0.88, 0.92), smoothstep(1000.0, 1250.0, h + nB.r * 250.0) * smoothstep(0.55, 0.3, slope)); // 雪线
      col = mix(vec3(0.60, 0.53, 0.37), col, smoothstep(1.0, 5.0, h + nC.r * 2.5)); // 海滩
      diffuseColor.rgb = col * (0.78 + 0.44 * nC.r);
    `,
    normal: /* glsl */ `
      tN = normalize(tN + vec3(nC.g - 0.5, 0.0, nC.b - 0.5) * 0.5 + vec3(nB.g - 0.5, 0.0, nB.b - 0.5) * 0.35);
      normal = normalize(mat3(viewMatrix) * tN);
    `,
  });

const waterMaterial = (shared, time) =>
  inject(new THREE.MeshStandardMaterial({ roughness: 0.1, metalness: 0 }), { ...shared, uTime: time }, {
    pars: 'uniform float uTime;',
    vertex: /* glsl */ `
      vec3 transformed = vec3(position);
      vXZ = (modelMatrix * vec4(position, 1.0)).xz;
    `,
    // 水色随水深由浅滩的青绿过渡到深蓝，岸边加浪花
    color: /* glsl */ `
      float depth = -terrainH(vXZ);
      vec3 wcol = mix(vec3(0.03, 0.20, 0.19), vec3(0.004, 0.028, 0.06), smoothstep(0.0, 22.0, depth));
      float foam = smoothstep(0.9, 0.1, depth) * smoothstep(0.35, 0.6, texture2D(uNoise, vXZ / 14.0 + uTime * 0.02).r);
      diffuseColor.rgb = mix(wcol, vec3(0.8), foam);
    `,
    // 三层不同尺度、不同方向流动的波纹法线叠加
    normal: /* glsl */ `
      vec2 w1 = texture2D(uNoise, vXZ / 97.0 + uTime * vec2(0.012, 0.007)).gb - 0.5;
      vec2 w2 = texture2D(uNoise, vXZ / 13.0 - uTime * vec2(0.03, 0.045)).gb - 0.5;
      vec2 w3 = texture2D(uNoise, vXZ / 700.0 + uTime * vec2(0.004, -0.003)).gb - 0.5;
      vec2 w = w1 + w2 * 0.6 + w3 * 0.5;
      normal = normalize(mat3(viewMatrix) * normalize(vec3(w.x, 2.5, w.y)));
    `,
  });

export class Terrain {
  constructor(scene) {
    this.data = generate();
    const heightMap = new THREE.DataTexture(this.data, RES, RES, THREE.RedFormat, THREE.FloatType);
    heightMap.minFilter = THREE.LinearMipmapLinearFilter;
    heightMap.magFilter = THREE.LinearFilter;
    heightMap.generateMipmaps = true;
    heightMap.needsUpdate = true;
    const shared = {
      uHeightMap: { value: heightMap },
      uNoise: { value: noiseTexture() },
      uWorld: { value: new THREE.Vector4(CX, CZ, WORLD, TEXEL) },
    };

    // 以相机为中心的 8 级同心网格，格距逐级翻倍（8 m … 1 km）
    const grid = gridGeometry();
    this.levels = Array.from({ length: LEVELS }, (_, l) => {
      const hole = new THREE.Vector3(0, 0, -1);
      const mesh = new THREE.Mesh(grid, terrainMaterial(shared, { value: hole }));
      mesh.scale.set(BASE_CELL << l, 1, BASE_CELL << l);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.userData.hole = hole;
      scene.add(mesh);
      return mesh;
    });

    this.time = { value: 0 };
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(4e5, 4e5).rotateX(-Math.PI / 2), waterMaterial(shared, this.time));
    this.water.frustumCulled = false;
    this.water.receiveShadow = true;
    scene.add(this.water);
  }

  update(cam, dt) {
    this.time.value += dt;
    this.water.position.set(cam.x, 0, cam.z);
    this.levels.forEach((mesh, l) => {
      const snap = (BASE_CELL << l) * 2; // 每级按两倍格距对齐，保证与上一级格点重合
      mesh.position.set(Math.round(cam.x / snap) * snap, 0, Math.round(cam.z / snap) * snap);
      if (l > 0) {
        const fine = this.levels[l - 1];
        mesh.userData.hole.set(fine.position.x, fine.position.z, (N / 2 - 1) * (BASE_CELL << (l - 1)));
      }
    });
  }

  // 地形海拔（双线性插值，与 GPU 采样一致）；x 东、z 南
  height(x, z) {
    const u = ((x - CX) / WORLD + 0.5) * RES - 0.5, v = ((z - CZ) / WORLD + 0.5) * RES - 0.5;
    const i = Math.floor(u), j = Math.floor(v);
    if (i < 0 || j < 0 || i >= RES - 1 || j >= RES - 1) return -50;
    const fu = u - i, fv = v - j, d = this.data, k = j * RES + i;
    return (d[k] * (1 - fu) + d[k + 1] * fu) * (1 - fv) + (d[k + RES] * (1 - fu) + d[k + RES + 1] * fu) * fv;
  }
}
