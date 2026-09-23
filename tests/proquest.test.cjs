const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const read = name => fs.readFileSync(`extension/${name}`, 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const paper = (id = '3343567210') => ({ id: Number(id), _instance: id, provider: 'proquest', proquestId: id,
  detailUrl: `https://www.proquest.com/docview/${id}`, title: 'Public thesis', author: 'John R. Hammer',
  docType: 'D', proquestAccess: 'open', pdfReady: true, pdfLink: '' });

function harness(initial = [paper()]) {
  const state = { cnkiPapers: clone(initial), cnkiPapersEpoch: 0 };
  const elements = new Map(), calls = [], logs = [], statuses = [];
  const el = selector => {
    if (!elements.has(selector)) elements.set(selector, { textContent: '', hidden: false, style: {} });
    return elements.get(selector);
  };
  let context;
  const chrome = { runtime: { getManifest: () => ({ version: '1.3.0' }), sendMessage: async message => {
    calls.push(message);
    if (message.type === 'PAPER_STORE') return context.store.update(message);
    if (message.type === 'FETCH_PDF_INFO') return { ok: true, isPdf: true };
    if (message.type === 'SAVE_DOWNLOAD') return { ok: true, downloadId: 42 };
    throw new Error(message.type);
  } }, downloads: { search: async () => [{ id: 42, state: 'complete', mime: 'application/pdf' }] },
    storage: { local: { get: async () => clone(state), set: async values => Object.assign(state, clone(values)) } } };
  context = vm.createContext({ chrome, URL, crypto, console, setTimeout, clearTimeout,
    document: { querySelector: el, querySelectorAll: () => [], createElement: () => ({ dataset: {}, innerHTML: '' }) } });
  vm.runInContext(read('proquest.js'), context);
  vm.runInContext(read('paper-store.js') + '\nthis.store = PaperStore;', context);
  vm.runInContext(read('sidepanel/index.js').replace(/\ninit\(\);\s*$/, '\n'), context);
  context.initial = clone(initial);
  vm.runInContext('papers = initial; renderList = () => {}; restoreChecks = () => {}; updateFooter = () => {};', context);
  context.addLog = (...args) => logs.push(args);
  context.setDownloadState = (...args) => statuses.push(args);
  context.waitForDownloadById = async id => { assert.equal(id, 42); return 'success'; };
  context.resolveProquestPaper = async p => ({ paper: { ...p, pdfReady: true }, pdfUrl: 'https://media.proquest.com/media/hms/PFT/fresh?_s=new%2Fsignature' });
  return { context, state, calls, chrome, logs, statuses, el };
}

test('ProQuest 文档按稳定 ID 去重，不保存搜索会话路径、查询参数或片段', () => {
  const { context: { ProQuest: api } } = harness();
  assert.equal(api.documentUrl('https://www.proquest.com/pqdtglobal/docview/123456/SESSION/1?accountid=123#pdf'), 'https://www.proquest.com/docview/123456');
  assert.equal(api.documentUrl('/docview/123456/SESSION/3', 'https://www.proquest.com/resultsol/x/1'), 'https://www.proquest.com/docview/123456');
  for (const url of ['https://proquest.com.evil.test/docview/1', 'javascript:alert(1)', 'https://user:pw@www.proquest.com/docview/1', 'https://www.proquest.com/docview/123fake']) assert.equal(api.documentUrl(url), '', url);
  const signed = 'https://media.proquest.com/media/hms/PFT/file?_s=abc%2Fdef&_a=a%2Bb';
  assert.equal(api.mediaUrl(signed), signed);
  assert.equal(api.mediaUrl('https://media.proquest.com.evil.test/media/test'), '');
});

test('公开标记与预览标记冲突时拒绝全文，全文按钮本身不证明开放获取', () => {
  const api = harness().context.ProQuest;
  const root = labels => ({ querySelectorAll: () => labels.map(text => ({ textContent: text, getAttribute: () => '' })) });
  assert.equal(api.access(root(['Download PDF'])), 'unknown');
  assert.equal(api.access(root(['公开论文'])), 'open');
  assert.equal(api.access(root(['This graduate work has been published as open access.'])), 'open');
  assert.equal(api.access(root(['Open access', 'Download preview'])), 'preview');
  assert.equal(api.access(root(['全文文献', '提供预览'])), 'preview');
});

test('跨页收藏、返回上一页重复添加，保留先前的取消勾选与链接状态', async () => {
  const h = harness([]), p1 = paper('111'), p2 = paper('222');
  await h.context.mutatePapers('add', { items: [p1] });
  const saved = h.state.cnkiPapers[0];
  await h.context.patchPaper(saved, { selected: false }, 0);
  await h.context.mutatePapers('add', { items: [p2, { ...p1, detailUrl: 'https://proquest.com/docview/111', selected: true, pdfReady: false }] });
  assert.equal(h.state.cnkiPapers.length, 2);
  assert.equal(h.state.cnkiPapers[0].selected, false);
  assert.equal(h.state.cnkiPapers[0].pdfReady, true);
  assert.deepEqual(Array.from(h.context.getSelectedIds()), [222]);
});

test('新站点是独立来源，预览或仅订阅全文不能进入本版下载队列', () => {
  const { context: c } = harness();
  assert.equal(c.isDoiPaper({ ...paper(), doi: '10.1234/test' }), false);
  assert.equal(c.canDownloadPaper(paper()), true);
  assert.equal(c.canDownloadPaper({ ...paper(), proquestAccess: 'preview', pdfLink: 'https://media.proquest.com/media/preview' }), false);
  assert.equal(c.canDownloadPaper({ ...paper(), proquestAccess: 'subscription' }), false);
  assert.equal(c.canDownloadPaper({ pdfLink: 'https://kns.cnki.net/pdf' }), true);
  assert.equal(c.canDownloadPaper({ pdfSource: 'Unpaywall', pdfLink: 'https://oa/pdf' }), true);
});

test('ProQuest 每次下载重新解析签名，按指定 ID 完成；不触发知网请求、不保存签名', async () => {
  const h = harness(); let resolves = 0;
  h.context.resolveProquestPaper = async p => ({ paper: { ...p, pdfReady: true }, pdfUrl: `https://media.proquest.com/media/hms/PFT/file?_s=fresh${++resolves}` });
  assert.equal(await h.context.downloadPaper(paper().id), 'success');
  assert.equal(await h.context.downloadPaper(paper().id), 'success');
  assert.deepEqual(h.calls.filter(c => c.type === 'SAVE_DOWNLOAD').map(c => c.url.split('?')[1]), ['_s=fresh1', '_s=fresh2']);
  assert.equal(h.calls.filter(c => c.type === 'SAVE_DOWNLOAD').every(c => c.useFolder && c.filename === 'Public thesis.pdf'), true);
  assert.ok(!JSON.stringify(h.state).includes('_s='));
  assert.ok(!h.calls.some(c => ['MARK_DOWNLOAD', 'FETCH_TEXT', 'FETCH_POST'].includes(c.type)));
});

test('刷新详情后变为预览时，不探测或下载媒体文件，旧可下载状态清除', async () => {
  const h = harness();
  h.context.resolveProquestPaper = async p => ({ paper: { ...p, pdfReady: false, proquestAccess: 'preview', proquestReason: '仅提供预览，本版跳过' }, pdfUrl: '' });
  assert.equal(await h.context.downloadPaper(paper().id), 'skipped');
  assert.equal(h.state.cnkiPapers[0].pdfReady, false);
  assert.ok(!h.calls.some(c => ['FETCH_PDF_INFO', 'SAVE_DOWNLOAD'].includes(c.type)));
});

test('下载前的非 PDF 响应被拒绝，日志不含带签名的媒体地址', async () => {
  const h = harness(), send = h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage = m => m.type === 'FETCH_PDF_INFO' ? { ok: true, isPdf: false } : send(m);
  assert.equal(await h.context.downloadPaper(paper().id), 'fail');
  assert.ok(!h.calls.some(c => c.type === 'SAVE_DOWNLOAD'));
  assert.ok(!JSON.stringify(h.logs).includes('_s='));
});

test('ProQuest 下载中断、超时以及实际落盘 HTML 不能显示完成', async () => {
  for (const outcome of ['interrupted', '下载完成等待超时', 'html']) {
    const h = harness();
    if (outcome === 'html') h.chrome.downloads.search = async () => [{ id: 42, mime: 'text/html' }];
    else h.context.waitForDownloadById = async () => outcome;
    assert.equal(await h.context.downloadPaper(paper().id), 'fail');
    assert.ok(!h.statuses.some(s => s[1] === 'success'));
  }
});

test('解析签名期间清空清单，旧任务不能启动下载或回写记录', async () => {
  const h = harness(); let finish;
  h.context.resolveProquestPaper = () => new Promise(resolve => { finish = resolve; });
  const pending = h.context.downloadPaper(paper().id);
  await h.context.mutatePapers('clear');
  finish({ paper: paper(), pdfUrl: 'https://media.proquest.com/media/file?_s=old' });
  assert.equal(await pending, 'cancelled');
  assert.deepEqual(h.state.cnkiPapers, []);
  assert.ok(!h.calls.some(c => c.type === 'SAVE_DOWNLOAD'));
});

test('ProQuest 学位论文导出不误标博士论文，仍可与知网混合导出', () => {
  const { context: c } = harness();
  const bib = c.formatBibTeX({ ...paper(), source: 'University of Pittsburgh', date: '2026' });
  assert.match(bib, /^@misc/);
  assert.match(bib, /type = \{Thesis\}/);
  assert.match(bib, /school = \{University of Pittsburgh\}/);
  assert.ok(!bib.includes('journal ='));
  assert.match(c.formatRIS(paper()), /TY  - THES/);
  assert.match(c.formatBibTeX({ title: '知网论文', source: '博士论文' }), /^@phdthesis/);
});

test('公开详情请求不带机构 Cookie，原知网请求仍带 Cookie', async () => {
  const source = read('background.js');
  const textFetch = source.slice(source.indexOf('async function handleFetchText'), source.indexOf('// 只读取文件头'));
  const calls = [];
  const c = vm.createContext({ AbortController, setTimeout, clearTimeout, fetch: async (url, options) => {
    calls.push(options); return { ok: true, status: 200, text: async () => 'html', url };
  } });
  vm.runInContext(textFetch, c);
  await c.handleFetchText({ url: paper().detailUrl, anonymous: true });
  await c.handleFetchText({ url: 'https://kns.cnki.net/detail' });
  assert.equal(calls[0].credentials, 'omit'); assert.equal(calls[0].cache, 'no-store');
  assert.equal(calls[1].credentials, 'include');
});
