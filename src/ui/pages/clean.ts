/** 现场清理页:统计离群点去除、体素降采样、拖影识别、框选/套索隔离、还原。 */

import { Viewer } from '../viewer';
import { state, rebuildMerged, syncFlagsToStations } from '../state';
import { statisticalOutliers, voxelDownsample, detectGhosts, applyToIsolation, restore, visibleCount } from '../../core/filters';
import { fitPlaneRansac } from '../../core/planeFit';
import { PlaneFit } from '../../core/planeFit';
import { saveCaseMeta, saveStationCloud } from '../../store/db';

export function renderClean(el: HTMLElement): () => void {
  el.innerHTML = `
    <div class="toolbar">
      <strong>现场清理</strong>
      <button id="sor">统计离群点去除</button>
      <label class="field">邻域 <input type="number" id="sor-k" value="${state.settings.sorNeighbors}" min="4" max="64"></label>
      <label class="field">σ倍数 <input type="number" id="sor-s" value="${state.settings.sorStdRatio}" step="0.1" min="0.5" max="5"></label>
      <span class="muted">|</span>
      <label class="field">体素(m) <input type="number" id="voxel" value="${state.settings.voxelSize}" step="0.005" min="0"></label>
      <button id="voxel-preview">降采样预览</button>
      <span class="muted">|</span>
      <button id="ghost">识别拖影</button>
      <button id="ghost-isolate" disabled>隔离拖影</button>
      <span class="muted">|</span>
      <button id="tool-box">框选删点</button>
      <button id="tool-lasso">套索删点</button>
      <button id="restore">全部还原</button>
    </div>
    <div id="body" style="flex:1;display:flex;min-height:0">
      <div id="vp" style="flex:1;display:flex;min-width:0"></div>
      <div class="panel-side">
        <h3>点数对比</h3>
        <div id="counts" class="muted">—</div>
        <h3>说明</h3>
        <p class="muted">删除不改动原始数据:被删的点进入隔离层(flags 标记),随时可还原,原始扫描作为证据保持完整。</p>
        <div id="log" class="muted"></div>
      </div>
    </div>`;

  const viewer = new Viewer();
  el.querySelector('#vp')!.append(viewer.wrap);
  const logEl = el.querySelector<HTMLDivElement>('#log')!;
  const countsEl = el.querySelector<HTMLDivElement>('#counts')!;
  let plane: PlaneFit | null = null;
  let ghostMask: Uint8Array | null = null;

  const log = (s: string) => { logEl.innerHTML += `<div>${s}</div>`; logEl.scrollTop = 1e9; };

  function updateCounts(afterVoxel?: number) {
    const m = state.merged;
    if (!m) { countsEl.textContent = '未加载点云'; return; }
    const vis = visibleCount(m);
    let s = `原始点数:${m.count.toLocaleString()}<br>当前可见:${vis.toLocaleString()}<br>隔离层:${(m.count - vis).toLocaleString()}`;
    if (afterVoxel !== undefined) s += `<br>降采样后(预览):${afterVoxel.toLocaleString()}(${((afterVoxel / m.count) * 100).toFixed(1)}%)`;
    countsEl.innerHTML = s;
  }

  function requireCloud() {
    if (!state.merged) { log('⚠ 请先导入点云'); return false; }
    return true;
  }

  el.querySelector('#sor')!.addEventListener('click', async () => {
    if (!requireCloud()) return;
    const k = +el.querySelector<HTMLInputElement>('#sor-k')!.value;
    const s = +el.querySelector<HTMLInputElement>('#sor-s')!.value;
    log('统计离群点分析中…');
    await new Promise((r) => setTimeout(r, 30));
    const res = statisticalOutliers(state.merged!, k, s);
    applyToIsolation(state.merged!, res.outliers);
    let n = 0;
    for (const v of res.outliers) n += v;
    log(`离群点 ${n.toLocaleString()} 个已入隔离层(阈值 ${res.threshold.toFixed(4)}m)`);
    afterFlagsChanged();
  });

  el.querySelector('#voxel-preview')!.addEventListener('click', async () => {
    if (!requireCloud()) return;
    const v = +el.querySelector<HTMLInputElement>('#voxel')!.value;
    await new Promise((r) => setTimeout(r, 30));
    const keep = voxelDownsample(state.merged!, v);
    updateCounts(keep.length);
    log(`体素 ${v}m 降采样:${state.merged!.count.toLocaleString()} → ${keep.length.toLocaleString()}(预览,不改变数据)`);
  });

  el.querySelector('#ghost')!.addEventListener('click', async () => {
    if (!requireCloud()) return;
    log('拟合路面平面…');
    await new Promise((r) => setTimeout(r, 30));
    plane = fitPlaneRansac(state.merged!);
    if (!plane) { log('⚠ 平面拟合失败'); return; }
    log(`路面法线 (${plane.normal.map((v) => v.toFixed(3)).join(', ')}),内点 ${(plane.inlierRatio * 100).toFixed(1)}%`);
    ghostMask = detectGhosts(state.merged!, plane, state.settings.ghostHeight, state.settings.ghostDensity);
    let n = 0;
    for (const v of ghostMask) n += v;
    log(`识别出拖影候选 ${n.toLocaleString()} 点(围观人群/过往车辆),确认后可隔离`);
    (el.querySelector('#ghost-isolate') as HTMLButtonElement).disabled = n === 0;
  });

  el.querySelector('#ghost-isolate')!.addEventListener('click', () => {
    if (!ghostMask || !state.merged) return;
    applyToIsolation(state.merged, ghostMask);
    log('拖影已隔离');
    afterFlagsChanged();
  });

  el.querySelector('#tool-box')!.addEventListener('click', () => { viewer.tool = viewer.tool === 'select-box' ? 'navigate' : 'select-box'; });
  el.querySelector('#tool-lasso')!.addEventListener('click', () => { viewer.tool = viewer.tool === 'select-lasso' ? 'navigate' : 'select-lasso'; });

  viewer.onSelect = (poly) => {
    if (!state.merged || !state.octree) return;
    const n = isolateInPolygon(poly, viewer);
    log(`选区删点:${n.toLocaleString()} 点已入隔离层`);
    viewer.tool = 'navigate';
    afterFlagsChanged();
  };

  el.querySelector('#restore')!.addEventListener('click', () => {
    if (!state.merged) return;
    restore(state.merged);
    log('隔离层已全部还原');
    afterFlagsChanged();
  });

  function afterFlagsChanged() {
    syncFlagsToStations();
    persistFlags();
    viewer.flagsChanged();
    updateCounts();
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function persistFlags() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const c = state.currentCase;
      if (!c) return;
      for (const s of c.stations) await saveStationCloud(c.id, s);
    }, 800);
  }

  updateCounts();
  viewer.init().then(() => viewer.refreshCloud()).catch(() => {});
  return () => viewer.stop();
}

/** 屏幕多边形内的点入隔离层,返回点数 */
function isolateInPolygon(poly: [number, number][], viewer: Viewer): number {
  const m = state.merged!;
  const cam = viewer.camera;
  const w = viewer.canvas.width, h = viewer.canvas.height;
  const dpr = Math.min(devicePixelRatio, 2);
  let pts: [number, number][] = poly;
  if (pts.length === 2) {
    const [a, b] = pts;
    pts = [[a![0], a![1]], [b![0], a![1]], [b![0], b![1]], [a![0], b![1]]];
  }
  const inside = (x: number, y: number) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  let n = 0;
  for (let i = 0; i < m.count; i++) {
    if (m.flags[i] !== 0) continue;
    const p = [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!] as [number, number, number];
    const s = cam.worldToScreen(p, w / dpr, h / dpr);
    if (!s) continue;
    if (inside(s[0], s[1])) { m.flags[i] = 1; n++; }
  }
  return n;
}
