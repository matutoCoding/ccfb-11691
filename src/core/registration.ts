/** 多站拼接:3 对以上公共靶球点,Horn 四元数法求最优刚体变换,输出逐点残差与 RMS。 */

import { Vec3, v3, mat4FromQuatTrans, Mat4 } from './math3';

export interface RegistrationResult {
  transform: Mat4;
  residuals: number[]; // 每对点的残差(米)
  rms: number;
}

/** 对称 4x4 矩阵最大特征值对应特征向量(循环 Jacobi 法,对 ±λ 简并稳健) */
function largestEigenvector(mat: number[][]): [number, number, number, number] {
  const a = mat.map((r) => [...r]);
  let v: number[][] = [
    [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
  ];
  for (let sweep = 0; sweep < 64; sweep++) {
    // 找最大非对角元
    let p = 0, q = 1, max = 0;
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++)
        if (Math.abs(a[i]![j]!) > max) { max = Math.abs(a[i]![j]!); p = i; q = j; }
    if (max < 1e-14) break;
    // Jacobi 旋转:A ← JᵀAJ,V ← VJ,消去 (p,q) 元
    const app = a[p]![p]!, aqq = a[q]![q]!, apq = a[p]![q]!;
    const theta = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(theta), s = Math.sin(theta);
    for (let k = 0; k < 4; k++) {
      const akp = a[k]![p]!, akq = a[k]![q]!;
      a[k]![p] = c * akp - s * akq;
      a[k]![q] = s * akp + c * akq;
    }
    for (let k = 0; k < 4; k++) {
      const apk = a[p]![k]!, aqk = a[q]![k]!;
      a[p]![k] = c * apk - s * aqk;
      a[q]![k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 4; k++) {
      const vkp = v[k]![p]!, vkq = v[k]![q]!;
      v[k]![p] = c * vkp - s * vkq;
      v[k]![q] = s * vkp + c * vkq;
    }
  }
  // 最大特征值所在列
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i]![i]! > a[best]![best]!) best = i;
  return [v[0]![best]!, v[1]![best]!, v[2]![best]!, v[3]![best]!];
}

/**
 * 把 src 点集配准到 dst 点集(对应下标一一配对,至少 3 对)。
 * 返回把 src 变换到 dst 坐标系的 4x4。
 */
export function registerPointPairs(src: Vec3[], dst: Vec3[]): RegistrationResult {
  if (src.length !== dst.length) throw new Error('对应点数量不一致');
  if (src.length < 3) throw new Error('至少需要 3 对公共靶球点才能拼接');

  const n = src.length;
  const cs: Vec3 = [0, 0, 0], cd: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    cs[0] += src[i]![0]; cs[1] += src[i]![1]; cs[2] += src[i]![2];
    cd[0] += dst[i]![0]; cd[1] += dst[i]![1]; cd[2] += dst[i]![2];
  }
  cs[0] /= n; cs[1] /= n; cs[2] /= n;
  cd[0] /= n; cd[1] /= n; cd[2] /= n;

  // 协方差矩阵 S = Σ (src-cs)(dst-cd)^T(Horn 约定:特征向量给出 src→dst 的旋转)
  const S = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let i = 0; i < n; i++) {
    const a = v3.sub(src[i]!, cs);
    const b = v3.sub(dst[i]!, cd);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r]![c]! += a[r]! * b[c]!;
  }

  // Horn:N 矩阵(4x4 对称),最大特征向量即最优旋转四元数(w,x,y,z)
  const N = [
    [S[0]![0]! + S[1]![1]! + S[2]![2]!, S[1]![2]! - S[2]![1]!, S[2]![0]! - S[0]![2]!, S[0]![1]! - S[1]![0]!],
    [S[1]![2]! - S[2]![1]!, S[0]![0]! - S[1]![1]! - S[2]![2]!, S[0]![1]! + S[1]![0]!, S[0]![2]! + S[2]![0]!],
    [S[2]![0]! - S[0]![2]!, S[0]![1]! + S[1]![0]!, -S[0]![0]! + S[1]![1]! - S[2]![2]!, S[1]![2]! + S[2]![1]!],
    [S[0]![1]! - S[1]![0]!, S[0]![2]! + S[2]![0]!, S[1]![2]! + S[2]![1]!, -S[0]![0]! - S[1]![1]! + S[2]![2]!],
  ];
  const [w, x, y, z] = largestEigenvector(N);

  // 旋转矩阵(行主序 3x3)
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  // t = cd - R*cs
  const t: Vec3 = [
    cd[0] - (R[0]![0]! * cs[0] + R[0]![1]! * cs[1] + R[0]![2]! * cs[2]),
    cd[1] - (R[1]![0]! * cs[0] + R[1]![1]! * cs[1] + R[1]![2]! * cs[2]),
    cd[2] - (R[2]![0]! * cs[0] + R[2]![1]! * cs[1] + R[2]![2]! * cs[2]),
  ];

  const transform = mat4FromQuatTrans([x, y, z, w], t);

  const residuals: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p = src[i]!;
    const q: Vec3 = [
      R[0]![0]! * p[0] + R[0]![1]! * p[1] + R[0]![2]! * p[2] + t[0],
      R[1]![0]! * p[0] + R[1]![1]! * p[1] + R[1]![2]! * p[2] + t[1],
      R[2]![0]! * p[0] + R[2]![1]! * p[1] + R[2]![2]! * p[2] + t[2],
    ];
    const r = v3.dist(q, dst[i]!);
    residuals.push(r);
    sum += r * r;
  }
  return { transform, residuals, rms: Math.sqrt(sum / n) };
}
