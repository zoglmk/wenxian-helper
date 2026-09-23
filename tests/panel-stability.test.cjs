const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto').webcrypto;
const panel=fs.readFileSync('extension/sidepanel/index.js','utf8').replace(/\ninit\(\);\s*$/,'\n');
const clone=v=>JSON.parse(JSON.stringify(v));
function harness(initial=[]) {
 const elements=new Map();
 const el=s=>{if(!elements.has(s))elements.set(s,{value:'',textContent:'',hidden:false,style:{},dataset:{}});return elements.get(s);};
 const state={cnkiPapers:clone(initial),cnkiPapersEpoch:0};let context;
 const chrome={runtime:{getManifest:()=>({version:'1.2.3'}),sendMessage:async m=>context.store.update(m)},storage:{local:{get:async()=>clone(state),set:async values=>{Object.assign(state,clone(values));context.snapshot=clone(state);vm.runInContext('papers=snapshot.cnkiPapers; paperEpoch=snapshot.cnkiPapersEpoch;',context);}}}};
 context=vm.createContext({chrome,URL,crypto,setTimeout,clearTimeout,console,document:{querySelector:el,querySelectorAll:()=>[],createElement:()=>({dataset:{},innerHTML:''})}});
 vm.runInContext(fs.readFileSync('extension/paper-store.js','utf8')+'\nthis.store=PaperStore;',context);
 vm.runInContext(panel,context);context.snapshot=clone(state);
 vm.runInContext('papers=snapshot.cnkiPapers; renderList=()=>{}; restoreChecks=()=>{}; updateFooter=()=>{}; addLog=()=>{};',context);
 return {context,el,state,chrome};
}
test('英文作者保留名字和空格；中文机构脚注清理仍可用',()=>{
 const {context:c}=harness();
 assert.equal(c.cleanAuthorName('John   Q. Smith'),'John Q. Smith');
 assert.deepEqual(Array.from(c.splitAuthors('李秀秀1 查艳2; 1.大学')),['李秀秀','查艳']);
 assert.deepEqual(Array.from(c.splitAuthors('John Smith; Jane Doe')),['John Smith','Jane Doe']);
});
test('外部元数据按文本渲染，危险详情地址不成为链接，HTTP 代理 URL 原样保留',()=>{
 const {context:c}=harness();
 const payload='<img src=x onerror="alert(1)">';
 const card=c.createPaperCard({id:1,title:payload,author:payload,abstract:payload,keywords:payload,level:payload,source:payload,date:payload,detailUrl:'javascript:alert(1)'});
 assert.ok(!card.innerHTML.includes('<img'));assert.ok(card.innerHTML.includes('&lt;img'));assert.ok(!card.innerHTML.includes('href="javascript:'));
 assert.equal(c.safeHttpUrl('https://proxy.org:8888/vpn/a?b=%2F'),'https://proxy.org:8888/vpn/a?b=%2F');assert.equal(c.safeHttpUrl('data:text/html,bad'),'');
});
test('无链接文献可以单独选择，全部取消勾选时不导出全表',async()=>{
 const h=harness([{id:1,title:'A',selected:false},{id:2,title:'B',selected:true}]);
 assert.deepEqual(Array.from(h.context.getSelectedIds()),[2]);
 vm.runInContext('papers.forEach(p=>p.selected=false); downloadAsFile=()=>{throw new Error("must not export")};',h.context);
 await h.context.doExport('csv');assert.match(h.el('#footer-status').textContent,/勾选/);
});
test('DOI 失败原条目可更新，保留勾选和旧元数据，查询进度按实际队列计算',async()=>{
 const h=harness([
 {id:1,doi:'10.1234/ready',title:'Ready',detailUrl:'https://doi.org/10.1234/ready',pdfLink:'https://oa/ready.pdf'},
 {id:2,doi:'10.1234/RETRY',title:'Old',author:'Existing Author',detailUrl:'https://doi.org/10.1234/RETRY',pdfFailed:true,selected:false},
 ]);
 h.el('#doi-input').value='10.1234/ready 10.1234/retry 10.1234/RETRY 10.1234/new';
 const queried=[];h.context.fetchPdfByDoi=async doi=>{queried.push(doi);return {title:'Updated',pdfLink:'https://oa/'+doi,pdfSource:'Unpaywall',author:''};};
 await h.context.importDois();
 assert.equal(queried.length,2);assert.equal(h.state.cnkiPapers.length,3);
 const retried=h.state.cnkiPapers.find(p=>p.id===2);assert.equal(retried.selected,false);assert.equal(retried.author,'Existing Author');assert.equal(retried.pdfFailed,false);
 assert.match(h.el('#doi-count').textContent,/新增 1 篇，更新 1 篇，跳过 1 篇/);assert.match(h.el('#doi-progress-text').textContent,/2\/2/);
});
test('重复导入只启动一个任务，清空时未完成的 DOI 结果不会回写',async()=>{
 const h=harness();h.el('#doi-input').value='10.1234/pending';let finish,calls=0;
 h.context.fetchPdfByDoi=()=>{calls++;return new Promise(r=>finish=r);};
 const importing=h.context.importDois();await h.context.importDois();assert.equal(calls,1);
 h.context.cancelTasks();await h.context.mutatePapers('clear');finish({title:'late',pdfLink:'https://oa/file'});await importing;
 assert.deepEqual(h.state.cnkiPapers,[]);
});
test('Unpaywall 作者使用 given+family，非法 PDF 协议不能成为下载链接',async()=>{
 const h=harness();h.chrome.runtime.sendMessage=async m=>m.type==='FETCH_TEXT'?{ok:true,text:JSON.stringify({title:'Test',z_authors:[{given:'John Q.',family:'Smith'}],best_oa_location:{url_for_pdf:'javascript:alert(1)'}})}:{ok:true,isPdf:false};
 const result=await h.context.fetchPdfByDoi('10.1234/a');assert.equal(result.author,'John Q. Smith');assert.equal(result.pdfLink,'');
});

test('PDF 探测检验文件头及响应类型，拒绝 JSON/HTML/纯文本并提前关闭流',async()=>{
 const background=fs.readFileSync('extension/background.js','utf8');
 const probe=background.slice(background.indexOf('async function handleFetchPdfInfo'),background.indexOf('async function handleFetchPost'));
 for(const [body,type,expected] of [['%PDF-1.7\nfile','application/pdf',true],['%PDF-1.4\nfile','application/octet-stream',true],['{"error":"blocked"}','application/json',false],['<html>login</html>','text/html',false],['unavailable','application/pdf',false],['%PDF-1.7\nfake','text/html',false]]) {
  let cancelled=false;
  const bytes=new TextEncoder().encode(body);let offset=0;
  const fetch=async()=>({ok:true,status:200,headers:new Headers({'content-type':type}),url:'https://test/file',body:{getReader:()=>({read:async()=>{const value=bytes.subarray(offset,offset+3);offset+=3;return {done:value.length===0,value};},cancel:async()=>{cancelled=true;}})}});
  const c=vm.createContext({fetch,AbortController,TextDecoder,Uint8Array,setTimeout,clearTimeout,console});vm.runInContext(probe,c);
  assert.equal((await c.handleFetchPdfInfo({url:'https://test/file'})).isPdf,expected,body);assert.equal(cancelled,true);
 }
});

test('单篇与队列的重复点击不会并行触发下载',async()=>{
 const h=harness([{id:1,pdfLink:'https://pdf'}]);let finish,calls=0;
 h.context.performDownload=()=>{calls++;return new Promise(r=>finish=r);};
 const first=h.context.downloadPaper(1);
 assert.equal(await h.context.downloadPaper(1),'busy');
 await h.context.runDownloadQueue([1]);assert.equal(calls,1);
 finish('success');assert.equal(await first,'success');
});
test('清空使队列停止，不启动下一篇；重复解析只启动一批',async()=>{
 const h=harness([{id:1,pdfLink:'https://pdf/1'},{id:2,pdfLink:'https://pdf/2'}]);const calls=[];
 h.context.downloadPaper=async id=>{calls.push(id);h.context.cancelTasks();return 'cancelled';};
 await h.context.runDownloadQueue([1,2]);assert.deepEqual(calls,[1]);
 let finish,count=0;h.context.performFetchPdfLinks=()=>{count++;return new Promise(r=>finish=r);};
 const first=h.context.fetchPdfLinks();await h.context.fetchPdfLinks();assert.equal(count,1);finish();await first;
});

test('较早的保存回复或清空通知不能覆盖较新的清单视图',()=>{
 const h=harness();
 assert.equal(h.context.acceptPaperSnapshot({papers:[{id:2,title:'new'}],epoch:1,revision:3}),true);
 assert.equal(h.context.acceptPaperSnapshot({papers:[],epoch:1,revision:2}),false);
 assert.deepEqual(Array.from(h.context.getSelectedIds()),[2]);
 assert.equal(h.context.acceptPaperSnapshot({papers:[{id:1,title:'old'}],epoch:0,revision:1}),false);
 assert.deepEqual(Array.from(h.context.getSelectedIds()),[2]);
});
