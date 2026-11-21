/** 测量:两点距离、三点角度、曲线长度、制动前车速估算。 */

import { Vec3, v3 } from './math3';

export function distance(a: Vec3, b: Vec3): number {
  return v3.dist(a, b);
}

/** 三点测角:顶点在 b,返回角度(度) */
export function angleAt(a: Vec3, b: Vec3, c: Vec3): number {
  const u = v3.sub(a, b);
  const w = v3.sub(c, b);
  const cos = v3.dot(u, w) / (v3.len(u) * v3.len(w) || 1);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/** 折线长度(沿刹车印逐点拾取的曲线) */
export function polylineLength(points: Vec3[]): number {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += v3.dist(points[i]!, points[i - 1]!);
  return s;
}

/**
 * 制动前车速估算(沥青/混凝土路面,经典公式):
 *   v = sqrt(254 * (f ± i) * s)   [km/h]
 * f:附着系数,s:制动距离(米),i:道路纵坡(小数,上坡取正)。此处取 i=0。
 * 254 = 2*9.81*(3.6^2)/1000 的倒数形式系数。
 */
export function estimateSpeed(skidDistance: number, friction: number, grade = 0): number {
  const f = friction + grade;
  if (f <= 0 || skidDistance <= 0) return 0;
  return Math.sqrt(254 * f * skidDistance);
}

/** 投影到平面(用于把测量点压到拟合路面上,提高重复性) */
export function projectToPlane(p: Vec3, planePoint: Vec3, planeNormal: Vec3): Vec3 {
  const d = v3.dot(v3.sub(p, planePoint), planeNormal);
  return v3.sub(p, v3.scale(planeNormal, d));
}
