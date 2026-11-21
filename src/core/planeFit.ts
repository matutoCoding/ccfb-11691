/** 路面平面拟合:RANSAC + 最小二乘精化。 */

import { PointCloud } from './types';
import { Vec3, v3 } from './math3';

export interface PlaneFit {
  /** 单位法线 */
  normal: Vec3;
  /** 平面上一点 */
  point: Vec3;
  /** 内点比例 */
  inlierRatio: number;
  /** 内点阈值(米) */
  threshold: number;
}

/** 确定性伪随机(可复现) */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export function fitPlaneRansac(
  cloud: PointCloud,
  iterations = 400,
  threshold = 0.03,
  seed = 42,
): PlaneFit | null {
  const { positions, count } = cloud;
  if (count < 3) return null;
  const rng = makeRng(seed);

  let bestInliers = 0;
  let bestN: Vec3 = [0, 0, 1];
  let bestP: Vec3 = [0, 0, 0];

  const pAt = (i: number): Vec3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];

  for (let it = 0; it < iterations; it++) {
    const a = pAt((rng() * count) | 0);
    const b = pAt((rng() * count) | 0);
    const c = pAt((rng() * count) | 0);
    const n = v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));
    if (!isFinite(n[0]) || (n[0] === 0 && n[1] === 0 && n[2] === 0)) continue;
    let inl = 0;
    for (let i = 0; i < count; i++) {
      const d = Math.abs(
        (positions[i * 3]! - a[0]) * n[0] +
        (positions[i * 3 + 1]! - a[1]) * n[1] +
        (positions[i * 3 + 2]! - a[2]) * n[2]);
      if (d < threshold) inl++;
    }
    if (inl > bestInliers) { bestInliers = inl; bestN = n; bestP = a; }
  }
  if (bestInliers < 3) return null;

  // 最小二乘精化:对内点做质心 + 协方差最小特征向量(用幂迭代求最小特征值:对 (λmax I - C) 求最大)
  let cx = 0, cy = 0, cz = 0;
  const idx: number[] = [];
  for (let i = 0; i < count; i++) {
    const d = Math.abs(
      (positions[i * 3]! - bestP[0]) * bestN[0] +
      (positions[i * 3 + 1]! - bestP[1]) * bestN[1] +
      (positions[i * 3 + 2]! - bestP[2]) * bestN[2]);
    if (d < threshold) { idx.push(i); cx += positions[i * 3]!; cy += positions[i * 3 + 1]!; cz += positions[i * 3 + 2]!; }
  }
  cx /= idx.length; cy /= idx.length; cz /= idx.length;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const i of idx) {
    const dx = positions[i * 3]! - cx, dy = positions[i * 3 + 1]! - cy, dz = positions[i * 3 + 2]! - cz;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const C = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]];
  // 最小特征向量:对 (tI - C) 幂迭代,t = 迹
  const tr = xx + yy + zz;
  const M = [
    [tr - C[0]![0]!, -C[0]![1]!, -C[0]![2]!],
    [-C[1]![0]!, tr - C[1]![1]!, -C[1]![2]!],
    [-C[2]![0]!, -C[2]![1]!, tr - C[2]![2]!],
  ];
  let v: Vec3 = [bestN[0], bestN[1], bestN[2]];
  for (let it = 0; it < 100; it++) {
    const nv: Vec3 = [
      M[0]![0]! * v[0] + M[0]![1]! * v[1] + M[0]![2]! * v[2],
      M[1]![0]! * v[0] + M[1]![1]! * v[1] + M[1]![2]! * v[2],
      M[2]![0]! * v[0] + M[2]![1]! * v[1] + M[2]![2]! * v[2],
    ];
    const l = Math.hypot(...nv);
    if (l < 1e-15) break;
    v = [nv[0] / l, nv[1] / l, nv[2] / l];
  }
  // 法线朝上(假设现场 z 向上)
  if (v[2] < 0) v = [-v[0], -v[1], -v[2]];

  return { normal: v, point: [cx, cy, cz], inlierRatio: idx.length / count, threshold };
}
