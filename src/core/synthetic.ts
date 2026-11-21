/** 合成测试场景:已知尺寸的车辆、已知长度的刹车印、路面、散落物、拖影。
 *  全部确定性生成,用于测量精度验证(误差 < 0.1%)和演示。 */

import { PointCloud, makeCloud } from './types';
import { Vec3 } from './math3';

export interface SyntheticScene {
  cloud: PointCloud;
  /** 真值,供测试断言 */
  truth: {
    vehicles: { length: number; width: number; height: number; center: Vec3 }[];
    skidStart: Vec3;
    skidEnd: Vec3;
    skidLength: number;
    targets: Vec3[];
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export function generateScene(seed = 7, roadStep = 0.05): SyntheticScene {
  const rand = rng(seed);
  const pos: number[] = [];
  const col: number[] = [];
  const inten: number[] = [];
  const nrm: number[] = [];

  const push = (x: number, y: number, z: number, r: number, g: number, b: number, i: number, nx = 0, ny = 0, nz = 1) => {
    pos.push(x, y, z);
    col.push(r, g, b);
    inten.push(i);
    nrm.push(nx, ny, nz);
  };

  // ---- 路面:60m x 20m,噪声 ±1mm ----
  const roadLen = 60, roadWid = 20, step = roadStep;
  for (let x = -roadLen / 2; x < roadLen / 2; x += step) {
    for (let y = -roadWid / 2; y < roadWid / 2; y += step) {
      const z = (rand() - 0.5) * 0.002;
      const shade = 70 + rand() * 20;
      push(x, y, z, shade, shade, shade, 0.45 + rand() * 0.1);
    }
  }

  // ---- 车辆:长方体,已知尺寸(轿车 4.8x1.8x1.45,SUV 5.0x1.95x1.7)----
  const vehicles = [
    { length: 4.8, width: 1.8, height: 1.45, center: [5, 2, 0] as Vec3 },
    { length: 5.0, width: 1.95, height: 1.7, center: [-8, -3, 0] as Vec3 },
  ];
  for (const v of vehicles) {
    const [cx, cy, cz] = v.center;
    const s = 0.02;
    // 顶面
    for (let x = -v.length / 2; x < v.length / 2; x += s)
      for (let y = -v.width / 2; y < v.width / 2; y += s)
        push(cx + x, cy + y, cz + v.height + (rand() - 0.5) * 0.001, 150, 40, 40, 0.7);
    // 侧面
    for (let x = -v.length / 2; x < v.length / 2; x += s)
      for (let z = 0; z < v.height; z += s) {
        push(cx + x, cy - v.width / 2, cz + z, 140, 35, 35, 0.65, 0, -1, 0);
        push(cx + x, cy + v.width / 2, cz + z, 140, 35, 35, 0.65, 0, 1, 0);
      }
    // 前后端面
    for (let y = -v.width / 2; y < v.width / 2; y += s)
      for (let z = 0; z < v.height; z += s) {
        push(cx - v.length / 2, cy + y, cz + z, 145, 38, 38, 0.66, -1, 0, 0);
        push(cx + v.length / 2, cy + y, cz + z, 145, 38, 38, 0.66, 1, 0, 0);
      }
  }

  // ---- 刹车印:已知长度 23.5m,宽 0.18m,深色低反射 ----
  const skidLength = 23.5;
  const skidStart: Vec3 = [-15, 1.2, 0.001];
  const skidEnd: Vec3 = [skidStart[0] + skidLength, skidStart[1], 0.001];
  for (let t = 0; t <= skidLength; t += 0.01) {
    for (let w = -0.09; w <= 0.09; w += 0.015) {
      push(
        skidStart[0] + t + (rand() - 0.5) * 0.004,
        skidStart[1] + w + (rand() - 0.5) * 0.004,
        0.001 + (rand() - 0.5) * 0.0005,
        25, 25, 28, 0.08 + rand() * 0.03,
      );
    }
  }

  // ---- 散落物:碎片带 ----
  for (let i = 0; i < 3000; i++) {
    const x = 8 + rand() * 4, y = 1 + rand() * 3;
    push(x, y, rand() * 0.05, 200, 180, 120, 0.8);
  }

  // ---- 拖影:围观人群(移动行人,稀疏竖条)----
  for (let p = 0; p < 6; p++) {
    const bx = 12 + p * 1.5, by = 6 + (p % 3);
    for (let i = 0; i < 60; i++) {
      push(
        bx + (rand() - 0.5) * 0.6,
        by + (rand() - 0.5) * 0.6,
        0.3 + rand() * 1.4,
        90, 90, 110, 0.3,
      );
    }
  }

  // ---- 靶球:4 个已知坐标(拼接验证用)----
  const targets: Vec3[] = [
    [-20, -8, 0.5], [20, -8, 0.5], [20, 8, 0.5], [-20, 8, 0.5],
  ];
  for (const t of targets) {
    for (let i = 0; i < 500; i++) {
      // 球面点,半径 0.0725m(标准靶球)
      const th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1);
      const r = 0.0725;
      push(
        t[0] + r * Math.sin(ph) * Math.cos(th),
        t[1] + r * Math.sin(ph) * Math.sin(th),
        t[2] + r * Math.cos(ph),
        240, 240, 240, 0.95,
      );
    }
  }

  const n = pos.length / 3;
  const cloud = makeCloud(
    n,
    Float32Array.from(pos),
    Uint8Array.from(col),
    Float32Array.from(inten),
    Float32Array.from(nrm),
  );
  return { cloud, truth: { vehicles, skidStart, skidEnd, skidLength, targets } };
}

/** 把场景复制一份并施加已知刚体变换(多站拼接测试用) */
export function transformCloud(src: PointCloud, yawDeg: number, tx: number, ty: number, tz: number): PointCloud {
  const c = Math.cos((yawDeg * Math.PI) / 180), s = Math.sin((yawDeg * Math.PI) / 180);
  const out = new Float32Array(src.count * 3);
  for (let i = 0; i < src.count; i++) {
    const x = src.positions[i * 3]!, y = src.positions[i * 3 + 1]!, z = src.positions[i * 3 + 2]!;
    out[i * 3] = c * x - s * y + tx;
    out[i * 3 + 1] = s * x + c * y + ty;
    out[i * 3 + 2] = z + tz;
  }
  return makeCloud(
    src.count, out,
    src.colors ? Uint8Array.from(src.colors) : null,
    src.intensities ? Float32Array.from(src.intensities) : null,
    src.normals ? Float32Array.from(src.normals) : null,
  );
}
