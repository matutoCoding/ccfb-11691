/** 点云清理:统计离群点去除、体素降采样、拖影(围观人群/过往车辆)识别、隔离层操作。
 *  全部基于 flags 标记,不改动原始坐标 —— 原始扫描作为证据一个点都不改。 */

import { PointCloud } from './types';
import { PlaneFit } from './planeFit';

/** 均匀网格空间哈希,供邻域查询 */
export class SpatialHash {
  private cells = new Map<string, number[]>();
  constructor(
    public positions: Float32Array,
    public count: number,
    public cellSize: number,
  ) {
    for (let i = 0; i < count; i++) {
      const k = this.key(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
      let arr = this.cells.get(k);
      if (!arr) this.cells.set(k, (arr = []));
      arr.push(i);
    }
  }
  private key(x: number, y: number, z: number) {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)},${Math.floor(z / this.cellSize)}`;
  }
  /** 访问 (x,y,z) 周围 27 邻域内的点 */
  forEachNeighbor(x: number, y: number, z: number, cb: (i: number) => void) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const arr = this.cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (arr) for (const i of arr) cb(i);
        }
  }
}

export interface SorResult {
  /** 每个点的平均邻域距离是否超限,true=离群 */
  outliers: Uint8Array;
  meanOfMeans: number;
  threshold: number;
}

/** 统计离群点去除(PCL SOR 同款):k 近邻平均距离 > 全局均值+stdRatio*σ 判为离群 */
export function statisticalOutliers(
  cloud: PointCloud,
  neighbors: number,
  stdRatio: number,
  onProgress?: (frac: number) => void,
): SorResult {
  const { positions, count } = cloud;
  // 估计典型间距定网格尺寸
  const diag = bboxDiag(positions, count);
  const cell = Math.max(diag / Math.cbrt(count) * 2, 1e-4);
  const hash = new SpatialHash(positions, count, cell);

  const means = new Float32Array(count);
  let sum = 0;
  const cand: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
    cand.length = 0;
    hash.forEachNeighbor(x, y, z, (j) => {
      if (j === i) return;
      const dx = positions[j * 3]! - x, dy = positions[j * 3 + 1]! - y, dz = positions[j * 3 + 2]! - z;
      cand.push(dx * dx + dy * dy + dz * dz);
    });
    cand.sort((a, b) => a - b);
    const k = Math.min(neighbors, cand.length);
    let m = 0;
    for (let t = 0; t < k; t++) m += Math.sqrt(cand[t]!);
    means[i] = k > 0 ? m / k : Infinity;
    if (k > 0) sum += means[i];
    if (onProgress && (i & 0xffff) === 0) onProgress(i / count);
  }
  const valid = count; // Infinity 的孤立点直接判离群
  const mean = sum / valid;
  let varSum = 0;
  for (let i = 0; i < count; i++) if (isFinite(means[i])) varSum += (means[i] - mean) ** 2;
  const std = Math.sqrt(varSum / valid);
  const threshold = mean + stdRatio * std;

  const outliers = new Uint8Array(count);
  for (let i = 0; i < count; i++) outliers[i] = means[i] > threshold ? 1 : 0;
  return { outliers, meanOfMeans: mean, threshold };
}

/** 体素降采样:返回保留点的下标(每体素取最靠近质心的点) */
export function voxelDownsample(cloud: PointCloud, voxel: number): Uint32Array {
  const { positions, count } = cloud;
  if (voxel <= 0) {
    const all = new Uint32Array(count);
    for (let i = 0; i < count; i++) all[i] = i;
    return all;
  }
  interface Acc { sx: number; sy: number; sz: number; n: number; best: number; bestD: number }
  const voxels = new Map<string, Acc>();
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
    const k = `${Math.floor(x / voxel)},${Math.floor(y / voxel)},${Math.floor(z / voxel)}`;
    let a = voxels.get(k);
    if (!a) voxels.set(k, (a = { sx: 0, sy: 0, sz: 0, n: 0, best: -1, bestD: Infinity }));
    a.sx += x; a.sy += y; a.sz += z; a.n++;
  }
  // 第二遍:找最靠近质心的点
  for (const [k, a] of voxels) {
    const cx = a.sx / a.n, cy = a.sy / a.n, cz = a.sz / a.n;
    a.sx = cx; a.sy = cy; a.sz = cz; // 复用字段存质心
  }
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
    const k = `${Math.floor(x / voxel)},${Math.floor(y / voxel)},${Math.floor(z / voxel)}`;
    const a = voxels.get(k)!;
    const d = (x - a.sx) ** 2 + (y - a.sy) ** 2 + (z - a.sz) ** 2;
    if (d < a.bestD) { a.bestD = d; a.best = i; }
  }
  const keep = new Uint32Array(voxels.size);
  let o = 0;
  for (const a of voxels.values()) keep[o++] = a.best;
  return keep;
}

/**
 * 拖影识别:围观人群、过往车辆是移动目标,扫描出来是悬浮在路面上方、
 * 局部密度低的条带状点。判据:到路面平面距离 > ghostHeight 且局部密度 < 阈值。
 * 返回标记数组(1=拖影候选)。
 */
export function detectGhosts(
  cloud: PointCloud,
  plane: PlaneFit,
  heightAbove: number,
  densityRatio: number,
): Uint8Array {
  const { positions, count } = cloud;
  const { normal, point } = plane;
  const diag = bboxDiag(positions, count);
  const cell = Math.max(diag / Math.cbrt(count) * 2, 1e-4);
  const hash = new SpatialHash(positions, count, cell);

  // 先统计全局平均邻居数作密度基准
  const neighCount = new Float32Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
    let c = 0;
    hash.forEachNeighbor(x, y, z, () => c++);
    neighCount[i] = c;
    total += c;
  }
  const avg = total / count;
  const densityThresh = avg * densityRatio;

  const ghost = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const h =
      (positions[i * 3]! - point[0]) * normal[0] +
      (positions[i * 3 + 1]! - point[1]) * normal[1] +
      (positions[i * 3 + 2]! - point[2]) * normal[2];
    if (h > heightAbove && neighCount[i]! < densityThresh) ghost[i] = 1;
  }
  return ghost;
}

/** 把标记数组应用进隔离层(merge:与现有 flags 取并集) */
export function applyToIsolation(cloud: PointCloud, mask: Uint8Array) {
  for (let i = 0; i < cloud.count; i++) if (mask[i]) cloud.flags[i] = 1;
}

/** 还原:清空隔离层(可只还原 mask 命中的) */
export function restore(cloud: PointCloud, mask?: Uint8Array) {
  for (let i = 0; i < cloud.count; i++) {
    if (!mask || mask[i]) if (cloud.flags[i] === 1) cloud.flags[i] = 0;
  }
}

export function visibleCount(cloud: PointCloud): number {
  let n = 0;
  for (let i = 0; i < cloud.count; i++) if (cloud.flags[i] === 0) n++;
  return n;
}

function bboxDiag(positions: Float32Array, count: number): number {
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  return Math.hypot(mxx - mnx, mxy - mny, mxz - mnz) || 1;
}
