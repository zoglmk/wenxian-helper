const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, 'extension', name), 'utf8');
const proxySource = read('proxy-domains.js');
const panelSource = read('sidepanel/index.js').replace(/\ninit\(\);\s*$/, '\n');
const clone = (value) => JSON.parse(JSON.stringify(value));
const domainA = 'ycfw.library.hb.cn';
const domainB = 'proxy.example.org';
const pattern = (host) => `*://*.${host}/*`;

function harness() {
  const data = {};
  const permissions = new Set();
  const registered = new Map();
  const calls = [];
  const chrome = {
    storage: { local: {
      get: async () => clone(data),
      set: async (value) => { Object.assign(data, clone(value)); },
    } },
    permissions: {
      contains: async ({ origins }) => origins.every((origin) => permissions.has(origin)),
      remove: async ({ origins }) => { origins.forEach((origin) => permissions.delete(origin)); return true; },
      request: async ({ origins }) => { calls.push(['request', origins]); return false; },
    },
    scripting: {
      getRegisteredContentScripts: async () => [...registered.values()],
      registerContentScripts: async (scripts) => {
        for (const script of scripts) {
          assert.equal(registered.has(script.id), false);
          registered.set(script.id, clone(script));
        }
      },
      updateContentScripts: async (scripts) => {
        for (const script of scripts) {
          assert.equal(registered.has(script.id), true);
          registered.set(script.id, clone(script));
        }
      },
      unregisterContentScripts: async ({ ids }) => ids.forEach((id) => registered.delete(id)),
      executeScript: async (args) => { calls.push(['execute', args]); return [{ result: { kind: 'no_onload' } }]; },
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => { throw new Error('No receiver'); },
    },
    runtime: { sendMessage: async (msg) => { calls.push(['message', msg]); return { ok: true, downloadId: 3 }; } },
    webNavigation: { onCommitted: {
      addListener: (fn) => calls.push(['nav-add', fn]),
      removeListener: (fn) => calls.push(['nav-remove', fn]),
    } },
  };
  const context = vm.createContext({ chrome, URL, console, setTimeout, clearTimeout });
  vm.runInContext(proxySource, context);
  const proxy = vm.runInContext('ProxyDomains', context);
  return { context, proxy, chrome, data, permissions, registered, calls };
}

test('完整网址只保存域名，保留端口和代理路径在原始文献 URL 中', () => {
  const { proxy } = harness();
  assert.equal(proxy.normalize(' https://YCFW.library.hb.cn:8000/vpn/1/https/ABC/?token=example '), domainA);
  assert.equal(proxy.normalize('ycfw.library.hb.cn:8000'), domainA);
  assert.equal(proxy.pattern(domainA), '*://*.ycfw.library.hb.cn/*');
  assert.equal(proxy.normalize('proxy.example.org.'), domainB);
  assert.equal(proxy.normalize('*.library.hb.cn'), 'library.hb.cn');
  assert.equal(proxy.normalize('https://*.library.hb.cn:8080/path'), 'library.hb.cn');
  assert.equal(proxy.matchesHost(domainA, 'library.hb.cn'), true);
  assert.equal(proxy.matchesHost('library.hb.cn.example.org', 'library.hb.cn'), false);
  assert.equal(proxy.matchesHost('evillibrary.hb.cn', 'library.hb.cn'), false);
});

test('拒绝全站或中间通配符、非网页协议、账号密码、不完整域名和已内置域名', () => {
  const { proxy } = harness();
  for (const input of ['', '*', 'proxy.*.hb.cn', '<all_urls>', 'localhost', 'https://',
    'javascript:alert(1)', 'file:///etc/passwd', 'ftp://proxy.example.org',
    'https://user:password@proxy.example.org', 'a b.cn', 'https://-bad.example.org',
    'https://kns.cnki.net/', 'https://webvpn.school.edu.cn:8000/', 'api.unpaywall.org', 'sci.bban.top']) {
    assert.throws(() => proxy.normalize(input), undefined, input);
  }
});

test('缺少授权时不写设置或注册脚本', async () => {
  const h = harness();
  await assert.rejects(h.proxy.update('add', domainA), /尚未获得/);
  assert.deepEqual(h.data, {});
  assert.equal(h.registered.size, 0);
});

test('添加、去重和多域名并发保存，动态脚本跨重启保留', async () => {
  const h = harness();
  h.permissions.add(pattern(domainA));
  h.permissions.add(pattern(domainB));
  await Promise.all([h.proxy.update('add', domainA), h.proxy.update('add', domainB), h.proxy.update('add', domainA)]);
  assert.deepEqual(h.data.cnkiProxyDomains, [domainA, domainB]);
  const script = [...h.registered.values()][0];
  assert.deepEqual(script.matches, [pattern(domainA), pattern(domainB)]);
  assert.deepEqual(script.js, ['content/main.js']);
  assert.equal(script.persistAcrossSessions, true);
  h.registered.clear();
  await h.proxy.update('sync');
  assert.equal(h.registered.size, 1);
});

test('移除一个域名仅撤销其权限；最后一个域名移除后注销动态脚本', async () => {
  const h = harness();
  for (const domain of [domainA, domainB]) {
    h.permissions.add(pattern(domain));
    await h.proxy.update('add', domain);
  }
  h.permissions.add('*://*.cnki.net/*');
  await h.proxy.update('remove', domainA);
  assert.equal(h.permissions.has(pattern(domainA)), false);
  assert.equal(h.permissions.has(pattern(domainB)), true);
  assert.equal(h.permissions.has('*://*.cnki.net/*'), true);
  assert.deepEqual(h.data.cnkiProxyDomains, [domainB]);
  await h.proxy.update('remove', domainB);
  assert.equal(h.registered.size, 0);
});

test('Chrome 外部撤销权限后同步清理；部分协议被撤销也不保留虚假启用状态', async () => {
  const h = harness();
  h.permissions.add(pattern(domainA));
  await h.proxy.update('add', domainA);
  h.permissions.clear();
  h.permissions.add(`https://${domainA}/*`);
  await h.proxy.update('sync');
  assert.deepEqual(h.data.cnkiProxyDomains, []);
  assert.equal(h.registered.size, 0);
});

test('注册失败向调用者报错，不记为保存成功，后续重试可恢复', async () => {
  const h = harness();
  h.permissions.add(pattern(domainA));
  const register = h.chrome.scripting.registerContentScripts;
  h.chrome.scripting.registerContentScripts = async () => { throw new Error('registration failed'); };
  await assert.rejects(h.proxy.update('add', domainA), /registration failed/);
  assert.deepEqual(h.data, {});
  h.chrome.scripting.registerContentScripts = register;
  await h.proxy.update('add', domainA);
  assert.deepEqual(h.data.cnkiProxyDomains, [domainA]);
});

test('拒绝未知操作，不能移除内置域名权限', async () => {
  const h = harness();
  await assert.rejects(h.proxy.update('clear', domainA), /未知/);
  await assert.rejects(h.proxy.update('remove', 'kns.cnki.net'), /内置/);
});

function panelHarness() {
  const h = harness();
  vm.runInContext(panelSource, h.context);
  return h;
}

test('只按主机名识别内置网址，路径与伪装后缀不能冒充知网', () => {
  const h = panelHarness();
  const isCnkiLikeUrl = h.context.isCnkiLikeUrl;
  for (const url of ['https://cnki.net/', 'https://kns.cnki.net/', 'https://webvpn.school.edu.cn:8000/vpn/abc']) {
    assert.equal(isCnkiLikeUrl(url), true, url);
  }
  for (const url of ['', undefined, 'https://example.org/?next=cnki.net', 'https://cnki.net.example.org/',
    'https://notedu.cn/', 'file://kns.cnki.net/test', 'https://ycfw.library.hb.cn:8000/']) {
    assert.equal(isCnkiLikeUrl(url), false, url);
  }
});

for (const url of ['https://kns.cnki.net/kns8s/', 'https://webvpn.school.edu.cn/vpn/abc']) {
  test(`原有活动页不增加探测，直接选择：${url}`, async () => {
    const h = panelHarness();
    h.chrome.tabs.query = async () => [{ id: 1, url }];
    assert.equal((await h.context.getCnkiTab()).id, 1);
    assert.equal(h.calls.length, 0);
  });
}

test('识别当前公共图书馆代理页，优先于其他已打开的知网页', async () => {
  const h = panelHarness();
  const active = { id: 2, url: `https://${domainA}:8000/vpn/1/https/ABC/` };
  h.chrome.tabs.query = async (query) => query.active ? [active] : [{ id: 1, url: 'https://kns.cnki.net/' }];
  h.chrome.tabs.sendMessage = async () => ({ ok: true, isCnki: true });
  assert.equal((await h.context.getCnkiTab()).id, 2);
});

test('没有权限或普通网页不冒充知网，保留原有标签页回退', async () => {
  const h = panelHarness();
  h.chrome.tabs.query = async (query) => query.active
    ? [{ id: 2, url: 'https://example.org/' }]
    : [{ id: 1, url: 'https://kns.cnki.net/' }];
  h.chrome.scripting.executeScript = async () => { throw new Error('No host permission'); };
  assert.equal((await h.context.getCnkiTab()).id, 1);
  h.chrome.tabs.query = async () => [];
  assert.equal(await h.context.getCnkiTab(), null);
});

test('可回退到已配置且内容识别成功的代理标签页', async () => {
  const h = panelHarness();
  h.data.cnkiProxyDomains = [domainA];
  h.chrome.tabs.query = async (query) => query.active ? [] : [{ id: 3, url: `https://${domainA}:8000/vpn/abc` }];
  h.chrome.tabs.sendMessage = async () => ({ ok: true, isCnki: true });
  assert.equal((await h.context.getCnkiTab()).id, 3);
});

for (const domain of ['kns.cnki.net', 'webvpn.school.edu.cn', 'ycfw.library.hb.cn:8000']) {
  test(`下载保留页面 MAIN world 的 iframe 和原始 PDF 地址：${domain}`, async () => {
    const h = panelHarness();
    const paper = { id: 1, title: '测试文献', detailUrl: `https://${domain}/vpn/abc/detail`, pdfLink: `https://${domain}/vpn/abc/download?token=example` };
    h.chrome.tabs.query = async () => [{ id: 7, url: paper.detailUrl }];
    h.chrome.tabs.sendMessage = async () => ({ ok: true, isCnki: true });
    h.context.fixture = paper;
    vm.runInContext('papers = [fixture]; setDownloadState = () => {}; waitForDownload = async () => "success";', h.context);
    assert.equal(await h.context.downloadPaper(1), 'success');
    const injection = h.calls.find(([type]) => type === 'execute')[1];
    assert.equal(injection.world, 'MAIN');
    assert.equal(injection.target.tabId, 7);
    assert.equal(injection.args[0], paper.pdfLink);
    assert.match(injection.func.toString(), /createElement\("iframe"\)/);
    assert.equal(h.calls.filter(([type]) => type === 'nav-add').length, 1);
    assert.equal(h.calls.filter(([type]) => type === 'nav-remove').length, 1);
  });
}

test('DOI 下载继续走 downloads API，不需要知网页面', async () => {
  const h = panelHarness();
  h.context.fixture = { id: 1, title: 'OA paper', pdfSource: 'unpaywall', pdfLink: 'https://oa.example.org/paper.pdf' };
  vm.runInContext('papers = [fixture]; setDownloadState = () => {}; waitForDownloadById = async () => "success";', h.context);
  await h.context.downloadPaper(1);
  assert.equal(h.calls.filter(([type]) => type === 'execute').length, 0);
  assert.equal(h.calls.find(([type, msg]) => type === 'message' && msg.type === 'SAVE_DOWNLOAD')[1].url, h.context.fixture.pdfLink);
});

test('用户拒绝授权时展示真实结果，不发送保存消息', async () => {
  const h = panelHarness();
  const elements = {
    '#input-proxy-domain': { value: domainA },
    '#proxy-status': { textContent: '' },
    '#btn-add-proxy': { disabled: false },
  };
  h.context.document = { querySelector: (selector) => elements[selector] };
  await h.context.addProxyDomain();
  assert.match(elements['#proxy-status'].textContent, /未获得授权/);
  assert.equal(elements['#btn-add-proxy'].disabled, false);
  assert.deepEqual(h.calls.map(([type]) => type), ['request']);
});

test('后台只接受扩展自身设置页的域名变更，拒绝网页内容脚本', async () => {
  const h = harness();
  let listener;
  const event = { addListener: () => {} };
  h.chrome.permissions.onRemoved = event;
  h.chrome.storage.onChanged = event;
  h.chrome.downloads = { onDeterminingFilename: event };
  h.chrome.sidePanel = { setPanelBehavior: async () => {} };
  h.chrome.runtime.id = 'test-extension';
  h.chrome.runtime.getURL = (url) => `chrome-extension://test-extension/${url}`;
  h.chrome.runtime.onMessage = { addListener: (fn) => { listener = fn; } };
  h.context.importScripts = () => {};
  h.context.AbortController = AbortController;
  vm.runInContext(read('background.js'), h.context);
  const send = (sender) => new Promise((resolve) => listener({type:'UPDATE_PROXY_DOMAIN',action:'add',domain:domainA}, sender, resolve));
  h.permissions.add(pattern(domainA));
  const denied = await send({id:'test-extension',url:'https://kns.cnki.net/',tab:{id:1}});
  assert.equal(denied.ok, false);
  assert.match(denied.error, /设置中修改/);
  const accepted = await send({id:'test-extension',url:h.chrome.runtime.getURL('sidepanel/index.html'),tab:{id:2}});
  assert.equal(accepted.ok, true);
  assert.deepEqual(h.data.cnkiProxyDomains, [domainA]);
});

test('扩展仅增加可选域名权限，保留原有自动匹配和下载权限', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.content_scripts[0].matches, ['*://*.cnki.net/*', '*://*.edu.cn/*']);
  assert.deepEqual(manifest.host_permissions, ['*://*.cnki.net/*', '*://*.edu.cn/*', '*://api.unpaywall.org/*', '*://sci.bban.top/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['*://*/*']);
});
