/** 清理与数据结构测试:八叉树、离群点、体素降采样、拖影识别、隔离层还原 */

import { describe, it, expect } from 'vitest';
import { generateScene } from '../src/core/synthetic';
import { buildOctree, collectVisibleNodes } from '../src/core/octree';
import { statisticalOutliers, voxelDownsample, detectGhosts, applyToIsolation, restore, visibleCount } from '../src/core/filters';
import { fitPlaneRansac } from '../src/core/planeFit';
import { makeCloud } from '../src/core/types';

describe('八叉树 LOD', () => {
  const scene = generateScene(11, 0.2);
  const oct = buildOctree(scene.cloud);

  it('所有点都被分层保留(代表点合计 = 总点数)', () => {
    let sum = 0;
    const walk = (n: typeof oct.root) => {
      sum += n.indices.length;
      for (const c of n.children) if (c) walk(c);
    };
    walk(oct.root);
    expect(sum).toBe(scene.cloud.count);
  });

  it('远处只取粗层,近处取细层', () => {
    const always = () => true;
    const far = collectVisibleNodes(oct, [0, 0, 500], always, 800, 1.5, 10_000_000);
    const near = collectVisibleNodes(oct, [0, 0, 2], always, 800, 1.5, 10_000_000);
    const count = (ns: typeof far) => ns.reduce((s, n) => s + n.indices.length, 0);
    expect(count(near)).toBeGreaterThan(count(far));
  });
});

describe('统计离群点去除', () => {
  it('明显离群点被标出,主体保留', () => {
    // 100x100 网格 + 5 个飞到远处的点
    const pts: number[] = [];
    for (let x = 0; x < 10; x += 0.1) for (let y = 0; y < 10; y += 0.1) pts.push(x, y, 0);
    const base = pts.length / 3;
    pts.push(50, 50, 50, -50, 0, 30, 0, 80, -40, 25, 25, 60, -30, -30, -30);
    const cloud = makeCloud(pts.length / 3, Float32Array.from(pts));
    const res = statisticalOutliers(cloud, 8, 2.0);
    let flagged = 0;
    for (let i = base; i < cloud.count; i++) flagged += res.outliers[i]!;
    expect(flagged).toBe(5); // 5 个远点全部识别
    let baseFlagged = 0;
    for (let i = 0; i < base; i++) baseFlagged += res.outliers[i]!;
    // 有限网格的边缘点 k 近邻天然更远,SOR 会误标一部分(PCL 同样如此),允许 < 5%
    expect(baseFlagged / base).toBeLessThan(0.05);
  });
});

describe('体素降采样', () => {
  it('降采样后点数显著减少且不超原始', () => {
    const scene = generateScene(13, 0.1);
    const keep = voxelDownsample(scene.cloud, 0.1);
    expect(keep.length).toBeLessThan(scene.cloud.count);
    expect(keep.length).toBeGreaterThan(0);
  });
});

describe('拖影识别', () => {
  it('合成场景中的围观人群被识别,路面不误判', () => {
    const scene = generateScene(17, 0.1);
    const plane = fitPlaneRansac(scene.cloud, 400, 0.03)!;
    expect(plane).not.toBeNull();
    expect(plane.normal[2]).toBeGreaterThan(0.9); // 路面法线朝上

    const ghost = detectGhosts(scene.cloud, plane, 0.15, 0.35);
    let ghostN = 0;
    for (const g of ghost) ghostN += g;
    // 6 个人形拖影共 360 点,应识别出相当部分
    expect(ghostN).toBeGreaterThan(50);
    // 路面点(占绝大多数)不应大量误判
    expect(ghostN).toBeLessThan(scene.cloud.count * 0.05);
  });
});

describe('隔离层(原始数据不动)', () => {
  it('隔离后还原,坐标不变', () => {
    const scene = generateScene(19, 0.2);
    const before = Float32Array.from(scene.cloud.positions);
    const mask = new Uint8Array(scene.cloud.count);
    for (let i = 0; i < 100; i++) mask[i] = 1;
    applyToIsolation(scene.cloud, mask);
    expect(visibleCount(scene.cloud)).toBe(scene.cloud.count - 100);
    restore(scene.cloud);
    expect(visibleCount(scene.cloud)).toBe(scene.cloud.count);
    expect(Array.from(scene.cloud.positions.slice(0, 30))).toEqual(Array.from(before.slice(0, 30)));
  });
});
