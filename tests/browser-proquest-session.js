// 仅使用独立浏览器与本地 fixture 的虚构 Cookie，不操作真实账号。
async panel => {
  const context = panel.context(), results = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  await context.request.get('http://127.0.0.1:18580/control?pqMode=%22open%22&pqDelay=0');
  await panel.bringToFront();
  if (await panel.locator('#btn-clear').isVisible()) await panel.locator('#btn-clear').click();
  await panel.waitForFunction(() => papers.length===0);
  if (!await panel.locator('#input-folder').isVisible()) await panel.locator('.folder-settings summary').click();
  await panel.locator('#input-folder').fill('proquest-session');
  await panel.locator('#btn-save-folder').click();
  await context.addCookies([{name:'pq_fixture_member',value:'1',domain:'.proquest.com',path:'/',secure:true,sameSite:'Lax'}]);
  const sample = await context.newPage();
  try {
    await sample.goto('https://www.proquest.com:18543/resultsol/member/1');
    await sample.locator('.pq-helper-button').first().waitFor();
    assert(await sample.locator('.pq-helper-button').count()===2, 'thesis and journal full-text candidates; preview excluded');
    await panel.evaluate(() => document.querySelector('#btn-add-page').click());
    await panel.waitForFunction(() => papers.length===2, null, {polling:100,timeout:15000});
    await panel.bringToFront();
    await panel.locator('#btn-fetch-links').click();
    await panel.waitForFunction(() => !fetchingLinks && papers.every(p=>p.proquestAccess==='available' && canDownloadPaper(p)));
    assert(await panel.evaluate(() => papers.map(p=>p.docType).join(','))==='D,J', 'both publication types retained');
    results.push({case:'session-thesis-and-journal-permission'});
    const downloads = () => panel.evaluate(() => chrome.downloads.search({}));
    const before = Math.max(0,...(await downloads()).map(d=>d.id));
    await panel.locator('#btn-batch-dl').click();
    await panel.waitForFunction(() => !downloadQueueBusy && papers.every(p=>downloadState[p.id]?.status==='success'));
    const saved = (await downloads()).filter(d=>d.id>before).map(d=>({id:d.id,state:d.state,filename:d.filename}));
    assert(saved.length===2 && saved.every(d=>d.state==='complete' && d.filename.includes('/proquest-session/')), 'authorized files downloaded using current session');
    results.push({case:'session-batch-native-download',downloads:saved});
    await context.clearCookies({name:'pq_fixture_member'});
    assert(await panel.evaluate(() => downloadPaper(920001))==='skipped', 'expired session blocks stale ready state');
    assert((await downloads()).filter(d=>d.id>before).length===2, 'no file after logout');
    assert(await panel.evaluate(() => !canDownloadPaper(papers.find(p=>p.id===920001))), 'stale permission cleared');
    results.push({case:'logout-rechecks-and-skips'});
    await context.addCookies([{name:'pq_fixture_member',value:'1',domain:'.proquest.com',path:'/',secure:true,sameSite:'Lax'}]);
    await panel.locator('#btn-fetch-links').click();
    await panel.waitForFunction(() => !fetchingLinks && papers.every(canDownloadPaper));
    assert(await panel.evaluate(() => downloadPaper(920001))==='success', 'restored permissions can download again');
    const requests=await (await context.request.get('http://127.0.0.1:18580/requests')).json();
    assert(!requests.some(r=>r.path.startsWith('/purchase')), 'never invoke purchase link even when shown next to download');
    results.push({case:'permission-restored-no-purchase',downloads:(await downloads()).filter(d=>d.id>before).map(d=>({id:d.id,state:d.state,filename:d.filename}))});
    await panel.evaluate(value=>{window.proquestSessionResults=value;},results);
    return results;
  } finally {
    await context.clearCookies({name:'pq_fixture_member'});
    await sample.close(); await panel.bringToFront();
  }
}
