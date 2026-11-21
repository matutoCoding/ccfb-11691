/** 勘查视图页:渲染模式切换、正射俯视、两点测距/三点测角/曲线量长/车速估算,测量结果挂案件。 */

import { Viewer } from '../viewer';
import { state } from '../state';
import { distance, angleAt, polylineLength, estimateSpeed } from '../../core/measure';
import { fitPlaneRansac } from '../../core/planeFit';
import { MeasureRecord } from '../../core/types';
import { saveCaseMeta } from '../../store/db';
import { Vec3 } from '../../core/math3';
import { ColorMode } from '../../gpu/renderer';

export function renderSurvey(el: HTMLElement): () => void {
  el.innerHTML = `
    <div class="toolbar">
      <strong>勘查视图</strong>
      <label class="field">着色
        <select id="color-mode">
          <option value="0">真彩色</option>
          <option value="1">反射强度</option>
          <option value="2">法线</option>
          <option value="3">高程</option>
        </select>
      </label>
      <button id="topdown">正射俯视</button>
      <button id="fit-plane">拟合路面</button>
      <span class="muted">|</span>
      <button id="m-dist">两点测距</button>
      <button id="m-angle">三点测角</button>
      <button id="m-curve">曲线量长</button>
      <button id="m-speed">估算车速</button>
      <button id="m-cancel">取消/清除</button>
    </div>
    <div style="flex:1;display:flex;min-height:0">
      <div id="vp" style="flex:1;display:flex;min-width:0"></div>
      <div class="panel-side">
        <h3>当前操作</h3>
        <div id="hint" class="muted">左键旋转,右键平移,滚轮缩放。选择测量工具后在点云上取点。</div>
        <h3>测量结果(随案件保存)</h3>
        <div id="records"></div>
      </div>
    </div>`;

  const viewer = new Viewer();
  el.querySelector('#vp')!.append(viewer.wrap);
  const hint = el.querySelector<HTMLDivElement>('#hint')!;
  const recordsEl = el.querySelector<HTMLDivElement>('#records')!;

  let pendingKind: MeasureRecord['kind'] | null = null;

  function refreshRecords() {
    const c = state.currentCase;
    recordsEl.innerHTML = '';
    if (!c || !c.measurements.length) {
      recordsEl.innerHTML = '<p class="muted">暂无测量记录</p>';
      return;
    }
    const t = document.createElement('table');
    t.innerHTML = `<tr><th>类型</th><th>结果</th><th>说明</th><th></th></tr>`;
    const kindName = { distance: '距离', angle: '角度', curve: '曲线长', speed: '车速' };
    c.measurements.forEach((m, i) => {
      const tr = document.createElement('tr');
      const unit = m.kind === 'angle' ? '°' : m.kind === 'speed' ? ' km/h' : ' m';
      tr.innerHTML = `<td>${kindName[m.kind]}</td><td>${m.value.toFixed(m.kind === 'angle' ? 1 : 3)}${unit}</td><td>${m.note}</td><td></td>`;
      const del = document.createElement('button');
      del.textContent = '删';
      del.className = 'danger';
      del.addEventListener('click', () => {
        c.measurements.splice(i, 1);
        saveCaseMeta(c);
        refreshRecords();
      });
      tr.lastElementChild!.append(del);
      t.append(tr);
    });
    recordsEl.append(t);
  }

  function addRecord(kind: MeasureRecord['kind'], points: Vec3[], value: number, note: string) {
    const c = state.currentCase;
    if (!c) { hint.textContent = '⚠ 没有打开的案件,测量结果无法保存'; return; }
    c.measurements.push({
      id: crypto.randomUUID(), kind, label: '', points: points.map((p) => [...p] as [number, number, number]),
      value, note, createdAt: new Date().toISOString(),
    });
    saveCaseMeta(c);
    refreshRecords();
  }

  function setTool(kind: MeasureRecord['kind'] | null, toolText: string, hintText: string) {
    pendingKind = kind;
    viewer.clearPicked();
    viewer.tool = kind ? (toolText as typeof viewer.tool) : 'navigate';
    hint.textContent = hintText;
  }

  el.querySelector('#m-dist')!.addEventListener('click', () =>
    setTool('distance', 'measure-distance', '测距:在点云上点击 2 个点'));
  el.querySelector('#m-angle')!.addEventListener('click', () =>
    setTool('angle', 'measure-angle', '测角:依次点击 3 个点,第 2 个为顶点'));
  el.querySelector('#m-curve')!.addEventListener('click', () =>
    setTool('curve', 'measure-curve', '曲线量长:沿刹车印逐点点击,双击或再点一次本按钮结束'));
  el.querySelector('#m-speed')!.addEventListener('click', () =>
    setTool('speed', 'measure-curve', '估算车速:沿刹车印逐点点击,结束后输入附着系数'));
  el.querySelector('#m-cancel')!.addEventListener('click', () => {
    setTool(null, '', '左键旋转,右键平移,滚轮缩放。');
  });

  viewer.onPick = () => {
    const pts = viewer.picked;
    if (pendingKind === 'distance' && pts.length >= 2) {
      const d = distance(pts[0]!, pts[1]!);
      addRecord('distance', pts.slice(0, 2), d, '');
      hint.innerHTML = `距离 = <b>${d.toFixed(3)} m</b>(已保存)`;
      viewer.clearPicked();
    } else if (pendingKind === 'angle' && pts.length >= 3) {
      const a = angleAt(pts[0]!, pts[1]!, pts[2]!);
      addRecord('angle', pts.slice(0, 3), a, '');
      hint.innerHTML = `角度 = <b>${a.toFixed(1)}°</b>(已保存)`;
      viewer.clearPicked();
    }
  };

  // 曲线/车速:取点 ≥2 后再点一次对应按钮结束
  const curveBtn = el.querySelector('#m-curve')!;
  const speedBtn = el.querySelector('#m-speed')!;
  curveBtn.addEventListener('click', () => { if (viewer.picked.length >= 2 && pendingKind === 'curve') finishCurve(); });
  speedBtn.addEventListener('click', () => { if (viewer.picked.length >= 2 && pendingKind === 'speed') finishSpeed(); });

  function finishCurve() {
    const pts = viewer.picked;
    if (pts.length < 2) return;
    const L = polylineLength(pts);
    addRecord('curve', pts, L, `${pts.length} 个拾取点`);
    hint.innerHTML = `曲线长度 = <b>${L.toFixed(3)} m</b>(已保存)`;
    viewer.clearPicked();
  }

  function finishSpeed() {
    const pts = viewer.picked;
    if (pts.length < 2) return;
    const L = polylineLength(pts);
    const c = state.currentCase;
    const fStr = prompt(`制动距离 ${L.toFixed(3)} m。输入路面附着系数(干燥沥青 0.7-0.8,湿滑 0.3-0.5):`, String(c?.friction ?? 0.7));
    if (fStr === null) return;
    const f = parseFloat(fStr);
    if (!isFinite(f) || f <= 0) { alert('附着系数必须是正数'); return; }
    if (c) { c.friction = f; saveCaseMeta(c); }
    const v = estimateSpeed(L, f);
    addRecord('speed', pts, v, `制动距离 ${L.toFixed(2)}m,附着系数 ${f}`);
    hint.innerHTML = `制动前车速 ≈ <b>${v.toFixed(1)} km/h</b>(v=√(254·f·s),已保存)`;
    viewer.clearPicked();
  }

  el.querySelector('#color-mode')!.addEventListener('change', (e) => {
    viewer.colorMode = +(e.target as HTMLSelectElement).value as ColorMode;
    viewer.invalidate();
  });

  el.querySelector('#topdown')!.addEventListener('click', () => {
    if (viewer.camera.ortho) {
      viewer.camera.setPerspective();
      (el.querySelector('#topdown') as HTMLButtonElement).textContent = '正射俯视';
    } else {
      viewer.camera.setTopDown();
      (el.querySelector('#topdown') as HTMLButtonElement).textContent = '退出俯视';
    }
    viewer.invalidate();
  });

  el.querySelector('#fit-plane')!.addEventListener('click', async () => {
    if (!state.merged) { hint.textContent = '⚠ 未加载点云'; return; }
    hint.textContent = '拟合路面平面中…';
    await new Promise((r) => setTimeout(r, 30));
    const plane = fitPlaneRansac(state.merged);
    if (!plane) { hint.textContent = '⚠ 平面拟合失败'; return; }
    hint.innerHTML = `路面法线 (${plane.normal.map((v) => v.toFixed(3)).join(', ')}),内点 ${(plane.inlierRatio * 100).toFixed(1)}%。已切到正射俯视。`;
    viewer.camera.setTopDown();
    viewer.invalidate();
  });

  refreshRecords();
  viewer.init().then(() => viewer.refreshCloud()).catch(() => {});
  return () => viewer.stop();
}
