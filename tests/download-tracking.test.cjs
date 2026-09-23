const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('extension/download-tracking.js', 'utf8');
function event() { const listeners = new Set(); return {listeners,addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),emit:v=>[...listeners].forEach(f=>f(v))}; }
function harness() {
 const onCreated=event(),onChanged=event();
 const chrome={runtime:{id:'test-extension'}, downloads:{onCreated,onChanged,search:(_q,cb)=>cb([])}};
 const context=vm.createContext({chrome,URL,setTimeout,clearTimeout});
 vm.runInContext(source,context);
 return {chrome,onCreated,onChanged,tracker:vm.runInContext('DownloadTracking',context)};
}
const url='https://proxy.example.org:8000/vpn/download?token=a%2Fb';
test('按原始地址归属，保留代理端口路径参数；重定向后地址不影响匹配',()=>{
 const {tracker}=harness();
 assert.equal(tracker.matches({url,finalUrl:'https://cdn.example.org/file.pdf'},url),true);
 for(const unrelated of [url.replace(':8000',':8080'),url.replace('a%2Fb','other'),'https://other.org/file.pdf'])assert.equal(tracker.matches({url:unrelated,finalUrl:url},url),false);
 assert.equal(tracker.matches({url:''},''),false);
});
test('无关下载不完成任务，目标下载完成后清理全部监听',async()=>{
 const h=harness();const wait=h.tracker.wait({url});
 h.onCreated.emit({id:7,url:'https://other.org/file.pdf'});h.onChanged.emit({id:7,state:{current:'complete'}});
 assert.equal(h.onChanged.listeners.size,1);
 h.onCreated.emit({id:8,url});h.onChanged.emit({id:8,state:{current:'complete'}});
 assert.equal(await wait,'success');assert.equal(h.onChanged.listeners.size,0);assert.equal(h.onCreated.listeners.size,0);
});
test('慢下载超时不能标成功；未启动、取消和中断均清理监听',async()=>{
 const h=harness();const wait=h.tracker.wait({url,completeTimeout:5});h.onCreated.emit({id:8,url});
 assert.match(await wait,/尚未完成/);
 assert.equal(await h.tracker.wait({url,startTimeout:5}),'timeout');
 const cancelled=h.tracker.wait({url});cancelled.cancel();assert.equal(await cancelled,'cancelled');
 const interrupted=h.tracker.wait({id:1});h.onChanged.emit({id:1,state:{current:'interrupted'},error:{current:'NETWORK_FAILED'}});
 assert.equal(await interrupted,'NETWORK_FAILED');assert.equal(h.onChanged.listeners.size,0);
});
test('下载创建时已完成或先于监听完成的已知 ID 都能识别',async()=>{
 const h=harness();h.chrome.downloads.search=(_q,cb)=>cb([{state:'complete'}]);
 assert.equal(await h.tracker.wait({id:3}),'success');
 const pending=h.tracker.wait({url});h.onCreated.emit({id:4,url,state:'complete'});assert.equal(await pending,'success');
});
test('子目录清理非法路径且不接受父目录',()=>{
 const {tracker}=harness();assert.equal(tracker.folderName('a/b'),'a_b');assert.equal(tracker.folderName('..'),'');assert.equal(tracker.folderName('papers'),'papers');
});

test('文件夹只应用于匹配任务，取消/过期后不影响其他下载，DOI 显式带目录',async()=>{
 const h=harness();const context=vm.createContext({chrome:h.chrome,URL,setTimeout,clearTimeout,console,crypto:require('node:crypto').webcrypto,importScripts:()=>{},ProxyDomains:{update:async()=>{}}});
 vm.runInContext(source,context);
 h.chrome.permissions={onRemoved:event()};h.chrome.sidePanel={setPanelBehavior:async()=>{}};
 h.chrome.storage={local:{get:async()=>({downloadFolder:'文献'})},session:{set:async()=>{},remove:async()=>{}},onChanged:event()};
 h.chrome.runtime.onMessage=event();h.chrome.downloads.onDeterminingFilename=event();
 let saved;h.chrome.downloads.download=async opts=>{saved=opts;return 5;};
 vm.runInContext(fs.readFileSync('extension/background.js','utf8'),context);
 const send=msg=>new Promise(resolve=>[...h.chrome.runtime.onMessage.listeners][0](msg,{},resolve));
 const filename=(url)=>{let suggestion;[...h.chrome.downloads.onDeterminingFilename.listeners][0]({url,filename:'/Downloads/paper.pdf'},v=>suggestion=v);return suggestion;};
 const task=await send({type:'MARK_DOWNLOAD',url});assert.equal(task.ok,true);
 assert.equal(filename('https://unrelated.org/file'),undefined);
 assert.equal(filename(url).filename,'文献/paper.pdf');assert.equal(filename(url),undefined);
 const cancelled=await send({type:'MARK_DOWNLOAD',url});await send({type:'UNMARK_DOWNLOAD',token:cancelled.token});assert.equal(filename(url),undefined);
 await send({type:'MARK_DOWNLOAD',url});vm.runInContext('for (const task of pendingDownloads.values()) task.expires=0;',context);assert.equal(filename(url),undefined);
 await send({type:'SAVE_DOWNLOAD',url,filename:'doi.pdf',useFolder:true});assert.equal(saved.filename,'文献/doi.pdf');
});

function backgroundHarness() {
 const h=harness(),sessionData={};
 h.chrome.permissions={onRemoved:event()};h.chrome.sidePanel={setPanelBehavior:async()=>{}};
 h.chrome.storage={local:{get:async()=>({downloadFolder:'文献'})},onChanged:event(),session:{
  get:async key=>({[key]:sessionData[key]}),set:async values=>Object.assign(sessionData,values),remove:async key=>{delete sessionData[key];}
 }};
 h.chrome.runtime.onMessage=event();h.chrome.downloads.onDeterminingFilename=event();
 const context=vm.createContext({chrome:h.chrome,URL,setTimeout,clearTimeout,console,crypto:require('node:crypto').webcrypto,importScripts:()=>{},ProxyDomains:{update:async()=>{}}});
 vm.runInContext(source,context);
 vm.runInContext(fs.readFileSync('extension/background.js','utf8'),context);
 const send=msg=>new Promise(resolve=>[...h.chrome.runtime.onMessage.listeners][0](msg,{},resolve));
 const suggest=item=>new Promise(resolve=>[...h.chrome.downloads.onDeterminingFilename.listeners][0]({filename:'server.pdf',byExtensionId:'test-extension',...item},resolve));
 return {...h,context,send,suggest,sessionData};
}
test('Chrome 文件名事件早于 API 回复时等待下载 ID；相同 URL 的并发下载不串目录或名称',async()=>{
 const h=backgroundHarness(),starts=[];
 h.chrome.downloads.download=opts=>new Promise(resolve=>starts.push({opts,resolve}));
 const a=h.send({type:'SAVE_DOWNLOAD',url,filename:'one.pdf',useFolder:true});
 const b=h.send({type:'SAVE_DOWNLOAD',url,filename:'two.pdf',useFolder:true});
 await new Promise(setImmediate);
 const nameB=h.suggest({id:12,url});
 const nameA=h.suggest({id:11,url});
 starts[1].resolve(12);starts[0].resolve(11);
 assert.equal((await a).ok,true);assert.equal((await b).ok,true);
 assert.equal((await nameA).filename,'文献/one.pdf');assert.equal((await nameB).filename,'文献/two.pdf');
 assert.deepEqual(h.sessionData,{});
 assert.equal(await h.suggest({id:99,url,byExtensionId:'another-extension'}),undefined);
});
test('DOI 文件名在后台休眠后按 ID 恢复；导出保留文件名及另存为且不继承文献目录',async()=>{
 const h=backgroundHarness();let options;let id=1;
 h.chrome.downloads.download=async opts=>{options=opts;return id++;};
 await h.send({type:'SAVE_DOWNLOAD',url,filename:'doi.pdf',useFolder:true});
 vm.runInContext('apiDownloadTasks.clear()',h.context);
 assert.equal((await h.suggest({id:1,url})).filename,'文献/doi.pdf');
 const blob='blob:chrome-extension://test-extension/test';
 await h.send({type:'SAVE_DOWNLOAD',url:blob,filename:'metadata.csv',saveAs:true});
 assert.equal(options.saveAs,true);assert.equal(options.filename,'metadata.csv');
 assert.equal((await h.suggest({id:2,url:blob})).filename,'metadata.csv');
});
test('API 启动失败或下载中断后清理文件名记录，不影响下一个同 URL 下载',async()=>{
 const h=backgroundHarness();h.chrome.downloads.download=async()=>{throw new Error('USER_CANCELED');};
 assert.equal((await h.send({type:'SAVE_DOWNLOAD',url,filename:'failed.pdf'})).ok,false);
 assert.equal(vm.runInContext('apiDownloadTasks.size',h.context),0);
 h.chrome.downloads.download=async()=>3;
 await h.send({type:'SAVE_DOWNLOAD',url,filename:'interrupted.pdf'});
 h.onChanged.emit({id:3,state:{current:'interrupted'}});
 await new Promise(setImmediate);
 assert.deepEqual(h.sessionData,{});assert.equal(vm.runInContext('apiDownloadTasks.size',h.context),0);
 assert.equal(await h.suggest({id:4,url}),undefined);
 let finishStart;h.chrome.downloads.download=()=>new Promise(resolve=>{finishStart=resolve;});
 const early=h.send({type:'SAVE_DOWNLOAD',url,filename:'early.pdf'});
 await new Promise(setImmediate);h.onChanged.emit({id:5,state:{current:'complete'}});finishStart(5);
 await early;await new Promise(setImmediate);assert.deepEqual(h.sessionData,{});
});
