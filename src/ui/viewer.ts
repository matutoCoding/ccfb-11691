/** 共享 3D 视口:WebGPU 画布 + 2D 标注叠加层 + 相机交互 + 拾取/框选/套索。 */

import { SplatRenderer, ColorMode } from '../gpu/renderer';
import { OrbitCamera } from '../gpu/camera';
import { state } from './state';
import { pickPoint, pointsInSphere } from '../core/octree';
import { Vec3 } from '../core/math3';

export type ToolMode =
  | 'navigate'
  | 'measure-distance'
  | 'measure-angle'
  | 'measure-curve'
  | 'select-box'
  | 'select-lasso';

export class Viewer {
  renderer: SplatRenderer | null = null;
  camera = new OrbitCamera();
  colorMode: ColorMode = 0;
  tool: ToolMode = 'navigate';
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  hud: HTMLDivElement;
  wrap: HTMLDivElement;
  private ctx2d: CanvasRenderingContext2D;
  private running = false;
  private needsRender = true;
  /** 测量拾取中的点(世界坐标) */
  picked: Vec3[] = [];
  /** 选区(屏幕坐标) */
  selection: [number, number][] = [];
  onPick: ((p: Vec3) => void) | null = null;
  onSelect: ((poly: [number, number][]) => void) | null = null;
  private fpsAcc = 0;
  private fpsN = 0;
  private fps = 0;
  private gpuError: string | null = null;

  constructor() {
    this.wrap = document.createElement('div');
    this.wrap.className = 'viewport-wrap';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gpu';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'gpu';
    this.overlay.style.pointerEvents = 'none';
    this.hud = document.createElement('div');
    this.hud.className = 'hud';
    this.wrap.append(this.canvas, this.overlay, this.hud);
    this.ctx2d = this.overlay.getContext('2d')!;
    this.bindInput();
  }

  async init(): Promise<void> {
    this.renderer = new SplatRenderer();
    try {
      await this.renderer.init(this.canvas);
    } catch (e) {
      this.gpuError = (e as Error).message;
      this.hud.textContent = this.gpuError;
      throw e;
    }
    this.renderer.setOctree(state.octree);
    this.frameScene();
    this.start();
  }

  /** 点云变化后调用 */
  refreshCloud() {
    this.renderer?.setOctree(state.octree);
    if (state.octree) {
      // 视场对准场景中心
      const c = state.octree.root.center;
      this.camera.target = [...c];
      this.camera.distance = Math.max(state.octree.root.radius * 2.2, 5);
    }
    this.invalidate();
  }

  flagsChanged() {
    this.renderer?.invalidateNodes();
    this.invalidate();
  }

  invalidate() { this.needsRender = true; }

  frameScene() { /* 已由 refreshCloud 处理,保留接口 */ }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      if (this.needsRender && this.renderer) {
        const t0 = performance.now();
        this.draw();
        const dt = performance.now() - t0;
        this.fpsAcc += dt; this.fpsN++;
        if (this.fpsAcc > 500) { this.fps = 1000 / (this.fpsAcc / this.fpsN); this.fpsAcc = 0; this.fpsN = 0; }
        this.needsRender = false;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() { this.running = false; }

  private resize() {
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(devicePixelRatio, 2);
    const pw = Math.floor(w * dpr), ph = Math.floor(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw; this.canvas.height = ph;
      this.overlay.width = pw; this.overlay.height = ph;
    }
  }

  private draw() {
    this.resize();
    const r = this.renderer!;
    const w = this.canvas.width, h = this.canvas.height;
    if (w === 0 || h === 0) return;
    const vp = this.camera.viewProj(w / h);
    const view = this.camera.view();
    r.render(vp, view, this.camera.eye(), this.camera.projFactor(h), w, h, state.settings, this.colorMode);
    this.drawOverlay(w, h);
    const mp = state.merged;
    this.hud.textContent = this.gpuError
      ? this.gpuError
      : `点数 ${mp ? mp.count.toLocaleString() : 0} | 绘制 ${r.lastDrawnPoints.toLocaleString()} | ${this.fps.toFixed(0)} fps | ${this.camera.ortho ? '正射俯视' : '透视'}`;
  }

  private drawOverlay(w: number, h: number) {
    const ctx = this.ctx2d;
    const dpr = Math.min(devicePixelRatio, 2);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.scale(dpr, dpr);
    const cw = w / dpr, ch = h / dpr;

    // 测量点与连线
    if (this.picked.length) {
      ctx.strokeStyle = '#ffb84d';
      ctx.fillStyle = '#ffb84d';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let first = true;
      for (const p of this.picked) {
        const s = this.camera.worldToScreen(p, cw, ch);
        if (!s) continue;
        if (first) { ctx.moveTo(s[0], s[1]); first = false; }
        else ctx.lineTo(s[0], s[1]);
      }
      ctx.stroke();
      for (const p of this.picked) {
        const s = this.camera.worldToScreen(p, cw, ch);
        if (!s) continue;
        ctx.beginPath();
        ctx.arc(s[0], s[1], 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 选区
    if (this.selection.length > 1) {
      ctx.strokeStyle = '#4da3ff';
      ctx.beginPath();
      this.selection.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      if (this.tool === 'select-box' && this.selection.length === 2) {
        const [a, b] = this.selection;
        ctx.strokeRect(a![0], a![1], b![0] - a![0], b![1] - a![1]);
      } else {
        ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private bindInput() {
    let dragging = false;
    let button = 0;
    let lastX = 0, lastY = 0;

    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      dragging = true;
      button = e.button;
      lastX = e.offsetX; lastY = e.offsetY;
      if (this.tool === 'select-box') this.selection = [[e.offsetX, e.offsetY]];
      if (this.tool === 'select-lasso') this.selection = [[e.offsetX, e.offsetY]];
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.offsetX - lastX, dy = e.offsetY - lastY;
      lastX = e.offsetX; lastY = e.offsetY;
      if (this.tool === 'navigate') {
        if (button === 0) this.camera.rotate(dx, dy);
        else this.camera.pan(dx, dy, this.canvas.height);
        this.invalidate();
      } else if (this.tool === 'select-box' && this.selection.length) {
        this.selection[1] = [e.offsetX, e.offsetY];
        this.invalidate();
      } else if (this.tool === 'select-lasso') {
        this.selection.push([e.offsetX, e.offsetY]);
        this.invalidate();
      }
    });

    this.canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      if (this.tool === 'select-box' || this.tool === 'select-lasso') {
        if (this.selection.length >= 2 && this.onSelect) this.onSelect(this.selection);
        this.selection = [];
        this.invalidate();
        return;
      }
      // 测量点击(未拖动)
      if (this.tool.startsWith('measure') && Math.abs(e.offsetX - lastX) < 4 && Math.abs(e.offsetY - lastY) < 4) {
        this.handleMeasureClick(e.offsetX, e.offsetY);
      }
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.zoom(e.deltaY);
      this.invalidate();
    }, { passive: false });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private handleMeasureClick(x: number, y: number) {
    if (!state.octree) return;
    const dpr = Math.min(devicePixelRatio, 2);
    const w = this.canvas.width, h = this.canvas.height;
    const ray = this.camera.screenRay(x * dpr, y * dpr, w, h);
    // 容差:屏幕上约 8 像素对应的世界距离
    const tolWorld = (8 * (this.camera.ortho ? 2 * this.camera.orthoHalfHeight : 2 * this.camera.distance * Math.tan(this.camera.fovY / 2))) / h;
    const idx = pickPoint(state.octree, ray.origin, ray.dir, Math.max(tolWorld, 0.005));
    if (idx < 0) return;
    const p = state.octree.cloud.positions;
    // 亚采样精化:取命中点邻域质心,降低离散采样噪声
    const raw: Vec3 = [p[idx * 3]!, p[idx * 3 + 1]!, p[idx * 3 + 2]!];
    const nb: number[] = [];
    pointsInSphere(state.octree, raw, Math.max(tolWorld * 2, 0.03), nb);
    let pt = raw;
    if (nb.length >= 3) {
      let sx = 0, sy = 0, sz = 0;
      for (const i of nb) { sx += p[i * 3]!; sy += p[i * 3 + 1]!; sz += p[i * 3 + 2]!; }
      pt = [sx / nb.length, sy / nb.length, sz / nb.length];
    }
    this.picked.push(pt);
    this.onPick?.(pt);
    this.invalidate();
  }

  clearPicked() {
    this.picked = [];
    this.invalidate();
  }
}
