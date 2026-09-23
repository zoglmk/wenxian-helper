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
    if (!elements.has(selector)) elements.set(selector, { textContent: '', hidden: false, style: {}, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; } });
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
    storage: { onChanged: { addListener() {} }, local: { get: async () => clone(state), set: async values => Object.assign(state, clone(values)) } } };
  context = vm.createContext({ chrome, URL, crypto, console, setTimeout: fn => setTimeout(fn, 0), clearTimeout,
    document: { querySelector: el, querySelectorAll: () => [], createElement: () => ({ dataset: {}, innerHTML: '' }) } });
  vm.runInContext(read('proquest.js'), context);
  vm.runInContext(read('paper-store.js') + '\nthis.store = PaperStore;', context);
  vm.runInContext(read('sidepanel/index.js').replace(/\ninit\(\);\s*$/, '\n'), context);
  context.initial = clone(initial);
  vm.runInContext('papers = initial; renderList = () => {}; restoreChecks = () => {}; updateFooter = () => {}; updateCardState = () => {};', context);
  context.addLog = (...args) => logs.push(args);
  const setState = context.setDownloadState;
  context.setDownloadState = (...args) => { statuses.push(args); setState(...args); };
  context.waitForDownloadById = async id => { assert.equal(id, 42); return 'success'; };
  context.resolveProquestPaper = async p => ({ paper: { ...p, pdfReady: true }, pdfUrl: 'https://media.proquest.com/media/hms/PFT/fresh?_s=new%2Fsignature' });
  return { context, state, calls, chrome, logs, statuses, el };
}

// 使用真实事件绑定、队列与状态更新；只替换详情网络和 Chrome 文件 API。
function retryHarness() {
  const h = harness([paper(), { ...paper('222'), pdfFailed: true, pdfReady: false }]);
  h.context.bindEvents();
  h.click = (selector, id = paper().id) => h.el('#paper-list').listeners.click({
    target: { closest: match => match === selector ? { dataset: { id: String(id) } } : null },
  });
  h.button = selector => h.el(selector).listeners.click();
  h.idle = async () => {
    for (let n = 0; n < 100; n++) {
      await new Promise(resolve => setTimeout(resolve, 1));
      if (vm.runInContext('!downloadQueueBusy && !downloadBusy && !fetchingLinks', h.context)) return;
    }
    assert.fail('retry queue did not become idle');
  };
  h.currentStatus = () => vm.runInContext(`downloadState[${paper().id}]?.status`, h.context);
  h.missing = p => ({ paper: { ...p, pdfReady: false, pdfFailed: true, proquestReason: '公开论文暂未提供有效 PDF 链接' }, pdfUrl: '' });
  h.failFirst = async () => {
    h.context.resolveProquestPaper = async p => h.missing(p);
    h.click('.dl-btn');
    await h.idle();
    assert.equal(h.state.cnkiPapers[0].pdfReady, false);
    assert.equal(h.currentStatus(), 'error');
    assert.match(h.context.renderAction(paper().id), /retry-btn/);
  };
  return h;
}

test('卡片重试经过事件与队列，公开但缺链接时重新解析并下载，仅处理指定文献', async () => {
  const h = retryHarness();
  await h.failFirst();
  const parsed = [];
  h.context.resolveProquestPaper = async p => {
    parsed.push(p.id);
    return { paper: { ...p, pdfReady: true, pdfFailed: false }, pdfUrl: 'https://media.proquest.com/media/file?_s=retry-fresh' };
  };
  h.click('.retry-btn');
  await h.idle();
  assert.deepEqual(parsed, [paper().id]);
  assert.equal(h.currentStatus(), 'success');
  assert.equal(h.state.cnkiPapers[0].pdfReady, true);
  assert.equal(h.state.cnkiPapers[1].pdfReady, false);
  assert.deepEqual(h.calls.filter(c => c.type === 'SAVE_DOWNLOAD').map(c => c.url), ['https://media.proquest.com/media/file?_s=retry-fresh']);
});

for (const access of ['preview', 'unknown']) {
  test(`卡片重试重新解析为 ${access} 时显示跳过原因，不探测或下载文件`, async () => {
    const h = retryHarness(); await h.failFirst(); let parses = 0;
    h.context.resolveProquestPaper = async p => {
      parses++;
      return { paper: { ...p, pdfReady: false, proquestAccess: access, proquestReason: `跳过 ${access}` }, pdfUrl: '' };
    };
    h.click('.retry-btn'); await h.idle();
    assert.equal(parses, 1);
    assert.equal(h.currentStatus(), 'skipped');
    assert.match(h.context.renderAction(paper().id), new RegExp(`跳过 ${access}`));
    assert.ok(!h.calls.some(c => ['FETCH_PDF_INFO', 'SAVE_DOWNLOAD'].includes(c.type)));
  });
}

test('连续点击卡片与批量重试共享互斥，不重复解析或下载', async () => {
  const h = retryHarness(); await h.failFirst(); let finish, parses = 0;
  h.context.resolveProquestPaper = p => { parses++; return new Promise(resolve => { finish = () => resolve({ paper: { ...p, pdfReady: true }, pdfUrl: 'https://media.proquest.com/media/file?_s=once' }); }); };
  h.click('.retry-btn'); h.click('.retry-btn');
  const batch = h.button('#btn-retry-failed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(parses, 1);
  finish(); await batch; await h.idle();
  assert.equal(parses, 1);
  assert.equal(h.calls.filter(c => c.type === 'SAVE_DOWNLOAD').length, 1);
});

test('卡片重试解析中通过清空按钮清单失效，迟到结果不写回或启动下载', async () => {
  const h = retryHarness(); await h.failFirst(); let finish;
  h.context.resolveProquestPaper = p => new Promise(resolve => { finish = () => resolve({ paper: { ...p, pdfReady: true }, pdfUrl: 'https://media.proquest.com/media/file?_s=late' }); });
  h.click('.retry-btn');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, 'function', 'retry must request detail before clear');
  await h.button('#btn-clear'); finish(); await h.idle();
  assert.deepEqual(h.state.cnkiPapers, []);
  assert.equal(h.currentStatus(), undefined);
  assert.ok(!h.calls.some(c => c.type === 'SAVE_DOWNLOAD'));
});

test('重试详情再次失败保留失败和重试入口，之后仍可恢复', async () => {
  const h = retryHarness(); await h.failFirst(); let parses = 0;
  h.context.resolveProquestPaper = async () => { parses++; throw new Error('详情请求失败'); };
  h.click('.retry-btn'); await h.idle();
  assert.equal(parses, 1);
  assert.equal(h.currentStatus(), 'error');
  assert.match(h.context.renderAction(paper().id), /retry-btn/);
  h.context.resolveProquestPaper = async p => ({ paper: { ...p, pdfReady: true }, pdfUrl: 'https://media.proquest.com/media/file?_s=recovered' });
  h.click('.retry-btn'); await h.idle();
  assert.equal(h.currentStatus(), 'success');
});

test('批量失败重试每篇只刷新一次详情，沿用同一公开状态校验及下载流程', async () => {
  const h = retryHarness(); await h.failFirst(); const parsed = [];
  h.context.resolveProquestPaper = async p => {
    parsed.push(p.id);
    return { paper: { ...p, pdfReady: true, pdfFailed: false }, pdfUrl: `https://media.proquest.com/media/${p.id}?_s=fresh` };
  };
  await h.button('#btn-retry-failed'); await h.idle();
  assert.deepEqual(parsed, [paper().id, 222]);
  assert.equal(h.calls.filter(c => c.type === 'SAVE_DOWNLOAD').length, 2);
  assert.equal(h.currentStatus(), 'success');
});

test('批量重试连续失败暂停后，继续下载仍能解析剩余公开论文', async () => {
  const h = retryHarness(); await h.failFirst();
  await h.context.mutatePapers('add', { items: [{ ...paper('333'), pdfFailed: true, pdfReady: false }] });
  const parsed = [];
  h.context.resolveProquestPaper = async p => { parsed.push(p.id); return h.missing(p); };
  await h.button('#btn-retry-failed'); await h.idle();
  assert.deepEqual(parsed, [paper().id, 222]);
  assert.equal(h.el('#btn-resume').hidden, false);
  h.context.resolveProquestPaper = async p => {
    parsed.push(p.id);
    return { paper: { ...p, pdfReady: true }, pdfUrl: 'https://media.proquest.com/media/file?_s=resume' };
  };
  await h.button('#btn-resume'); await h.idle();
  assert.deepEqual(parsed, [paper().id, 222, 333]);
  assert.equal(h.calls.filter(c => c.type === 'SAVE_DOWNLOAD').length, 1);
});

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
