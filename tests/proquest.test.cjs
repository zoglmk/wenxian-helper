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
  const renderFooter = context.updateFooter;
  vm.runInContext('papers = initial; renderList = () => {}; restoreChecks = () => {}; updateFooter = () => {}; updateCardState = () => {};', context);
  context.addLog = (...args) => logs.push(args);
  const setState = context.setDownloadState;
  context.setDownloadState = (...args) => { statuses.push(args); setState(...args); };
  context.waitForDownloadById = async id => { assert.equal(id, 42); return 'success'; };
  context.resolveProquestPaper = async p => ({ paper: { ...p, pdfReady: true }, pdfUrl: 'https://media.proquest.com/media/hms/PFT/fresh?_s=new%2Fsignature' });
  return { context, state, calls, chrome, logs, statuses, el, renderFooter };
}

test('添加本页的真实点击处理显示累计 40 和本次新增 20，重复添加保持累计数', async () => {
  const h = harness([]);
  h.context.updateFooter = h.renderFooter;
  h.context.ensureContentScript = async () => true;
  let page = 0;
  h.context.sendToContent = async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: page * 20 + i, title: `文献 ${page}-${i}`, detailUrl: `https://kns.cnki.net/detail/${page}/${i}` }));
    const result = await h.context.store.update({ action: 'add', epoch: 0, items });
    // 故意不发 storage.onChanged，验证回复与存储通知顺序不影响累计数。
    return { ok: true, added: result.added, total: 20 };
  };
  h.context.bindEvents();
  await h.el('#btn-add-page').listeners.click();
  assert.match(h.el('#footer-status').textContent, /共 20 篇.*本次新增 20 篇/);
  page = 1;
  await h.el('#btn-add-page').listeners.click();
  assert.equal(h.el('#list-count').textContent, '40 篇');
  assert.match(h.el('#footer-status').textContent, /共 40 篇.*本次新增 20 篇/);
  await h.el('#btn-add-page').listeners.click();
  assert.match(h.el('#footer-status').textContent, /共 40 篇.*本次新增 0 篇/);
  assert.match(h.el('#footer-status').textContent, /已在清单/);
});

// 选择器对应真实公开期刊的 jnlArticle / 开放阅览标记；浏览器用例另验证实际 DOM。
function journalDoc({ access = 'open', detail = true, id = '3268524212', download = ['open', 'available'].includes(access) } = {}) {
  const node = (textContent, attrs = {}) => ({ textContent, getAttribute: name => attrs[name] || '' });
  const title = node('Public journal article', { href: `/docview/${id}/SESSION/1` });
  const authors = node('Cheng, Zhuo; Lu, Xiaoping; 等.');
  const fullAuthors = node('Cheng, Zhuo; Lu, Xiaoping; Long, Chunlin.');
  const publication = node('People and Nature; London Vol. 7, Iss. 11, (Nov 1, 2025): 2700-2713.');
  const label = node(access === 'preview' ? '提供预览' : '全文文献', access === 'open' ? { title: '开放阅览', 'aria-label': '开放阅览' } : {});
  const pdf = node('下载 PDF', { title: access === 'preview' ? 'Download preview' : '下载 PDF', href: 'https://media.proquest.com/media/journal?_s=fresh' });
  const root = {
    querySelector: selector => {
      if (selector.includes('h1.documentTitle')) return detail ? title : null;
      if (selector.includes('h3 a')) return title;
      if (selector.includes('moreAuthors_')) return detail ? fullAuthors : null;
      if (selector === '.jnlArticle strong') return node('People and Nature');
      if (selector.includes('.jnlArticle')) return publication;
      return null;
    },
    querySelectorAll: selector => {
      if (selector.includes('.scholUnivAuthors')) return [authors];
      if (selector.startsWith('a.pdf-download')) return detail && download ? [pdf] : [];
      if (selector.includes('.format-display')) return [label];
      return [];
    },
  };
  return root;
}

test('实际期刊的开放阅览标记可解析全文 PDF，并提取期刊元数据而非学位论文', () => {
  const h = harness(), api = h.context.ProQuest;
  const { paper: p, pdfUrl } = api.parseDetail(journalDoc(), 'https://www.proquest.com/docview/3268524212');
  assert.equal(p.proquestAccess, 'open'); assert.equal(p.pdfReady, true);
  assert.equal(p.docType, 'J'); assert.equal(p.source, 'People and Nature');
  assert.equal(p.author, 'Zhuo Cheng;Xiaoping Lu;Chunlin Long');
  assert.equal(p.date, '2025'); assert.equal(p.volume, '7'); assert.equal(p.issue, '11'); assert.equal(p.pages, '2700-2713');
  assert.match(pdfUrl, /_s=fresh$/); assert.equal(p.pdfLink, '');
  assert.match(h.context.formatBibTeX(p), /^@article/);
  assert.match(h.context.formatBibTeX(p), /journal = \{People and Nature\}/);
  assert.doesNotMatch(h.context.formatBibTeX(p), /Thesis|school =/);
  assert.match(h.context.formatRIS(p), /TY  - JOUR/);
});

test('全文期刊结果可先收藏待确认，预览排除；全文字样本身不授予下载资格', () => {
  const h = harness(), api = h.context.ProQuest;
  const rows = [journalDoc({ access: 'unknown', detail: false }), journalDoc({ access: 'preview', detail: false, id: '222' })];
  const collected = api.collect({ querySelectorAll: () => rows }, 'https://www.proquest.com/resultsol/session/1');
  assert.equal(collected.entries.length, 1); assert.equal(collected.skipped, 1);
  assert.equal(collected.entries[0].paper.docType, 'J');
  assert.equal(collected.entries[0].paper.proquestAccess, 'unknown');
  assert.equal(h.context.canDownloadPaper(collected.entries[0].paper), false);
  for (const access of ['unknown', 'preview']) {
    const parsed = api.parseDetail(journalDoc({ access }), 'https://www.proquest.com/docview/3268524212');
    assert.equal(parsed.paper.proquestAccess, access);
    assert.equal(parsed.pdfUrl, ''); assert.equal(parsed.paper.pdfReady, false);
  }
});

test('当前会话的全文标记与有效 PDF 入口可确认权限，预览优先排除', () => {
  const h = harness(), api = h.context.ProQuest;
  const parsed = api.parseDetail(journalDoc({ access: 'available' }), paper().detailUrl);
  assert.equal(parsed.paper.proquestAccess, 'available');
  assert.equal(h.context.canDownloadPaper(parsed.paper), true);
  assert.ok(parsed.pdfUrl);
  const preview = api.parseDetail(journalDoc({ access: 'preview', download: true }), paper().detailUrl);
  assert.equal(preview.paper.proquestAccess, 'preview'); assert.equal(preview.pdfUrl, '');
});

test('已获全文权限文献每次下载仍重查，登录失效后不能复用旧链接', async () => {
  const h = harness([{ ...paper(), proquestAccess: 'available' }]); let parses = 0;
  h.context.resolveProquestPaper = async p => {
    parses++;
    return parses === 1
      ? { paper: { ...p, pdfReady: true }, pdfUrl: 'https://media.proquest.com/media/file?_s=authorized' }
      : { paper: { ...p, proquestAccess: 'unknown', pdfReady: false, proquestReason: '未确认全文下载权限' }, pdfUrl: '' };
  };
  assert.equal(await h.context.downloadPaper(paper().id), 'success');
  assert.equal(await h.context.downloadPaper(paper().id), 'skipped');
  assert.equal(h.calls.filter(c=>c.type==='SAVE_DOWNLOAD').length, 1);
  assert.equal(h.context.canDownloadPaper(h.state.cnkiPapers[0]), false);
});

// 使用真实事件绑定、队列与状态更新；只替换详情网络和 Chrome 文件 API。
function retryHarness(access = "open") {
  const h = harness([{ ...paper(), proquestAccess: access }, { ...paper('222'), pdfFailed: true, pdfReady: false }]);
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

for (const access of ['open', 'available']) {
test(`卡片重试经过事件与队列，${access} 缺链接时重新解析并下载，仅处理指定文献`, async () => {
  const h = retryHarness(access);
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
}

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

test('新站点是独立来源，预览或未确认权限的记录不能进入下载队列', () => {
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

test('通用请求的匿名选项不带 Cookie，普通请求仍带 Cookie', async () => {
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

test('ProQuest 期刊及学位论文均使用当前会话并禁用缓存，权限由每次详情与文件校验决定', async () => {
  const h = harness(), source = read('background.js'), calls = [];
  let listener;
  h.context.AbortController = AbortController;
  h.context.fetch = async (url, options) => {
    calls.push(options); return { ok: true, status: 200, text: async () => 'fixture', url };
  };
  h.chrome.runtime.onMessage = { addListener: fn => { listener = fn; } };
  vm.runInContext(source.slice(source.indexOf('async function handleFetchText'), source.indexOf('// 只读取文件头')), h.context);
  vm.runInContext(source.slice(source.indexOf('chrome.runtime.onMessage.addListener')), h.context);
  const send = docType => new Promise(resolve => listener({ type: 'FETCH_PROQUEST_DOCUMENT', url: paper().detailUrl, docType }, {}, resolve));
  assert.equal((await send('J')).ok, true);
  assert.equal((await send('D')).ok, true);
  assert.equal(calls[0].credentials, 'include'); assert.equal(calls[0].cache, 'no-store');
  assert.equal(calls[1].credentials, 'include'); assert.equal(calls[1].cache, 'no-store');
});
