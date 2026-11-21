/** 设置页:拼接限差、清理参数、渲染参数。 */

import { state, saveSettings } from '../state';
import { AppSettings } from '../../core/types';

const FIELDS: { key: keyof AppSettings; label: string; step?: number; hint: string }[] = [
  { key: 'residualLimit', label: '拼接残差限差 (m)', step: 0.005, hint: '超过此值的站在拼接表里标红' },
  { key: 'sorNeighbors', label: '离群点邻域点数', hint: '统计离群点去除的 k 近邻' },
  { key: 'sorStdRatio', label: '离群点 σ 倍数', step: 0.1, hint: '越大越宽松' },
  { key: 'voxelSize', label: '体素降采样边长 (m)', step: 0.005, hint: '0 = 不降采样' },
  { key: 'ghostHeight', label: '拖影高度阈值 (m)', step: 0.05, hint: '高出路面此值的稀疏点判为拖影' },
  { key: 'ghostDensity', label: '拖影密度比例', step: 0.05, hint: '局部密度低于均值此比例判为拖影' },
  { key: 'splatBaseSize', label: 'splat 基础尺寸 (m)', step: 0.005, hint: '路面孔洞和稀疏区的最小点径' },
  { key: 'lodErrorPx', label: 'LOD 屏幕误差 (px)', step: 0.1, hint: '越小细节越多,帧率越低' },
  { key: 'renderBudget', label: '每帧渲染预算(点)', hint: '一千万点场景建议 1.5M-3M' },
];

export function renderSettings(el: HTMLElement): () => void {
  el.innerHTML = `<h2>设置</h2><div class="card" id="form"></div>
    <button class="primary" id="save">保存</button>
    <button id="reset" style="margin-left:8px">恢复默认</button>
    <span id="msg" class="muted" style="margin-left:10px"></span>`;

  const form = el.querySelector('#form')!;
  for (const f of FIELDS) {
    const row = document.createElement('div');
    row.style.margin = '8px 0';
    row.innerHTML = `<label class="field" style="width:100%">
      <span style="display:inline-block;width:220px">${f.label}</span>
      <input type="number" id="set-${f.key}" value="${state.settings[f.key]}" ${f.step ? `step="${f.step}"` : ''}>
      <span class="muted">${f.hint}</span></label>`;
    form.append(row);
  }

  el.querySelector('#save')!.addEventListener('click', () => {
    for (const f of FIELDS) {
      const v = parseFloat(el.querySelector<HTMLInputElement>(`#set-${f.key}`)!.value);
      if (isFinite(v)) (state.settings[f.key] as number) = v;
    }
    saveSettings();
    el.querySelector('#msg')!.textContent = '已保存';
  });

  el.querySelector('#reset')!.addEventListener('click', () => {
    localStorage.removeItem('crashscene.settings');
    location.reload();
  });
  return () => {};
}
