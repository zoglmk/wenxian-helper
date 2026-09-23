/* 与知网内容脚本分开，避免站点选择器和消息处理相互影响。 */
(() => {
  if (window.__proquestHelperLoaded || !ProQuest.isSite(location.href)) return;
  window.__proquestHelperLoaded = true;
  const style = document.createElement("style");
  style.textContent = ".pq-helper-button{margin-left:8px;padding:2px 8px;border:1px solid #4f46e5;border-radius:5px;color:#4f46e5;background:white;font:12px system-ui;cursor:pointer}.pq-helper-button.collected{background:#4f46e5;color:white}";
  document.head.appendChild(style);
  const makePaper = paper => ({ ...paper, id: Number(paper.proquestId) });
  async function save(action, data) {
    const { cnkiPapersEpoch = 0 } = await chrome.storage.local.get("cnkiPapersEpoch");
    const result = await chrome.runtime.sendMessage({ type: "PAPER_STORE", action, epoch: cnkiPapersEpoch, ...data });
    if (!result?.ok) throw new Error(result?.error || "保存文献失败");
    return result;
  }
  async function refresh() {
    let entries;
    try { ({ entries } = ProQuest.collect(document, location.href)); }
    catch { return; } // 动态页面尚未加载完整；手动添加时会显示具体原因。
    const { cnkiPapers = [] } = await chrome.storage.local.get("cnkiPapers");
    const saved = new Set(cnkiPapers.filter(p => p.provider === "proquest").map(p => p.proquestId));
    for (const { paper, anchor } of entries) {
      let button = anchor.nextElementSibling;
      if (!button?.classList.contains("pq-helper-button")) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "pq-helper-button";
        anchor.after(button);
        button.addEventListener("click", async event => {
          event.preventDefault(); event.stopPropagation();
          button.disabled = true;
          try {
            // 每次读取当前行，避免页面原地切换后使用旧文献。
            const current = ProQuest.collect(document, location.href).entries.find(entry => entry.anchor === anchor);
            if (!current) throw new Error("页面已变化，请刷新后重试");
            await save("toggle", { paper: makePaper(current.paper) });
          } catch (err) { button.title = `收藏失败：${err.message}`; }
          finally { button.disabled = false; }
        });
      }
      const collected = saved.has(paper.proquestId);
      const label = collected ? "已收藏" : ProQuest.hasFullTextAccess(paper.proquestAccess) ? "+ 收藏全文" : "+ 收藏待确认";
      if (button.textContent !== label) button.textContent = label;
      button.classList.toggle("collected", collected);
      button.title = collected ? "取消收藏" : ProQuest.hasFullTextAccess(paper.proquestAccess) ? "收藏 ProQuest 全文" : "收藏文献，获取链接时确认当前会话的全文下载权限";
    }
  }
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => refresh().catch(console.error), 300);
  }).observe(document.body, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener(changes => {
    if (changes.cnkiPapers) refresh().catch(console.error);
  });
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type === "PING") { respond({ ok: true, isProQuest: true, isCnki: false }); return; }
    if (msg.type !== "ADD_ALL_PAGE") return;
    (async () => {
      const { entries, total, skipped } = ProQuest.collect(document, location.href);
      if (!total) return { ok: false, error: "未找到 ProQuest 结果，请进入搜索结果页或论文详情页" };
      const result = await save("add", { items: entries.map(entry => makePaper(entry.paper)) });
      return { ok: true, provider: "proquest", added: result.added, total, eligible: entries.length, skipped };
    })().then(respond).catch(err => respond({ ok: false, error: err.message }));
    return true;
  });
  refresh().catch(console.error);
})();
