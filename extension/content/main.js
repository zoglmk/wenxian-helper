/* Content Script - CNKI search results page collection + extraction */
(function () {
  // 即使用户曾把 ProQuest 加入代理域名，也由独立站点脚本处理。
  if (/^(?:www\.)?proquest\.com$/i.test(location.hostname)) return;
  if (window.__cnkiHelperLoaded) return;
  window.__cnkiHelperLoaded = true;

  // ── Title link selectors (try specific first, fallback to broad) ──
  // Search result page selectors
  const TITLE_SELECTORS = [
    "table.result-table-list .name a.fz14",
    ".result-table-list .fz14",
    "#gridTable .fz14",
    ".fz14",
    // Fallback: any link in result table name column pointing to detail pages
    "table.result-table-list .name a",
    "table.result-table-list td.name a",
    '.result-table-list a[href*="/kcms"]',
    '.result-table-list a[href*="detail"]',
  ];

  // Journal catalog page selectors (navi.cnki.net)
  const JOURNAL_SELECTORS = [
    '#CataLogContent dd.row span.name > a[target="_blank"]',
    '.J_list dd.row span.name > a[target="_blank"]',
    '#rightCataloglist dd.row span.name > a[href*="kcms"]',
  ];

  function isJournalPage() {
    return location.hostname.includes("navi.cnki.net") ||
      !!document.querySelector("#CataLogContent") ||
      !!document.querySelector(".J_list.list");
  }

  function getTitleLinks() {
    // Try journal catalog selectors first if on journal page
    if (isJournalPage()) {
      for (const sel of JOURNAL_SELECTORS) {
        const links = document.querySelectorAll(sel);
        if (links.length > 0) return links;
      }
    }
    // Then try search result selectors
    for (const sel of TITLE_SELECTORS) {
      const links = document.querySelectorAll(sel);
      if (links.length > 0) return links;
    }
    return [];
  }

  // ── Inject Styles ──
  const css = document.createElement("style");
  css.textContent = `
    .cnki-h-btn {
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      width: 20px; height: 20px;
      border: 1.5px solid #d1d5db;
      border-radius: 50%;
      background: #fff !important;
      color: #9ca3af;
      font-size: 14px;
      cursor: pointer;
      margin-left: 4px;
      vertical-align: middle;
      transition: all .15s;
      line-height: 20px;
      padding: 0;
      text-align: center;
      text-indent: 0;
      font-family: system-ui, sans-serif;
      box-shadow: 0 1px 2px rgba(0,0,0,.04);
      position: relative;
      z-index: 10;
      flex-shrink: 0;
      visibility: visible !important;
      opacity: 1 !important;
    }
    .cnki-h-btn:hover { border-color: #4f46e5; color: #4f46e5; background: #eef2ff !important; }
    .cnki-h-btn.collected {
      border-color: #4f46e5; background: #4f46e5 !important; color: #fff;
      box-shadow: 0 1px 4px rgba(79,70,229,.25);
    }
    .cnki-h-btn.collected:hover { background: #4338ca !important; border-color: #4338ca; }
  `;

  // ── Helpers ──
  function urlId(url) {
    let h = 0;
    for (let i = 0; i < url.length; i++) h = ((h << 5) - h + url.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function extractFromRow(linkEl) {
    const title = linkEl.textContent.trim();
    const detailUrl = linkEl.href;
    let author = "", date = "", quote = "0", download = "0", source = "", sourceUrl = "", cookieName = "";

    // Journal catalog page: dd.row structure
    const dd = linkEl.closest("dd.row");
    if (dd) {
      const author = dd.querySelector("span.author")?.textContent?.trim() || "";
      const pages = dd.querySelector("span.company")?.textContent?.trim() || "";
      const cb = dd.querySelector("input.cbItem, input[name='CookieName']");
      if (cb) cookieName = cb.value || "";
      return { title, detailUrl, date: "", pages, quote, download, source, sourceUrl, author, cookieName };
    }

    // Search result page: tr or .list-item structure
    const row = linkEl.closest("tr") || linkEl.closest(".list-item");
    if (row) {
      author = row.querySelector(".author")?.textContent?.trim() || "";
      date = row.querySelector(".date")?.textContent?.trim() || "";
      quote = row.querySelector(".quote")?.textContent?.trim() || "0";
      download = row.querySelector(".download")?.textContent?.trim() || "0";
      const src = row.querySelector(".source a");
      if (src) { source = src.textContent.trim(); sourceUrl = src.href; }
      const cb = row.querySelector("input.cbItem, input[name='CookieName']");
      if (cb) cookieName = cb.value || "";
    }
    return { title, detailUrl, author, date, quote, download, source, sourceUrl, cookieName };
  }

  function convertToWebVPNLink(link, useWebVPN) {
    if (!useWebVPN) return link;
    return window.location.origin + link.replace(/^(https?:\/\/)?(www\.)?[^/]+/, "");
  }

  // ── Storage Operations ──
  async function getPapers() {
    const data = await chrome.storage.local.get(["cnkiPapers"]);
    return Array.isArray(data.cnkiPapers) ? data.cnkiPapers : [];
  }

  const removedCache = new Map();
  async function updatePapers(message) {
    const result = await chrome.runtime.sendMessage({ type: "PAPER_STORE", ...message });
    if (!result?.ok) throw new Error(result?.error || "保存文献失败");
    return result;
  }

  async function togglePaper(info) {
    const data = await chrome.storage.local.get(["cnkiPapers", "cnkiPapersEpoch"]);
    const existing = (data.cnkiPapers || []).find((p) => p.detailUrl === info.detailUrl);
    if (existing) removedCache.set(info.detailUrl, existing);
    const cached = removedCache.get(info.detailUrl);
    const paper = cached || { id: urlId(info.detailUrl), author: "", pdfLink: "", keywords: "", level: "Wait", ...info };
    const result = await updatePapers({ action: "toggle", epoch: data.cnkiPapersEpoch || 0, paper });
    if (result.collected) removedCache.delete(info.detailUrl);
    return result.collected;
  }

  async function addAllOnPage(useWebVPN) {
    if (!isCnkiPage()) return { ok: false, error: "no_links" };
    const links = getTitleLinks();
    if (!links.length) return { ok: false, error: "no_links" };
    const data = await chrome.storage.local.get(["cnkiPapersEpoch"]);
    const items = Array.from(links, (link) => {
      const info = extractFromRow(link);
      const detailUrl = convertToWebVPNLink(link.href, useWebVPN);
      return { id: urlId(detailUrl), author: "", pdfLink: "", keywords: "", level: "Wait", ...info, detailUrl };
    });
    const result = await updatePapers({ action: "add", epoch: data.cnkiPapersEpoch || 0, items });
    return { ok: true, added: result.added, total: links.length };
  }

  // ── Button Injection ──
  async function injectButtons() {
    const links = getTitleLinks();
    if (links.length === 0) return;

    const papers = await getPapers();
    const collected = new Set(papers.map((p) => p.detailUrl));

    links.forEach((link) => {
      // Check if button already exists (next sibling or within parent)
      if (link.nextElementSibling?.classList.contains("cnki-h-btn")) return;
      const parent = link.parentNode;
      if (parent?.querySelector(".cnki-h-btn")) return;

      const btn = document.createElement("button");
      btn.className = "cnki-h-btn";
      const isCollected = collected.has(link.href);
      btn.classList.toggle("collected", isCollected);
      btn.textContent = isCollected ? "\u2713" : "+";
      btn.title = isCollected ? "已收藏，点击取消" : "收藏到下载列表";

      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const info = extractFromRow(link);
        btn.disabled = true;
        let added;
        try { added = await togglePaper(info); }
        catch (err) { btn.title = `收藏失败：${err.message}`; console.error(err); return; }
        finally { btn.disabled = false; }
        btn.classList.toggle("collected", added);
        btn.textContent = added ? "\u2713" : "+";
        btn.title = added ? "已收藏，点击取消" : "收藏到下载列表";
      });

      // Insert after the link
      if (link.nextSibling) {
        parent.insertBefore(btn, link.nextSibling);
      } else {
        parent.appendChild(btn);
      }
    });
  }

  function syncButtons(papers) {
    const collected = new Set(papers.map((p) => p.detailUrl));
    document.querySelectorAll(".cnki-h-btn").forEach((btn) => {
      const link = btn.previousElementSibling;
      if (!link?.href) return;
      const is = collected.has(link.href);
      btn.classList.toggle("collected", is);
      btn.textContent = is ? "\u2713" : "+";
    });
  }

  // ── Init ──
  // Detect if this is a CNKI page (direct or via WebVPN)
  function isCnkiPage() {
    return location.hostname.includes("cnki") ||
      !!document.querySelector(".result-table-list, #gridTable, #CataLogContent, .J_list.list") ||
      // 自定义域名可覆盖图书馆门户；普通页面的 .fz14 字号样式不是知网证据。
      Array.from(getTitleLinks()).some((link) => /\/kcms\d?\/|[?&](filename|dbcode)=/i.test(link.href)) ||
      (!!document.querySelector(".wx-tit h1") && !!document.querySelector(".operate-btn, #pdfDown, #cajDown"));
  }

  function activate() {
    if (window.__cnkiHelperActivated) return;
    window.__cnkiHelperActivated = true;
    document.head.appendChild(css);

    let debounce;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(injectButtons, 300);
    }).observe(document.body, { childList: true, subtree: true });

    injectButtons();
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.cnkiPapers) syncButtons(changes.cnkiPapers.newValue || []);
    });
  }

  if (isCnkiPage()) {
    activate();
  } else {
    // For WebVPN: recheck after dynamic content loads
    setTimeout(() => { if (isCnkiPage()) activate(); }, 2000);
  }

  // ── Message Handlers ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "PING") {
      const isCnki = isCnkiPage();
      // 代理页可能在首次检查结束后才加载知网内容，手动操作时再次激活。
      if (isCnki) activate();
      sendResponse({ ok: true, isCnki });
      return;
    }
    if (msg.type === "ADD_ALL_PAGE") {
      addAllOnPage(msg.useWebVPN).then(sendResponse).catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  });
})();
