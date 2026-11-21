/** 轨道相机:旋转/平移/缩放,支持透视与正射俯视切换。 */

import { Vec3, v3, Mat4, mat4Perspective, mat4Ortho, mat4LookAt, mat4Invert, mat4Transform } from '../core/math3';

export class OrbitCamera {
  target: Vec3 = [0, 0, 0];
  distance = 50;
  /** 方位角/俯仰角(弧度) */
  yaw = 0.6;
  pitch = 0.9;
  fovY = (55 * Math.PI) / 180;
  ortho = false;
  /** 正射时的半高(世界单位) */
  orthoHalfHeight = 15;

  eye(): Vec3 {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.cos(this.yaw),
      this.target[1] + this.distance * cp * Math.sin(this.yaw),
      this.target[2] + this.distance * sp,
    ];
  }

  view(): Mat4 {
    return mat4LookAt(this.eye(), this.target, [0, 0, 1]);
  }

  proj(aspect: number): Mat4 {
    if (this.ortho) {
      const h = this.orthoHalfHeight;
      const w = h * aspect;
      return mat4Ortho(-w, w, -h, h, -500, 500);
    }
    return mat4Perspective(this.fovY, aspect, 0.05, 2000);
  }

  viewProj(aspect: number): Mat4 {
    const p = this.proj(aspect);
    const v = this.view();
    // out = p * v
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += p[k * 4 + r]! * v[c * 4 + k]!;
        o[c * 4 + r] = s;
      }
    return o;
  }

  /** 投影系数:透视 = h/(2 tan(fov/2));正射 = h/(2*orthoHalfHeight) */
  projFactor(viewportHeightPx: number): number {
    if (this.ortho) return viewportHeightPx / (2 * this.orthoHalfHeight);
    return viewportHeightPx / (2 * Math.tan(this.fovY / 2));
  }

  /** 一键正射俯视 */
  setTopDown() {
    this.ortho = true;
    this.pitch = Math.PI / 2 - 1e-4;
    this.yaw = 0;
    this.orthoHalfHeight = Math.max(this.distance * Math.tan(this.fovY / 2), 2);
  }
  setPerspective() {
    this.ortho = false;
  }

  rotate(dx: number, dy: number) {
    this.yaw -= dx * 0.005;
    this.pitch = Math.min(Math.PI / 2 - 0.01, Math.max(-Math.PI / 2 + 0.01, this.pitch + dy * 0.005));
  }
  pan(dx: number, dy: number, viewportHeight: number) {
    const scale = this.ortho
      ? (2 * this.orthoHalfHeight) / viewportHeight
      : (2 * this.distance * Math.tan(this.fovY / 2)) / viewportHeight;
    // 相机右向与上向(z-up)
    const eye = this.eye();
    const fwd = v3.norm(v3.sub(this.target, eye));
    const right = v3.norm(v3.cross(fwd, [0, 0, 1]));
    const up = v3.cross(right, fwd);
    this.target = v3.add(this.target, v3.add(v3.scale(right, -dx * scale), v3.scale(up, dy * scale)));
  }
  zoom(delta: number) {
    if (this.ortho) this.orthoHalfHeight = Math.max(0.2, this.orthoHalfHeight * (delta > 0 ? 1.15 : 1 / 1.15));
    else this.distance = Math.min(2000, Math.max(0.3, this.distance * (delta > 0 ? 1.15 : 1 / 1.15)));
  }

  /** 屏幕点 → 世界射线(透视)。正射时返回垂直向下的射线,原点随屏幕位置平移。 */
  screenRay(px: number, py: number, width: number, height: number): { origin: Vec3; dir: Vec3 } {
    const ndcX = (px / width) * 2 - 1;
    const ndcY = 1 - (py / height) * 2;
    if (this.ortho) {
      const aspect = width / height;
      const w = this.orthoHalfHeight * aspect;
      const x = ndcX * w, y = ndcY * this.orthoHalfHeight;
      // 相机坐标系:右 = [1,0,0] (yaw=0 俯视),上 = [0,-1,0]... 用 view 逆变换更稳
      const inv = mat4Invert(this.viewProj(aspect))!;
      const p = mat4Transform(inv, [ndcX, ndcY, 0]);
      return { origin: [p[0] / p[3], p[1] / p[3], p[2] / p[3]], dir: [0, 0, -1] };
    }
    const inv = mat4Invert(this.viewProj(width / height))!;
    const near = mat4Transform(inv, [ndcX, ndcY, -1]);
    const far = mat4Transform(inv, [ndcX, ndcY, 1]);
    const a: Vec3 = [near[0] / near[3], near[1] / near[3], near[2] / near[3]];
    const b: Vec3 = [far[0] / far[3], far[1] / far[3], far[2] / far[3]];
    return { origin: a, dir: v3.norm(v3.sub(b, a)) };
  }

  /** 世界点 → 屏幕像素坐标(标注叠加用),不可见返回 null */
  worldToScreen(p: Vec3, width: number, height: number): [number, number] | null {
    const vp = this.viewProj(width / height);
    const t = mat4Transform(vp, p);
    if (t[3] <= 0 && !this.ortho) return null;
    const x = ((t[0] / t[3]) * 0.5 + 0.5) * width;
    const y = (0.5 - t[1] / t[3] * 0.5) * height;
    if (!isFinite(x) || !isFinite(y)) return null;
    return [x, y];
  }
}
