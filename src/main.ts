/** 入口:布局 + hash 路由。 */

import { renderCases } from './ui/pages/cases';
import { renderImport } from './ui/pages/importPage';
import { renderClean } from './ui/pages/clean';
import { renderSurvey } from './ui/pages/survey';
import { renderDraw } from './ui/pages/draw';
import { renderSettings } from './ui/pages/settings';

interface Page {
  path: string;
  title: string;
  fill?: boolean;
  render: (el: HTMLElement) => void | (() => void);
}

const pages: Page[] = [
  { path: 'cases', title: '案件列表', render: renderCases },
  { path: 'import', title: '点云导入', render: renderImport },
  { path: 'clean', title: '现场清理', fill: true, render: renderClean },
  { path: 'survey', title: '勘查视图', fill: true, render: renderSurvey },
  { path: 'draw', title: '测量出图', render: renderDraw },
  { path: 'settings', title: '设置', render: renderSettings },
];

const app = document.getElementById('app')!;
const nav = document.createElement('nav');
const main = document.createElement('main');
nav.innerHTML = `<div class="brand">事故现场点云<br>勘查系统</div>`;
app.append(nav, main);

let cleanup: (() => void) | undefined;
let currentPath = '';

function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'cases';
  const page = pages.find((p) => p.path === hash) ?? pages[0]!;
  if (cleanup) { cleanup(); cleanup = undefined; }
  currentPath = page.path;
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${page.path}`));
  main.innerHTML = '';
  const el = document.createElement('div');
  el.className = page.fill ? 'page fill active' : 'page active';
  main.append(el);
  cleanup = page.render(el) ?? undefined;
}

for (const p of pages) {
  const a = document.createElement('a');
  a.href = `#/${p.path}`;
  a.textContent = p.title;
  nav.append(a);
}

window.addEventListener('hashchange', route);
route();
