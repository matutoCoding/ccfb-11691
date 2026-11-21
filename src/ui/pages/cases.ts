/** 案件列表页:按事故编号建案、打开、删除。 */

import { listCases, createCase, deleteCase } from '../../store/db';
import { state, rebuildMerged, notify } from '../state';
import { loadCase } from '../../store/db';

export function renderCases(el: HTMLElement): () => void {
  el.innerHTML = `
    <h2>案件列表</h2>
    <div class="card row">
      <label class="field">事故编号 <input id="case-code" placeholder="公交认字[2026]第001号" size="28"></label>
      <label class="field">简要案情 <input id="case-title" size="30" placeholder="如:两车追尾,一人重伤"></label>
      <button class="primary" id="new-case">新建案件</button>
    </div>
    <div id="case-table">加载中…</div>
    <h3>测试场景</h3>
    <div class="card">
      <button id="gen-demo">生成合成测试场景案件</button>
      <span class="muted">含已知尺寸车辆(4.8m / 5.0m 车长)、已知长度刹车印(23.5m)、4 个靶球,用于验证测量精度</span>
    </div>`;

  const tableEl = el.querySelector<HTMLDivElement>('#case-table')!;

  async function refresh() {
    const cases = await listCases();
    if (!cases.length) {
      tableEl.innerHTML = '<p class="muted">还没有案件。新建一个,或生成合成测试场景。</p>';
      return;
    }
    tableEl.innerHTML = '';
    const t = document.createElement('table');
    t.innerHTML = `<tr><th>事故编号</th><th>案情</th><th>站点数</th><th>测量数</th><th>创建时间</th><th></th></tr>`;
    for (const c of cases.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const tr = document.createElement('tr');
      const open = state.currentCase?.id === c.id ? ' <span class="tag ok">当前</span>' : '';
      tr.innerHTML = `<td>${esc(c.code)}${open}</td><td>${esc(c.title)}</td>
        <td>${c.stations.length}</td><td>${c.measurements.length}</td>
        <td>${new Date(c.createdAt).toLocaleString()}</td><td></td>`;
      const td = tr.lastElementChild!;
      const openBtn = btn('打开', async () => {
        state.currentCase = await loadCase(c.id);
        rebuildMerged();
        notify();
        location.hash = '#/import';
      });
      const delBtn = btn('删除', async () => {
        if (!confirm(`删除案件 ${c.code}?点云数据一并删除,不可恢复。`)) return;
        await deleteCase(c.id);
        if (state.currentCase?.id === c.id) { state.currentCase = null; rebuildMerged(); }
        refresh();
      });
      delBtn.classList.add('danger');
      td.append(openBtn, ' ', delBtn);
      t.append(tr);
    }
    tableEl.append(t);
  }

  el.querySelector('#new-case')!.addEventListener('click', async () => {
    const code = el.querySelector<HTMLInputElement>('#case-code')!.value.trim();
    const title = el.querySelector<HTMLInputElement>('#case-title')!.value.trim();
    if (!code) { alert('请填写事故编号'); return; }
    state.currentCase = await createCase(code, title);
    rebuildMerged();
    notify();
    location.hash = '#/import';
  });

  el.querySelector('#gen-demo')!.addEventListener('click', async () => {
    const { generateScene } = await import('../../core/synthetic');
    const { saveStationCloud, saveCaseMeta } = await import('../../store/db');
    const scene = generateScene();
    const c = await createCase(`TEST-${Date.now() % 100000}`, '合成测试场景(已知尺寸)');
    c.stations.push({
      id: crypto.randomUUID(), name: '站点1', fileName: 'synthetic.ply',
      cloud: scene.cloud,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      targets: scene.truth.targets, residuals: [], residualRms: 0, overLimit: false,
    });
    await saveStationCloud(c.id, c.stations[0]!);
    await saveCaseMeta(c);
    state.currentCase = c;
    rebuildMerged();
    notify();
    location.hash = '#/survey';
  });

  refresh();
  return () => {};
}

function esc(s: string) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function btn(text: string, onClick: () => void) {
  const b = document.createElement('button');
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
