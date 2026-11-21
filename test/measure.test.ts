/** 测量精度测试 —— 系统核心指标:已知尺寸合成场景上误差 < 0.1% */

import { describe, it, expect } from 'vitest';
import { generateScene } from '../src/core/synthetic';
import { distance, angleAt, polylineLength, estimateSpeed } from '../src/core/measure';
import { buildOctree, pickPoint } from '../src/core/octree';
import { Vec3 } from '../src/core/math3';

const TOL = 0.001; // 0.1%

describe('测量公式', () => {
  it('距离/角度/折线长', () => {
    expect(distance([0, 0, 0], [3, 4, 0])).toBeCloseTo(5, 10);
    expect(angleAt([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(90, 6);
    expect(polylineLength([[0, 0, 0], [3, 4, 0], [3, 4, 12]])).toBeCloseTo(17, 10);
  });

  it('车速估算 v=√(254·f·s)', () => {
    // f=0.75, s=30m → v≈75.5 km/h
    expect(estimateSpeed(30, 0.75)).toBeCloseTo(Math.sqrt(254 * 0.75 * 30), 10);
    expect(estimateSpeed(30, 0.75)).toBeCloseTo(75.5, 0);
  });
});

describe('合成场景测量精度(误差 < 0.1%)', () => {
  const scene = generateScene(7, 0.05);
  const oct = buildOctree(scene.cloud);

  /** 模拟拾取:从 (x,y) 正上方垂直向下拾取最近点 */
  function pickFromTop(x: number, y: number): Vec3 {
    const idx = pickPoint(oct, [x, y, 50], [0, 0, -1], 0.02);
    expect(idx).toBeGreaterThanOrEqual(0);
    return [
      scene.cloud.positions[idx * 3]!,
      scene.cloud.positions[idx * 3 + 1]!,
      scene.cloud.positions[idx * 3 + 2]!,
    ];
  }

  it('刹车印长度 23.5m', () => {
    const { skidStart, skidEnd, skidLength } = scene.truth;
    const a = pickFromTop(skidStart[0], skidStart[1]);
    const b = pickFromTop(skidEnd[0], skidEnd[1]);
    const measured = distance(a, b);
    const err = Math.abs(measured - skidLength) / skidLength;
    expect(err).toBeLessThan(TOL);
  });

  it('车辆长度 4.8m(面拟合法)', () => {
    const v = scene.truth.vehicles[0]!;
    const [cx, cy] = [v.center[0], v.center[1]];
    // 前后面拟合:取端面附近点,平均 x(面与 x 轴垂直)
    const faceX = (targetX: number) => {
      let sum = 0, n = 0;
      const p = scene.cloud.positions;
      for (let i = 0; i < scene.cloud.count; i++) {
        const x = p[i * 3]!, y = p[i * 3 + 1]!;
        if (Math.abs(x - targetX) < 0.03 && Math.abs(y - cy) < v.width / 2 - 0.05) {
          sum += x; n++;
        }
      }
      expect(n).toBeGreaterThan(10);
      return sum / n;
    };
    const front = faceX(cx + v.length / 2);
    const rear = faceX(cx - v.length / 2);
    const measured = front - rear;
    const err = Math.abs(measured - v.length) / v.length;
    expect(err).toBeLessThan(TOL);
  });

  it('两车间距(车中心到车中心)', () => {
    const [v0, v1] = scene.truth.vehicles;
    const expected = Math.hypot(v0!.center[0] - v1!.center[0], v0!.center[1] - v1!.center[1]);
    // 从车顶中心拾取
    const a = pickFromTop(v0!.center[0], v0!.center[1]);
    const b = pickFromTop(v1!.center[0], v1!.center[1]);
    const measured = distance(a, b);
    const err = Math.abs(measured - expected) / expected;
    expect(err).toBeLessThan(TOL);
  });

  it('靶球间距 40m(跨场景长基线)', () => {
    const t = scene.truth.targets; // [-20,-8] [20,-8] [20,8] [-20,8]
    const a = pickFromTop(t[0]![0], t[0]![1]);
    const b = pickFromTop(t[1]![0], t[1]![1]);
    const expected = 40;
    const err = Math.abs(distance(a, b) - expected) / expected;
    expect(err).toBeLessThan(TOL);
  });
});
