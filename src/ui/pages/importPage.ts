/** 点云导入页:PLY 导入(ASCII/二进制)、坏文件报错、多站靶球拼接、残差表。 */

import { parsePly, PlyError } from '../../core/ply';
import { registerPointPairs } from '../../core/registration';
import { Station } from '../../core/types';
import { state, rebuildMerged, notify } from '../state';
import { saveCaseMeta, saveStationCloud } from '../../store/db';
import { Vec3 } from '../../core/math3';

export function renderImport(el: HTMLElement): () => void {
  el.innerHTML = `
    <h2>点云导入与拼接</h2>
    <div id="no-case" class="card" hidden>请先在「案件列表」打开或新建一个案件。</div>
    <div id="content">
      <div class="drop" id="drop">拖入 .ply 文件,或点击选择(支持 ASCII / 二进制,含颜色、反射强度、法线)</div>
      <input type="file" id="file" accept=".ply" multiple hidden>
      <div id="parse-status" class="muted" style="margin:8px 0"></div>
      <div id="err" class="err"></div>
      <h3>站点列表</h3>
      <div id="stations"></div>
      <h3>拼接残差(限差 <span id="limit"></span> m,可在设置中调整)</h3>
      <div id="residuals"></div>
    </div>`;

  const c = () => state.currentCase;
  el.querySelector<HTMLSpanElement>('#limit')!.textContent = state.settings.residualLimit.toString();

  function refresh() {
    const noCase = el.querySelector<HTMLDivElement>('#no-case')!;
    const content = el.querySelector<HTMLDivElement>('#content')!;
    if (!c()) { noCase.hidden = false; content.style.display = 'none'; return; }
    noCase.hidden = true; content.style.display = '';

    const stEl = el.querySelector<HTMLDivElement>('#stations')!;
    stEl.innerHTML = '';
    const t = document.createElement('table');
    t.innerHTML = `<tr><th>站名</th><th>文件</th><th>点数</th><th>靶球数</th><th>RMS(m)</th><th>状态</th><th></th></tr>`;
    c()!.stations.forEach((s, i) => {
      const tr = document.createElement('tr');
      if (s.overLimit) tr.classList.add('over-limit');
      const status = i === 0 ? '<span class="tag ok">基准站</span>'
        : s.residuals.length === 0 ? '<span class="tag warn">未拼接</span>'
        : s.overLimit ? '<span class="tag bad">超限</span>' : '<span class="tag ok">合格</span>';
      tr.innerHTML = `<td>${s.name}</td><td>${s.fileName}</td><td>${s.cloud.count.toLocaleString()}</td>
        <td>${s.targets.length}</td><td>${s.residuals.length ? s.residualRms.toFixed(4) : '—'}</td><td>${status}</td><td></td>`;
      const td = tr.lastElementChild!;
      const tgtBtn = document.createElement('button');
      tgtBtn.textContent = '录入靶球';
      tgtBtn.addEventListener('click', () => editTargets(s));
      td.append(tgtBtn);
      if (i > 0) {
        const regBtn = document.createElement('button');
        regBtn.textContent = '拼接';
        regBtn.addEventListener('click', () => doRegister(s));
        td.append(' ', regBtn);
      }
      t.append(tr);
    });
    stEl.append(t);

    // 残差汇总表
    const rEl = el.querySelector<HTMLDivElement>('#residuals')!;
    rEl.innerHTML = '';
    const anyResiduals = c()!.stations.some((s) => s.residuals.length > 0);
    if (!anyResiduals) { rEl.innerHTML = '<p class="muted">尚未拼接。第一站自动作为基准站,后续站录入 3 个以上公共靶球后点「拼接」。</p>'; return; }
    const rt = document.createElement('table');
    rt.innerHTML = `<tr><th>站名</th><th>靶球</th><th>残差(m)</th><th>RMS(m)</th></tr>`;
    for (const s of c()!.stations) {
      if (!s.residuals.length) continue;
      s.residuals.forEach((r, i) => {
        const tr = document.createElement('tr');
        if (r > state.settings.residualLimit) tr.classList.add('over-limit');
        tr.innerHTML = `<td>${s.name}</td><td>#${i + 1}</td><td>${r.toFixed(4)}</td><td>${i === 0 ? s.residualRms.toFixed(4) : ''}</td>`;
        rt.append(tr);
      });
    }
    rEl.append(rt);
  }

  function editTargets(s: Station) {
    const cur = s.targets.map((t) => t.map((v) => v.toFixed(4)).join(', ')).join('\n');
    const input = prompt(
      `录入「${s.name}」的靶球坐标(本站扫描仪坐标系),每行一个:x, y, z\n` +
      `各站靶球按行顺序一一对应,至少 3 个。`, cur);
    if (input === null) return;
    const pts: [number, number, number][] = [];
    for (const [ln, line] of input.split('\n').entries()) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split(/[,\s]+/).map(Number);
      if (parts.length !== 3 || parts.some((v) => !isFinite(v))) {
        alert(`第 ${ln + 1} 行格式不对:"${t}",应为 x, y, z 三个数字`);
        return;
      }
      pts.push(parts as [number, number, number]);
    }
    s.targets = pts;
    saveCaseMeta(c()!);
    refresh();
  }

  function doRegister(s: Station) {
    const ref = c()!.stations[0]!;
    if (ref === s) return;
    const n = Math.min(ref.targets.length, s.targets.length);
    if (n < 3) { alert(`基准站与「${s.name}」的公共靶球不足 3 个(当前 ${n} 个)`); return; }
    try {
      const src = s.targets.slice(0, n) as Vec3[];
      const dst = ref.targets.slice(0, n) as Vec3[];
      const res = registerPointPairs(src, dst);
      s.transform = Array.from(res.transform);
      s.residuals = res.residuals;
      s.residualRms = res.rms;
      s.overLimit = res.rms > state.settings.residualLimit;
      rebuildMerged();
      saveCaseMeta(c()!);
      notify();
      refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function importFiles(files: FileList | File[]) {
    const errEl = el.querySelector<HTMLDivElement>('#err')!;
    const statusEl = el.querySelector<HTMLDivElement>('#parse-status')!;
    errEl.textContent = '';
    for (const file of Array.from(files)) {
      statusEl.textContent = `解析 ${file.name} …`;
      await new Promise((r) => setTimeout(r, 30)); // 让状态渲染出来
      try {
        const buf = await file.arrayBuffer();
        const cloud = parsePly(buf);
        const s: Station = {
          id: crypto.randomUUID(),
          name: `站点${c()!.stations.length + 1}`,
          fileName: file.name,
          cloud,
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          targets: [], residuals: [], residualRms: 0, overLimit: false,
        };
        c()!.stations.push(s);
        await saveStationCloud(c()!.id, s);
        await saveCaseMeta(c()!);
        rebuildMerged();
        notify();
        statusEl.textContent = `${file.name}: ${cloud.count.toLocaleString()} 点` +
          `${cloud.colors ? ' +颜色' : ''}${cloud.intensities ? ' +强度' : ''}${cloud.normals ? ' +法线' : ''}`;
      } catch (e) {
        if (e instanceof PlyError) {
          errEl.textContent += `${file.name}:导入失败 —— ${e.message}\n`;
        } else {
          errEl.textContent += `${file.name}:读取失败 —— ${(e as Error).message}\n`;
        }
        statusEl.textContent = '';
      }
    }
    refresh();
  }

  const drop = el.querySelector<HTMLDivElement>('#drop')!;
  const fileInput = el.querySelector<HTMLInputElement>('#file')!;
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => fileInput.files && importFiles(fileInput.files));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer?.files.length) importFiles(e.dataTransfer.files);
  });

  refresh();
  return () => {};
}
