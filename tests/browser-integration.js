// 仅在独立测试配置中运行：会清空测试清单和修改测试域名设置。
// 页面与 DOI 响应由 browser-fixture.py 提供；不得在日常浏览器中执行。
async (panel) => {
  const context = panel.context();
  const results = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const control = async (query) => {
    const response = await context.request.get(`http://127.0.0.1:18580/control?${query}`);
    assert(response.ok(), 'Fixture control failed');
  };
  const clear = async () => {
    await panel.getByRole('button', { name: '批量下载', exact: true }).click();
    if (await panel.locator('#btn-clear').isVisible()) await panel.locator('#btn-clear').click();
    await panel.waitForFunction(() => papers.length === 0);
  };
  const downloads = () => panel.evaluate(() => chrome.downloads.search({}));
  // Playwright 的浏览器内轮询不能直接用返回 Promise 的谓词判断完成。
  const until = async (predicate) => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('Native browser operation timed out');
      await panel.waitForTimeout(100);
    }
  };
  const waitForComplete = async (url, afterId) => {
    await until(async () => (await downloads()).some(item => item.id > afterId && item.url === url && item.state === 'complete'));
    return (await downloads()).filter(item => item.id > afterId && item.url === url).sort((a, b) => b.id - a.id)[0];
  };

  await control('fail=false&delay=0&validPdf=false');
  await clear();
  // 已有授权来自独立测试配置中实际确认过的 Chrome 权限；本轮验证完整地址输入。
  if (!await panel.locator('#input-proxy-domain').isVisible()) await panel.locator('.proxy-settings summary').click();
  await panel.locator('#input-proxy-domain').fill('https://library.hb.cn:18543/some/path?ticket=fixture#part');
  await panel.locator('#btn-add-proxy').click();
  await until(() => panel.evaluate(async () => (await chrome.storage.local.get('cnkiProxyDomains')).cnkiProxyDomains?.includes('library.hb.cn')));
  const scripts = await panel.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert(scripts.some(script => script.matches.includes('*://*.library.hb.cn/*')), 'Wildcard registration failed');
  results.push({ case: 'full-url-domain-extraction', matches: scripts[0].matches });
  if (!await panel.locator('#input-folder').isVisible()) await panel.locator('.folder-settings summary').click();
  await panel.locator('#input-folder').fill('integration');
  await panel.locator('#btn-save-folder').click();
  await panel.evaluate(async () => {
    settings.fetchLevels = false;
    settings.autoOpenOnVerify = false;
    await chrome.storage.local.set({ fetchLevels: false, autoOpenOnVerify: false });
  });

  const cases = [
    ['direct', 'https://kns.cnki.net:18543', false],
    ['education', 'http://webvpn.school.edu.cn:18580', true],
    ['proxy-root', 'https://library.hb.cn:18543', true],
    ['proxy-http', 'http://ycfw.library.hb.cn:18580', true],
    ['proxy-https', 'https://alias.library.hb.cn:18543', true],
  ];
  for (const [name, origin, webvpn] of cases) {
    await clear();
    await panel.evaluate(async value => {
      settings.useWebVPN = value;
      await chrome.storage.local.set({ useWebVPN: value });
    }, webvpn);
    const sample = await context.newPage();
    await sample.goto(`${origin}/${name}/search`);
    await sample.locator('.cnki-h-btn').click();
    await panel.bringToFront();
    await panel.waitForFunction(() => papers.length === 1);
    assert(await panel.evaluate(() => papers[0].author === 'Original Author'), `${name}: collection author`);
    await panel.evaluate(() => fetchPdfLinks());
    const paper = await panel.evaluate(() => papers[0]);
    assert(paper.pdfLink === `${origin}/${name}/redirect`, `${name}: link or port changed: ${JSON.stringify(paper)}`);
    assert(paper.author === 'First Author;Second Author' && paper.pages === '45-52', `${name}: metadata`);
    // 侧边栏用独立页面模拟，保持前台以免 Chrome 对测试页计时器降频。
    await panel.bringToFront();
    const afterId = Math.max(0, ...(await downloads()).map(item => item.id));
    const downloading = panel.evaluate(() => downloadPaper(papers[0].id));
    if (origin.startsWith('http:')) {
      await until(async () => (await downloads()).some(item => item.id > afterId && item.url === paper.pdfLink));
      const downloadPage = await context.newPage();
      await downloadPage.goto('chrome://downloads/');
      const item = downloadPage.locator('downloads-item').first();
      // 仅放行本地生成、无脚本的 PDF；保持 Chrome 全局安全设置不变。
      await item.getByRole('button', { name: '更多操作' }).click();
      await item.getByRole('menuitem', { name: '下载不安全的文件' }).click();
      await downloadPage.close();
      await panel.bringToFront();
    }
    const outcome = await downloading;
    assert(outcome === 'success', `${name}: ${outcome}; ${await panel.evaluate(() => JSON.stringify(logs))}`);
    const item = await waitForComplete(paper.pdfLink, afterId);
    assert(item.finalUrl === `${origin}/${name}/download`, `${name}: redirect URL`);
    assert(item.filename.includes('/integration/'), `${name}: folder ${item.filename}`);
    results.push({ case: name, state: item.state, url: item.url, filename: item.filename,
      browserHttpConfirmation: origin.startsWith('http:') });
    await sample.close();
  }

  // 无 PDF 也可选择导出；取消选择在排序、重载和解析后仍保留。
  await clear();
  const sample = await context.newPage();
  const origin = 'https://kns.cnki.net:18543';
  await sample.goto(`${origin}/state/search`);
  await sample.locator('.cnki-h-btn').click();
  await panel.bringToFront();
  await panel.waitForFunction(() => papers.length === 1);
  await panel.locator('.paper-card label.check').click();
  await panel.waitForFunction(() => papers[0]?.selected === false);
  await panel.getByRole('button', { name: '时间', exact: true }).click();
  assert(!await panel.locator('.paper-check').isChecked(), 'Sort lost selection');
  await panel.reload();
  await panel.locator('.paper-card').waitFor();
  assert(!await panel.locator('.paper-check').isChecked(), 'Reload lost selection');
  await panel.locator('.paper-card label.check').click();
  await panel.waitForFunction(() => papers[0]?.selected === true);
  const beforeExport = (await downloads()).map(item => item.id);
  // Headless 无原生“另存为”对话框；测试中只把导出的 saveAs 改为自动保存。
  // Chrome 下载及文件名事件仍使用真实实现，其他请求不变。
  await panel.evaluate(async () => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) => {
      if (message.type === 'SAVE_DOWNLOAD' && message.saveAs) {
        window.exportRequest = message;
        return original({ ...message, saveAs: false }, ...rest);
      }
      return original(message, ...rest);
    };
    try { await doExport('csv'); }
    finally { chrome.runtime.sendMessage = original; }
  });
  await until(async () => (await downloads()).some(
    item => !beforeExport.includes(item.id) && item.state === 'complete' && item.filename.endsWith('.csv')));
  const exported = (await downloads()).find(item => !beforeExport.includes(item.id));
  const exportRequest = await panel.evaluate(() => window.exportRequest);
  assert(exportRequest.saveAs === true, 'Product export stopped requesting Save As');
  assert(exported.filename.endsWith('/' + exportRequest.filename) || exported.filename.includes(exportRequest.filename.replace('.csv', ' (')), 'Export filename lost');
  assert(!exported.filename.includes('/integration/'), 'Export inherited paper download folder');
  await control('fail=true');
  await panel.evaluate(() => fetchPdfLinks());
  await panel.waitForFunction(() => papers[0]?.pdfFailed === true);
  await control('fail=false');
  await panel.evaluate(() => fetchPdfLinks());
  await panel.waitForFunction(() => !!papers[0]?.pdfLink && !papers[0].pdfFailed);
  results.push({ case: 'selection-export-retry', filename: exported.filename });

  // 验证码不报成功；解除等待后，其他下载不能继承文献子目录。
  await panel.evaluate(async () => patchPaper(papers[0], { pdfLink: papers[0].pdfLink.replace('/redirect', '/verify') }));
  await panel.bringToFront();
  const verification = await panel.evaluate(() => downloadPaper(papers[0].id));
  assert(verification === 'verify', `Verification page classification: ${verification}`);
  const unrelated = await panel.evaluate(async () => {
    const id = await chrome.downloads.download({ url: 'https://kns.cnki.net:18543/unrelated/download', filename: 'unrelated.pdf' });
    return id;
  });
  await until(async () => (await downloads()).some(item => item.id === unrelated && item.state === 'complete'));
  const unrelatedItem = (await downloads()).find(item => item.id === unrelated);
  assert(!unrelatedItem.filename.includes('/integration/'), 'Unrelated download inherited folder');
  results.push({ case: 'verification-and-folder-cleanup', filename: unrelatedItem.filename });

  // 旧解析请求确实到达本地服务后再清空，返回结果不能复活条目。
  await panel.evaluate(async () => patchPaper(papers[0], { pdfLink: '', pdfFailed: true }));
  await control('delay=2');
  const beforeRequests = (await (await context.request.get('http://127.0.0.1:18580/requests')).json()).length;
  const fetching = panel.evaluate(() => fetchPdfLinks());
  for (let attempt = 0; attempt < 30; attempt++) {
    const requests = await (await context.request.get('http://127.0.0.1:18580/requests')).json();
    if (requests.slice(beforeRequests).some(request => request.path === '/state/kcms/detail')) break;
    if (attempt === 29) throw new Error('Delayed fetch did not start');
    await panel.waitForTimeout(100);
  }
  await clear();
  await fetching;
  await control('delay=0');
  assert(await panel.evaluate(async () => papers.length === 0 && (await chrome.storage.local.get('cnkiPapers')).cnkiPapers.length === 0), 'Clear resurrected records');
  await sample.close();
  results.push({ case: 'clear-during-fetch', empty: true });

  await panel.getByRole('button', { name: 'DOI导入', exact: true }).click();
  await panel.locator('#doi-input').fill('10.1234/browserfixture');
  await panel.locator('#btn-doi-import').click();
  await panel.waitForFunction(() => !importingDois && papers.length === 1);
  assert(await panel.evaluate(() => papers[0].pdfFailed && !papers[0].pdfLink && papers[0].author === 'John Q. Smith'), 'Invalid PDF or DOI author');
  await panel.getByRole('button', { name: '批量下载', exact: true }).click();
  assert(await panel.locator('.paper-title b').count() === 0, 'Title interpreted as HTML');
  assert(await panel.locator('.paper-title').textContent() === '<b>DOI fixture</b>', 'Title text changed');
  await panel.locator('.paper-card label.check').click();
  await panel.waitForFunction(() => papers[0]?.selected === false);
  await control('validPdf=true');
  await panel.getByRole('button', { name: 'DOI导入', exact: true }).click();
  await panel.locator('#btn-doi-import').click();
  await panel.waitForFunction(() => !importingDois && !!papers[0]?.pdfLink);
  assert(await panel.evaluate(() => papers.length === 1 && papers[0].selected === false), 'DOI retry duplicated/reset record');
  assert((await panel.locator('#doi-count').textContent()).includes('更新 1 篇'), 'DOI update count');
  const doiUrl = await panel.evaluate(() => papers[0].pdfLink);
  const beforeDoiDownload = Math.max(0, ...(await downloads()).map(item => item.id));
  assert(await panel.evaluate(() => downloadPaper(papers[0].id)) === 'success', 'DOI download failed');
  const doiItem = await waitForComplete(doiUrl, beforeDoiDownload);
  assert(doiItem.filename.includes('/integration/'), `DOI folder: ${doiItem.filename}`);
  results.push({ case: 'doi-retry-safe-text-download', state: doiItem.state, filename: doiItem.filename });

  const portal = await context.newPage();
  await portal.goto('https://library.hb.cn:18543/portal');
  assert(await portal.locator('.cnki-h-btn').count() === 0, 'Portal misidentified as CNKI');
  await portal.close();
  await panel.getByRole('button', { name: '批量下载', exact: true }).click();
  await panel.setViewportSize({ width: 430, height: 930 });
  await panel.screenshot({ path: 'output/playwright/integration-final.png' });
  await panel.evaluate(value => { window.integrationResults = value; }, results);
  console.log(JSON.stringify(results, null, 2));
}
