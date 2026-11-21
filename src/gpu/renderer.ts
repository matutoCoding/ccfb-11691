/** WebGPU splat 渲染器:八叉树 LOD 分级加载,节点按需上传 GPU,LRU 缓存。 */

import { Octree, OctreeNode, collectVisibleNodes } from '../core/octree';
import { AppSettings } from '../core/types';
import { Mat4, Vec3 } from '../core/math3';
import { SPLAT_WGSL } from './splat.wgsl';

export type ColorMode = 0 | 1 | 2 | 3; // RGB / 强度 / 法线 / 高程

const GLOBALS_SIZE = 176;
const NODE_PARAM_SIZE = 16;

interface GpuNode {
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  count: number;
  radius: number;
  stamp: number; // LRU 戳
}

export class SplatRenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private pipeline!: GPURenderPipeline;
  private depthTex: GPUTexture | null = null;
  private globalsBuf!: GPUBuffer;
  private globalsGroup!: GPUBindGroup;
  private nodeLayout!: GPUBindGroupLayout;
  private nodes = new Map<OctreeNode, GpuNode>();
  private oct: Octree | null = null;
  private lruClock = 0;
  private format: GPUTextureFormat = 'bgra8unorm';
  heightRange: [number, number] = [0, 1];
  /** 统计 */
  lastDrawnPoints = 0;
  lastFrameMs = 0;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.gpu) throw new Error('此浏览器不支持 WebGPU(需要 Chrome/Edge 113+)');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('找不到可用的 GPU 适配器');
    this.device = await adapter.requestDevice();
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('无法创建 WebGPU 上下文');
    this.context = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });

    const module = this.device.createShaderModule({ code: SPLAT_WGSL });
    this.nodeLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    const globalLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [globalLayout, this.nodeLayout] }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.globalsBuf = this.device.createBuffer({ size: GLOBALS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.globalsGroup = this.device.createBindGroup({
      layout: globalLayout,
      entries: [{ binding: 0, resource: { buffer: this.globalsBuf } }],
    });
  }

  setOctree(oct: Octree | null) {
    this.oct = oct;
    for (const n of this.nodes.values()) n.buffer.destroy();
    this.nodes.clear();
    if (oct) {
      let mn = Infinity, mx = -Infinity;
      const p = oct.cloud.positions;
      for (let i = 0; i < oct.cloud.count; i++) {
        const z = p[i * 3 + 2]!;
        if (z < mn) mn = z;
        if (z > mx) mx = z;
      }
      this.heightRange = [mn, mx];
    }
  }

  /** 隔离层 flags 变化后调用:全部节点标脏,按需重建 */
  invalidateNodes() {
    for (const n of this.nodes.values()) n.buffer.destroy();
    this.nodes.clear();
  }

  /** 打包一个节点的可见点为 GPU 缓冲(32 字节/点) */
  private buildNode(node: OctreeNode, splatBaseSize: number): GpuNode {
    const oct = this.oct!;
    const { positions, colors, intensities, normals, flags } = oct.cloud;
    let visible = 0;
    for (const i of node.indices) if (flags[i] === 0) visible++;
    const data = new ArrayBuffer(visible * 32);
    const f32 = new Float32Array(data);
    const u32 = new Uint32Array(data);
    let o = 0;
    for (const i of node.indices) {
      if (flags[i] !== 0) continue;
      const w = o * 8;
      f32[w] = positions[i * 3]!;
      f32[w + 1] = positions[i * 3 + 1]!;
      f32[w + 2] = positions[i * 3 + 2]!;
      u32[w + 3] = colors
        ? colors[i * 3]! | (colors[i * 3 + 1]! << 8) | (colors[i * 3 + 2]! << 16) | 0xff000000
        : 0xffb0b0b0;
      f32[w + 4] = intensities ? intensities[i]! : 0.5;
      f32[w + 5] = normals ? normals[i * 3]! : 0;
      f32[w + 6] = normals ? normals[i * 3 + 1]! : 0;
      f32[w + 7] = normals ? normals[i * 3 + 2]! : 0;
      o++;
    }
    const buffer = this.device.createBuffer({ size: Math.max(data.byteLength, 32), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, data);
    const paramBuf = this.device.createBuffer({ size: NODE_PARAM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const radius = Math.max(node.spacing * 0.7, splatBaseSize);
    this.device.queue.writeBuffer(paramBuf, 0, new Float32Array([radius, 0, 0, 0]));
    const bindGroup = this.device.createBindGroup({
      layout: this.nodeLayout,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: { buffer: paramBuf } },
      ],
    });
    return { buffer, bindGroup, count: visible, radius, stamp: ++this.lruClock };
  }

  private evictIfNeeded() {
    if (this.nodes.size <= 600) return;
    const arr = [...this.nodes.entries()].sort((a, b) => a[1].stamp - b[1].stamp);
    for (let i = 0; i < arr.length / 2; i++) {
      arr[i]![1].buffer.destroy();
      this.nodes.delete(arr[i]![0]);
    }
  }

  /** 视锥平面(行向量 [a,b,c,d]) */
  private frustumPlanes(vp: Mat4): number[][] {
    const row = (i: number) => [vp[i]!, vp[4 + i]!, vp[8 + i]!, vp[12 + i]!];
    const add = (a: number[], b: number[], s: number) => a.map((v, k) => v + s * b[k]!);
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    return [
      add(r3, r0, 1), add(r3, r0, -1),
      add(r3, r1, 1), add(r3, r1, -1),
      r2, add(r3, r2, -1),
    ];
  }

  /**
   * 渲染一帧。
   * @param viewProj 列主序 view*proj
   * @param view 列主序 view
   * @param eye 相机位置
   * @param projFactor 投影系数(像素/世界单位@单位距离)
   */
  render(
    viewProj: Mat4, view: Mat4, eye: Vec3, projFactor: number,
    width: number, height: number, settings: AppSettings, colorMode: ColorMode,
    target?: { view: GPUTextureView; depth: GPUTextureView },
  ): number {
    if (!this.oct) return 0;
    const t0 = performance.now();

    const planes = this.frustumPlanes(viewProj);
    const inFrustum = (c: Vec3, r: number) => {
      for (const p of planes) {
        if (p[0]! * c[0] + p[1]! * c[1] + p[2]! * c[2] + p[3]! < -r) return false;
      }
      return true;
    };
    const visible = collectVisibleNodes(this.oct, eye, inFrustum, projFactor, settings.lodErrorPx, settings.renderBudget);

    // 每帧限量上传,避免卡顿
    let uploads = 0;
    const drawList: GpuNode[] = [];
    for (const node of visible) {
      let g = this.nodes.get(node);
      if (!g) {
        if (uploads >= 12) {
          // 上传预算用完:用父节点粗数据顶着,下一帧再补
          continue;
        }
        g = this.buildNode(node, settings.splatBaseSize);
        this.nodes.set(node, g);
        uploads++;
      }
      g.stamp = ++this.lruClock;
      if (g.count > 0) drawList.push(g);
    }
    this.evictIfNeeded();

    // 全局 uniform
    const g = new ArrayBuffer(GLOBALS_SIZE);
    const gf = new Float32Array(g);
    const gu = new Uint32Array(g);
    gf.set(viewProj, 0);
    gf.set(view, 16);
    // 相机右向/上向 = view 矩阵第 0/1 行
    gf[32] = view[0]!; gf[33] = view[4]!; gf[34] = view[8]!;
    gf[35] = 1.0; // splatMinPx
    gf[36] = view[1]!; gf[37] = view[5]!; gf[38] = view[9]!;
    gu[39] = colorMode;
    gf[40] = width; gf[41] = height;
    gf[42] = this.heightRange[0]; gf[43] = this.heightRange[1];
    this.device.queue.writeBuffer(this.globalsBuf, 0, g);

    // 深度附件
    let depthView: GPUTextureView;
    let colorView: GPUTextureView;
    if (target) {
      colorView = target.view;
      depthView = target.depth;
    } else {
      const canvas = this.context.canvas as HTMLCanvasElement;
      if (!this.depthTex || this.depthTex.width !== canvas.width || this.depthTex.height !== canvas.height) {
        this.depthTex?.destroy();
        this.depthTex = this.device.createTexture({
          size: { width: canvas.width, height: canvas.height },
          format: 'depth24plus',
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
      }
      depthView = this.depthTex.createView();
      colorView = this.context.getCurrentTexture().createView();
    }

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        clearValue: { r: 0.06, g: 0.07, b: 0.09, a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.globalsGroup);
    let drawn = 0;
    for (const n of drawList) {
      pass.setBindGroup(1, n.bindGroup);
      pass.draw(6, n.count);
      drawn += n.count;
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.lastDrawnPoints = drawn;
    this.lastFrameMs = performance.now() - t0;
    return drawn;
  }

  /** 离屏渲染(正射出图):渲染到指定分辨率纹理并读回 RGBA 像素 */
  async renderOffscreen(
    width: number, height: number,
    viewProj: Mat4, view: Mat4, eye: Vec3, projFactor: number,
    settings: AppSettings, colorMode: ColorMode,
  ): Promise<Uint8Array> {
    const tex = this.device.createTexture({
      size: { width, height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const depth = this.device.createTexture({
      size: { width, height },
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // 离屏用独立"管线格式"会不匹配 —— 管线格式是 canvas 格式。
    // 解决:离屏也用 preferredFormat 纹理。
    tex.destroy();
    const tex2 = this.device.createTexture({
      size: { width, height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.render(viewProj, view, eye, projFactor, width, height, settings, colorMode,
      { view: tex2.createView(), depth: depth.createView() });

    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buf = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex2 }, { buffer: buf, bytesPerRow }, { width, height });
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    }
    buf.unmap();
    buf.destroy();
    tex2.destroy();
    depth.destroy();
    return out;
  }
}
