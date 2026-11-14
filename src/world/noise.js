import * as THREE from 'three';

const GX = [1, -1, 1, -1, 1, -1, 0, 0];
const GY = [1, 1, -1, -1, 0, 0, 1, -1];

// 带种子的 2D 梯度噪声，返回 { noise, fbm, ridged }，值域约 [-1, 1]
export function makeNoise(seed = 1) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const dot = (h, x, y) => GX[h & 7] * x + GY[h & 7] * y;

  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const a = perm[xi & 255] + (yi & 255), b = perm[(xi + 1) & 255] + (yi & 255);
    const u = fade(xf), v = fade(yf);
    const n0 = dot(perm[a], xf, yf), n1 = dot(perm[b], xf - 1, yf);
    const n2 = dot(perm[a + 1], xf, yf - 1), n3 = dot(perm[b + 1], xf - 1, yf - 1);
    const top = n0 + (n1 - n0) * u;
    return top + (n2 + (n3 - n2) * u - top) * v;
  };
  // 分形布朗运动
  const fbm = (x, y, octaves) => {
    let sum = 0, amp = 0.5;
    for (let i = 0; i < octaves; i++, x *= 2.03, y *= 2.03, amp *= 0.5) sum += amp * noise(x, y);
    return sum * 2;
  };
  // 山脊噪声，值域 [0, 1]
  const ridged = (x, y, octaves) => {
    let sum = 0, amp = 0.5, prev = 1;
    for (let i = 0; i < octaves; i++, x *= 2.03, y *= 2.03, amp *= 0.5) {
      const r = (1 - Math.abs(noise(x, y))) ** 2;
      sum += amp * r * prev;
      prev = r;
    }
    return sum;
  };
  return { noise, fbm, ridged };
}

// 可平铺的噪声纹理，供着色器做细节：R = 值，G/B = x/y 方向梯度，A = 另一份错位的值
export function noiseTexture(size = 256) {
  const val = new Float32Array(size * size);
  const smooth = (t) => t * t * (3 - 2 * t);
  let amp = 1, total = 0;
  for (let f = 4; f <= 64; f *= 2, amp *= 0.55) {
    const lattice = Float32Array.from({ length: f * f }, Math.random);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * f, gy = (y / size) * f;
        const x0 = gx | 0, y0 = gy | 0, x1 = (x0 + 1) % f, y1 = (y0 + 1) % f;
        const tx = smooth(gx - x0), ty = smooth(gy - y0);
        const a = lattice[y0 * f + x0], b = lattice[y0 * f + x1];
        const c = lattice[y1 * f + x0], d = lattice[y1 * f + x1];
        val[y * size + x] += amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty);
      }
    }
    total += amp;
  }
  const at = (x, y) => val[((y + size) % size) * size + ((x + size) % size)] / total;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = at(x, y) * 255;
      data[i + 1] = Math.min(255, Math.max(0, 128 + (at(x + 1, y) - at(x - 1, y)) * 900));
      data[i + 2] = Math.min(255, Math.max(0, 128 + (at(x, y + 1) - at(x, y - 1)) * 900));
      data[i + 3] = at(x + 101, y + 57) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
