/** 测量出图页:正射俯视按比例出现场图,带比例尺、指北针、测量标注,导出 PNG。 */

import { state } from '../state';
import { SplatRenderer, ColorMode } from '../../gpu/renderer';
import { mat4Ortho, mat4LookAt, mat4Transform, Mat4, Vec3 } from '../../core/math3';

export function renderDraw(el: HTMLElement): () => void {
  el.innerHTML = `
    <h2>测量出图</h2>
    <div id="no-case" class="card" hidden>请先打开案件并导入点云。</div>
    <div class="card row" id="ctrl">
      <label class="field">比例 1:<input type="number" id="scale" value="${state.currentCase?.printScale ?? 200}" min="50" max="2000" step="50"></label>
      <label class="field">分辨率
        <select id="dpi"><option value="150">150 dpi</option><option value="300" selected>300 dpi</option></select>
      </label>
      <label class="field">着色
        <select id="cm"><option value="0">真彩色</option><option value="1">反射强度</option></select>
      </label>
      <label class="field">指北针角度(°) <input type="number" id="north" value="0" step="5" style="width:70px"></label>
      <button class="primary" id="render-btn">生成现场图</button>
      <button id="export-btn" disabled>导出 PNG</button>
      <span id="status" class="muted"></span>
    </div>
    <div style="text-align:center;background:#0c0e11;padding:12px;border-radius:8px;overflow:auto">
      <canvas id="out" style="max-width:100%;border:1px solid var(--line)"></canvas>
    </div>`;

  const outCanvas = el.querySelector<HTMLCanvasElement>('#out')!;
  const status = el.querySelector<HTMLSpanElement>('#status')!;
  const exportBtn = el.querySelector<HTMLButtonElement>('#export-btn')!;
  let renderer: SplatRenderer | null = null;
  let disposed = false;

  if (!state.currentCase || !state.octree) {
    el.querySelector<HTMLDivElement>('#no-case')!.hidden = false;
  }

  el.querySelector('#render-btn')!.addEventListener('click', async () => {
    if (!state.currentCase || !state.octree) { status.textContent = '请先打开案件并导入点云'; return; }
    const scale = +el.querySelector<HTMLInputElement>('#scale')!.value;
    const dpi = +el.querySelector<HTMLSelectElement>('#dpi')!.value;
    const colorMode = +el.querySelector<HTMLSelectElement>('#cm')!.value as ColorMode;
    const northDeg = +el.querySelector<HTMLInputElement>('#north')!.value;
    state.currentCase.printScale = scale;
    state.currentCase.northAngle = (northDeg * Math.PI) / 180;

    status.textContent = '渲染中…';
    try {
      if (!renderer) {
        renderer = new SplatRenderer();
        const hidden = document.createElement('canvas');
        hidden.width = 8; hidden.height = 8;
        document.body.append(hidden); // 部分浏览器要求 canvas 在文档中
        hidden.style.display = 'none';
        await renderer.init(hidden);
        renderer.setOctree(state.octree);
      }
      if (disposed) return;

      // 出图范围:点云 XY 包围盒
      const root = state.octree.root;
      const cx = (root.min[0] + root.max[0]) / 2;
      const cy = (root.min[1] + root.max[1]) / 2;
      const spanX = root.max[0] - root.min[0];
      const spanY = root.max[1] - root.min[1];

      // 每像素世界尺寸 = 比例 * 0.0254 / dpi
      const mPerPx = (scale * 0.0254) / dpi;
      const margin = 1.1;
      const w = Math.min(Math.ceil((spanX * margin) / mPerPx), 8192);
      const h = Math.min(Math.ceil((spanY * margin) / mPerPx), 8192);
      const halfW = (w / 2) * mPerPx;
      const halfH = (h / 2) * mPerPx;

      const eye: Vec3 = [cx, cy, 100];
      const view = mat4LookAt(eye, [cx, cy, 0], [0, 1, 0]);
      const proj = mat4Ortho(-halfW, halfW, -halfH, halfH, 0.1, 400);
      const viewProj = mul(proj, view);
      const projFactor = h / (2 * halfH);

      const pixels = await renderer.renderOffscreen(w, h, viewProj, view, eye, projFactor, state.settings, colorMode);
      if (disposed) return;

      // 合成:点云 + 图框要素
      outCanvas.width = w;
      outCanvas.height = h;
      const ctx = outCanvas.getContext('2d')!;
      const img = ctx.createImageData(w, h);
      img.data.set(pixels);
      ctx.putImageData(img, 0, 0);

      drawAnnotations(ctx, viewProj, w, h, mPerPx, scale, northDeg);
      exportBtn.disabled = false;
      status.textContent = `完成:${w}×${h} px,1:${scale},${(mPerPx * 1000).toFixed(2)} mm/px(世界)`;
    } catch (e) {
      status.textContent = `渲染失败:${(e as Error).message}`;
    }
  });

  function drawAnnotations(
    ctx: CanvasRenderingContext2D, viewProj: Mat4, w: number, h: number,
    mPerPx: number, scale: number, northDeg: number,
  ) {
    const toPx = (p: [number, number, number]): [number, number] => {
      const t = mat4Transform(viewProj, p);
      return [((t[0] / t[3]) * 0.5 + 0.5) * w, (0.5 - t[1] / t[3] * 0.5) * h];
    };

    // ---- 测量标注 ----
    const c = state.currentCase!;
    ctx.font = `${Math.max(14, h / 60)}px sans-serif`;
    ctx.lineWidth = Math.max(1.5, h / 800);
    for (const m of c.measurements) {
      if (m.points.length < 2) continue;
      ctx.strokeStyle = '#ffd24d';
      ctx.fillStyle = '#ffd24d';
      ctx.beginPath();
      m.points.forEach((p, i) => {
        const [x, y] = toPx(p);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      const mid = toPx(m.points[Math.floor(m.points.length / 2)]!);
      const unit = m.kind === 'angle' ? '°' : m.kind === 'speed' ? ' km/h' : ' m';
      const label = `${m.value.toFixed(m.kind === 'angle' ? 1 : 2)}${unit}`;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.strokeText(label, mid[0] + 6, mid[1] - 6);
      ctx.fillText(label, mid[0] + 6, mid[1] - 6);
    }

    // ---- 比例尺(左下):取约 150px 长的整数米 ----
    const barM = niceLength(150 * mPerPx);
    const barPx = barM / mPerPx;
    const bx = 40, by = h - 60;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    const seg = barPx / 4;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#fff' : '#333';
      ctx.fillRect(bx + i * seg, by, seg, 8);
    }
    ctx.strokeRect(bx, by, barPx, 8);
    ctx.fillStyle = '#fff';
    ctx.font = '16px sans-serif';
    ctx.fillText('0', bx - 3, by + 26);
    ctx.fillText(`${barM}m`, bx + barPx - 18, by + 26);
    ctx.fillText(`1:${scale}`, bx, by - 8);

    // ---- 指北针(右上) ----
    const nx = w - 70, ny = 80, r = 34;
    const na = (northDeg * Math.PI) / 180;
    ctx.save();
    ctx.translate(nx, ny);
    ctx.rotate(-na);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.35, r * 0.5);
    ctx.lineTo(0, r * 0.2);
    ctx.lineTo(-r * 0.35, r * 0.5);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText('N', nx - 6, ny - r - 10);

    // ---- 标题 ----
    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(`${c.code} 事故现场图  比例 1:${scale}`, 40, 40);
  }

  function niceLength(target: number): number {
    const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500];
    let best = candidates[0]!;
    for (const cnd of candidates) if (Math.abs(cnd - target) < Math.abs(best - target)) best = cnd;
    return best;
  }

  el.querySelector('#export-btn')!.addEventListener('click', () => {
    outCanvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.currentCase?.code ?? 'scene'}_现场图_1-${state.currentCase?.printScale ?? 200}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'image/png');
  });

  return () => {
    disposed = true;
    renderer = null; // GPU 资源随页面 GC;device 无法显式销毁无碍
  };
}

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  return o;
}
