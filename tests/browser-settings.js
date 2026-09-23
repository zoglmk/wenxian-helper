// 仅使用独立测试浏览器；会清空测试清单并修改测试下载目录。
async panel => {
  const results=[];
  await panel.bringToFront(); await panel.reload();
  await panel.setViewportSize({width:430,height:1000});
  const assert=(ok,message)=>{if(!ok) throw new Error(message)};
  await panel.waitForFunction(()=>document.querySelector('.folder-settings'));
  assert(!await panel.locator('.folder-settings').evaluate(el=>el.open), 'folder defaults collapsed');
  assert(!await panel.locator('.proxy-settings').evaluate(el=>el.open), 'domain defaults collapsed');
  if(await panel.locator('#btn-clear').isVisible()) await panel.locator('#btn-clear').click();
  await panel.waitForFunction(()=>papers.length===0);
  const help=await panel.locator('.empty-new').textContent();
  assert(help.includes('自定义域名') && !help.includes('稳定性'), 'new feature hint replaces stability');
  await panel.screenshot({path:'output/playwright/settings-collapsed.png'});
  await panel.locator('.proxy-settings summary').click();
  assert((await panel.locator('p.proxy-tip').textContent())==='填写搜索结果页域名或完整地址，授权范围包含该域名及其子域名，支持 HTTP / HTTPS，不限端口。弹出请求权限提示框点击允许即可。', 'exact domain help');
  await panel.locator('.folder-settings summary').click();
  const previous=await panel.evaluate(async()=>(await chrome.storage.local.get('downloadFolder')).downloadFolder || '');
  await panel.getByRole('textbox',{name:'指定文件夹',exact:true}).fill('settings-check');
  assert(await panel.evaluate(async expected=>(await chrome.storage.local.get('downloadFolder')).downloadFolder===expected, previous), 'typing does not save');
  assert((await panel.locator('#folder-status').textContent()).includes('尚未保存'), 'draft feedback');
  await panel.locator('#btn-save-folder').click();
  await panel.waitForFunction(async()=> (await chrome.storage.local.get('downloadFolder')).downloadFolder==='settings-check');
  assert((await panel.locator('#folder-status').textContent())==='已保存', 'saved feedback');
  results.push({case:'explicit-folder-save-no-auto-save'});
  const layout=await panel.evaluate(()=>{
    const a=document.querySelector('.proxy-settings'),b=document.querySelector('.folder-settings');
    return {sameLevel:a.parentElement===b.parentElement,domainX:a.getBoundingClientRect().x,folderX:b.getBoundingClientRect().x,
      domainFont:getComputedStyle(a.querySelector('summary')).fontSize,folderFont:getComputedStyle(b.querySelector('summary')).fontSize};
  });
  assert(layout.sameLevel && layout.domainX===layout.folderX && layout.domainFont===layout.folderFont, 'settings share hierarchy and heading style');
  results.push({case:'settings-help-default-collapsed-same-level',layout});
  await panel.screenshot({path:'output/playwright/settings-expanded.png'});
  await panel.reload();
  await panel.waitForFunction(()=>document.querySelector('#input-folder').value==='settings-check');
  assert(!await panel.locator('.folder-settings').evaluate(el=>el.open), 'reload preserves folder and collapses section');
  results.push({case:'saved-folder-survives-reload-and-collapse'});
  await panel.setViewportSize({width:320,height:930});
  await panel.locator('.folder-settings summary').click();
  assert(await panel.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth), 'no horizontal overflow at 320px');
  await panel.getByRole('textbox',{name:'指定文件夹',exact:true}).fill('');
  await panel.locator('#btn-save-folder').click();
  await panel.waitForFunction(()=>document.querySelector('#folder-status').textContent==='已恢复默认下载位置');
  assert(await panel.evaluate(async()=>(await chrome.storage.local.get('downloadFolder')).downloadFolder===''), 'empty save resets folder');
  results.push({case:'empty-save-restores-default-and-narrow-layout'});
  await panel.reload();
  await panel.setViewportSize({width:430,height:1000});
  return results;
}
