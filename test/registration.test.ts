/** 多站拼接测试:已知刚体变换下残差应≈0,变换后的靶球应回到基准位置 */

import { describe, it, expect } from 'vitest';
import { registerPointPairs } from '../src/core/registration';
import { generateScene } from '../src/core/synthetic';
import { mat4Transform, Vec3 } from '../src/core/math3';

describe('靶球拼接', () => {
  it('已知变换下残差 < 1mm,且恢复变换正确', () => {
    const scene = generateScene(7, 0.1);
    const targets = scene.truth.targets;

    // 模拟第二站:把基准坐标系的靶球位置施加已知刚体变换(扫描仪在另一处)
    const yaw = (35 * Math.PI) / 180;
    const t: Vec3 = [3.2, -1.7, 0.4];
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const station2Targets = targets.map((p): Vec3 => [
      c * p[0] - s * p[1] + t[0],
      s * p[0] + c * p[1] + t[1],
      p[2] + t[2],
    ]);

    // 拼接:把站2 配准回基准站
    const res = registerPointPairs(station2Targets, targets);
    expect(res.rms).toBeLessThan(1e-6);
    for (const r of res.residuals) expect(r).toBeLessThan(1e-6);

    // 验证恢复出的变换确实把站2点送回基准位置
    for (let i = 0; i < targets.length; i++) {
      const [x, y, z] = mat4Transform(res.transform, station2Targets[i]!);
      expect(Math.hypot(x - targets[i]![0], y - targets[i]![1], z - targets[i]![2])).toBeLessThan(1e-4);
    }
  });

  it('带噪声时残差反映噪声水平', () => {
    const base: Vec3[] = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [10, 10, 1]];
    // 每点不同的扰动(不可被刚体变换吸收)
    const noisy = base.map((p, i): Vec3 => [
      p[0] + 0.004 * (i % 2 === 0 ? 1 : -1),
      p[1] + 0.003 * (i < 2 ? 1 : -1),
      p[2] + 0.002 * (i === 1 ? -1 : 1),
    ]);
    const res = registerPointPairs(noisy, base);
    expect(res.rms).toBeGreaterThan(0.001);
    expect(res.rms).toBeLessThan(0.02);
  });

  it('少于 3 对点报错', () => {
    expect(() => registerPointPairs([[0, 0, 0], [1, 0, 0]], [[0, 0, 0], [1, 0, 0]])).toThrow(/3 对/);
  });
});
