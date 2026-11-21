/** 八叉树 LOD:节点按层间距保留代表点,镜头拉近时逐级加载细节;
 *  同时提供射线最近点拾取(测量用)。 */

import { PointCloud } from './types';
import { Vec3 } from './math3';

export interface OctreeNode {
  min: Vec3;
  max: Vec3;
  depth: number;
  /** 本层代表点(全局点云下标) */
  indices: Uint32Array;
  /** 本层代表间距(米) */
  spacing: number;
  children: (OctreeNode | null)[];
  /** 节点包围球 */
  center: Vec3;
  radius: number;
}

export interface Octree {
  root: OctreeNode;
  cloud: PointCloud;
  maxDepth: number;
  totalPoints: number;
}

export function buildOctree(cloud: PointCloud, maxDepth = 10, baseSpacing?: number): Octree {
  const { positions, count } = cloud;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  // 立方化
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const rootSpacing = baseSpacing ?? size / 128;

  const build = (lo: Vec3, depth: number, idx: number[]): OctreeNode => {
    const spacing = rootSpacing / Math.pow(2, depth);
    const half = size / Math.pow(2, depth + 1);
    const nodeMin: Vec3 = [lo[0], lo[1], lo[2]];
    const nodeMax: Vec3 = [lo[0] + half * 2, lo[1] + half * 2, lo[2] + half * 2];

    // 网格采样:每个 spacing 格子保留第一个点,其余下放到子节点
    const grid = new Map<string, number>();
    const kept: number[] = [];
    const rest: number[] = [];
    const inv = 1 / spacing;
    for (const i of idx) {
      const k = `${Math.floor(positions[i * 3]! * inv)},${Math.floor(positions[i * 3 + 1]! * inv)},${Math.floor(positions[i * 3 + 2]! * inv)}`;
      if (!grid.has(k)) { grid.set(k, i); kept.push(i); }
      else rest.push(i);
    }

    const node: OctreeNode = {
      min: nodeMin,
      max: nodeMax,
      depth,
      indices: Uint32Array.from(kept),
      spacing,
      children: [],
      center: [(nodeMin[0] + nodeMax[0]) / 2, (nodeMin[1] + nodeMax[1]) / 2, (nodeMin[2] + nodeMax[2]) / 2],
      radius: Math.hypot(half, half, half),
    };

    if (depth < maxDepth && rest.length > 0) {
      const buckets: number[][] = Array.from({ length: 8 }, () => []);
      const mid = node.center;
      for (const i of rest) {
        const c =
          (positions[i * 3]! >= mid[0] ? 1 : 0) |
          (positions[i * 3 + 1]! >= mid[1] ? 2 : 0) |
          (positions[i * 3 + 2]! >= mid[2] ? 4 : 0);
        buckets[c]!.push(i);
      }
      for (let c = 0; c < 8; c++) {
        if (buckets[c]!.length === 0) { node.children.push(null); continue; }
        const childLo: Vec3 = [
          mid[0] - (c & 1 ? 0 : half),
          mid[1] - (c & 2 ? 0 : half),
          mid[2] - (c & 4 ? 0 : half),
        ];
        node.children.push(build(childLo, depth + 1, buckets[c]!));
      }
    }
    return node;
  };

  const allIdx = new Array<number>(count);
  for (let i = 0; i < count; i++) allIdx[i] = i;
  const root = build([min[0], min[1], min[2]], 0, allIdx);
  return { root, cloud, maxDepth, totalPoints: count };
}

/** 视锥 + 屏幕误差遍历:返回需要绘制的节点(父节点代表点 + 足够细的叶子) */
export function collectVisibleNodes(
  oct: Octree,
  /** 世界坐标相机位置 */
  eye: Vec3,
  /** 判断节点包围球是否在视锥内 */
  inFrustum: (center: Vec3, radius: number) => boolean,
  /** 投影系数: projFactor = viewportHeightPx / (2*tan(fov/2)),正射时为 viewportHeightPx / orthoHeight */
  projFactor: number,
  lodErrorPx: number,
  budget: number,
): OctreeNode[] {
  const out: OctreeNode[] = [];
  let used = 0;
  const stack: OctreeNode[] = [oct.root];
  while (stack.length) {
    const node = stack.pop()!;
    if (!inFrustum(node.center, node.radius)) continue;
    const dx = node.center[0] - eye[0], dy = node.center[1] - eye[1], dz = node.center[2] - eye[2];
    const dist = Math.max(Math.hypot(dx, dy, dz) - node.radius, 0.001);
    const errPx = (node.spacing * projFactor) / dist;
    const leaf = node.children.every((c) => c === null);
    out.push(node);
    used += node.indices.length;
    if (used > budget) break;
    if (!leaf && errPx > lodErrorPx) {
      for (const c of node.children) if (c) stack.push(c);
    }
  }
  return out;
}

/** 射线拾取:返回距射线最近且在屏幕容差内的点下标,-1 表示未命中 */
export function pickPoint(
  oct: Octree,
  rayOrigin: Vec3,
  rayDir: Vec3,
  maxPerpDist: number,
): number {
  const { positions } = oct.cloud;
  let best = -1;
  let bestT = Infinity;

  const visit = (node: OctreeNode) => {
    // 包围球与射线距离
    const cx = node.center[0] - rayOrigin[0];
    const cy = node.center[1] - rayOrigin[1];
    const cz = node.center[2] - rayOrigin[2];
    const t = cx * rayDir[0] + cy * rayDir[1] + cz * rayDir[2];
    if (t + node.radius < 0) return; // 在相机背后
    const px = cx - t * rayDir[0], py = cy - t * rayDir[1], pz = cz - t * rayDir[2];
    const perp = Math.hypot(px, py, pz);
    if (perp - node.radius > maxPerpDist) return;

    for (const i of node.indices) {
      const dx = positions[i * 3]! - rayOrigin[0];
      const dy = positions[i * 3 + 1]! - rayOrigin[1];
      const dz = positions[i * 3 + 2]! - rayOrigin[2];
      const ti = dx * rayDir[0] + dy * rayDir[1] + dz * rayDir[2];
      if (ti < 0) continue;
      const qx = dx - ti * rayDir[0], qy = dy - ti * rayDir[1], qz = dz - ti * rayDir[2];
      const d = Math.hypot(qx, qy, qz);
      if (d < maxPerpDist && ti < bestT) { bestT = ti; best = i; }
    }
    for (const c of node.children) if (c) visit(c);
  };
  visit(oct.root);
  return best;
}

/** 球范围内的点下标(框选/套索删点用,配合屏幕投影在 UI 层做) */
export function pointsInSphere(oct: Octree, center: Vec3, radius: number, out: number[]) {
  const { positions } = oct.cloud;
  const visit = (node: OctreeNode) => {
    const dx = Math.max(node.min[0] - center[0], 0, center[0] - node.max[0]);
    const dy = Math.max(node.min[1] - center[1], 0, center[1] - node.max[1]);
    const dz = Math.max(node.min[2] - center[2], 0, center[2] - node.max[2]);
    if (Math.hypot(dx, dy, dz) > radius) return;
    for (const i of node.indices) {
      const d = Math.hypot(
        positions[i * 3]! - center[0],
        positions[i * 3 + 1]! - center[1],
        positions[i * 3 + 2]! - center[2]);
      if (d <= radius) out.push(i);
    }
    for (const c of node.children) if (c) visit(c);
  };
  visit(oct.root);
}
