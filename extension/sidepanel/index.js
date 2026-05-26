/* 文献助手 - Side Panel Application */

// ── State ──
let papers = [];
let settings = { useWebVPN: false, fetchLevels: true, autoOpenOnVerify: true, downloadFolder: "" };
let sortField = "";
let sortDir = "desc";
const downloadState = {};
const logs = [];
const levelCache = new Map();
const levelPending = new Map();

// ── DOM ──
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ── API Helpers ──
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}


async function sendToContent(msg) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("无活动标签页");
  return chrome.tabs.sendMessage(tab.id, msg);
}

async function sendToBackground(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function ensureContentScript() {
  const tab = await getActiveTab();
  if (!tab?.id) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/main.js"] });
      return true;
    } catch { return false; }
  }
}

// ── Storage ──
async function loadSettings() {
  const data = await chrome.storage.local.get(["useWebVPN", "fetchLevels", "autoOpenOnVerify", "downloadFolder", "cnkiPapers", "cnkiSort"]);
  settings.useWebVPN = data.useWebVPN ?? false;
  settings.fetchLevels = data.fetchLevels ?? true;
  settings.autoOpenOnVerify = data.autoOpenOnVerify ?? true;
  settings.downloadFolder = data.downloadFolder ?? "";
  papers = Array.isArray(data.cnkiPapers) ? data.cnkiPapers : [];
  if (data.cnkiSort) { sortField = data.cnkiSort.field || ""; sortDir = data.cnkiSort.dir || "desc"; }
}

async function savePapers() {
  await chrome.storage.local.set({ cnkiPapers: papers });
}

async function saveSort() {
  await chrome.storage.local.set({ cnkiSort: { field: sortField, dir: sortDir } });
}

// ── Logging (errors only in UI) ──
function addLog(level, title, detail = "") {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logs.push({ time, level, title, detail });
  if (level === "error") {
    renderLogEntry({ time, level, title, detail });
    updateLogBadge();
    $("#log-panel").hidden = false;
  }
}

function renderLogEntry(entry) {
  const list = $("#log-list");
  if (!list) return;
  const escaped = entry.detail.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const el = document.createElement("div");
  el.className = "log-entry log-error";
  el.innerHTML = `
    <div class="log-entry-header">
      <span class="log-time">${entry.time}</span>
      <span class="log-msg">${entry.title}</span>
      <button class="log-copy-btn" title="复制详情">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      </button>
    </div>
    ${escaped ? `<div class="log-detail">${escaped}</div>` : ""}
  `;
  el.querySelector(".log-copy-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(`[${entry.time}] ${entry.title}\n${entry.detail}`);
  });
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
}

function updateLogBadge() {
  const n = logs.filter((l) => l.level === "error").length;
  $("#log-badge").textContent = n;
  $("#log-badge").hidden = n === 0;
  $("#log-badge-footer").textContent = n;
  $("#log-badge-footer").hidden = n === 0;
}

// ── Utils ──
function createSafeFilename(name, maxLen = 200) {
  let s = name.replace(/[\/:*?"<>|\\]/g, "_").replace(/\s+/g, " ").trim();
  return (s.length > maxLen ? s.substring(0, maxLen) : s) + ".pdf";
}

// ── Citation Formatting & Export ──

function parseYear(dateStr) {
  if (!dateStr) return "";
  const m = String(dateStr).match(/(\d{4})/);
  return m ? m[1] : "";
}

function detectDocType(paper) {
  const text = (paper.source || "") + " " + (paper.title || "");
  if (/学位论文|博士论文|硕士论文/.test(text)) return "D";
  if (/会议|proceedings/i.test(text)) return "C";
  if (/报纸|日报|晚报/.test(text)) return "N";
  return "J";
}

function cleanAuthorName(name) {
  if (!name) return "";
  return String(name)
    .replace(/\d+/g, "")
    .replace(/[\s　 ]+/g, "")
    .replace(/[,，;；、.。]+$/, "")
    .trim();
}

// Robust author list parser: handles "李秀秀1 查艳2; 1.大学; 2.大学" etc.
function splitAuthors(authorStr) {
  if (!authorStr) return [];
  const segments = String(authorStr).split(/[;；]/).filter((s) => {
    // Drop institution-like segments and "1.机构" entries
    return !/(大学|学院|医院|研究所|公司|中心|实验室)/.test(s)
      && !/^\s*\d+\s*[.\.]/.test(s);
  });
  const names = [];
  for (const seg of segments) {
    if (/[,，、]/.test(seg)) {
      seg.split(/[,，、]/).forEach((s) => {
        const n = cleanAuthorName(s);
        if (n) names.push(n);
      });
      continue;
    }
    if (/[\s　]/.test(seg)) {
      // Multiple CJK names separated by spaces (e.g. "李秀秀1 查艳2")
      const tokens = seg.split(/[\s　]+/)
        .map((s) => cleanAuthorName(s)).filter(Boolean);
      const allCjk = tokens.length > 1
        && tokens.every((t) => /^[一-龥]{2,4}$/.test(t));
      if (allCjk) {
        names.push(...tokens);
      } else {
        const n = cleanAuthorName(seg);
        if (n) names.push(n);
      }
      continue;
    }
    const n = cleanAuthorName(seg);
    if (n) names.push(n);
  }
  return names;
}

function formatAuthors(authorStr, style = "gb7714") {
  const authors = splitAuthors(authorStr);
  if (authors.length === 0) return "";

  if (style === "apa") {
    if (authors.length === 1) return authors[0];
    if (authors.length === 2) return authors.join(" & ");
    if (authors.length > 6) {
      return authors.slice(0, 6).join(",") + ",..." + authors[authors.length - 1];
    }
    return authors.slice(0, -1).join(",") + " & " + authors[authors.length - 1];
  }

  if (style === "mla") {
    if (authors.length === 1) return authors[0];
    if (authors.length === 2) return authors[0] + ",and " + authors[1];
    return authors[0] + ",et al.";
  }

  // gb7714: 三人以内全列, 超过取前三+等
  if (authors.length <= 3) return authors.join(",");
  return authors.slice(0, 3).join(",") + ",等";
}

function formatCitation(paper, style = "gb7714") {
  const year = parseYear(paper.date);
  const docType = detectDocType(paper);
  const volume = paper.volume || "";
  const issue = paper.issue || "";
  const pages = paper.pages || "";
  const title = paper.title || "";

  if (style === "gb7714") {
    const authors = formatAuthors(paper.author, "gb7714");
    let s = "";
    if (authors) s += authors + ".";
    s += title + `[${docType}].`;
    if (paper.source) {
      s += paper.source;
      if (year) s += "," + year;
      if (volume) s += "," + volume + (issue ? `(${issue})` : "");
      else if (issue) s += `(${issue})`;
      if (pages) s += ":" + pages;
      s += ".";
    } else if (year) {
      s += year + ".";
    }
    if (paper.doi) s += "DOI:" + paper.doi + ".";
    return s;
  }

  if (style === "apa") {
    const authors = formatAuthors(paper.author, "apa");
    let s = "";
    if (authors) s += authors + ".";
    if (year) s += `(${year}).`;
    s += title + ".";
    if (paper.source) {
      s += paper.source;
      if (volume) {
        s += "," + volume;
        if (issue) s += `(${issue})`;
      } else if (issue) {
        s += "(" + issue + ")";
      }
      if (pages) s += "," + pages;
      s += ".";
    }
    if (paper.doi) s += "https://doi.org/" + paper.doi + ".";
    return s;
  }

  if (style === "mla") {
    const authors = formatAuthors(paper.author, "mla");
    let s = "";
    if (authors) s += authors + ".";
    s += `"${title}."`;
    if (paper.source) {
      s += paper.source;
      if (volume && issue) s += " " + volume + "." + issue;
      else if (volume) s += " " + volume;
      if (year) s += `(${year})`;
      if (pages) s += ":" + pages;
      s += ".";
    }
    if (paper.doi) s += "doi:" + paper.doi + ".";
    return s;
  }

  // plain - cleaned legacy format
  const cleanedAuthor = splitAuthors(paper.author).join(";");
  const parts = [title];
  if (cleanedAuthor) parts.push(cleanedAuthor);
  if (paper.source) parts.push(paper.source);
  if (paper.date) parts.push(paper.date);
  return parts.join(". ");
}

function formatBibTeX(paper) {
  const year = parseYear(paper.date);
  const docType = detectDocType(paper);
  const entryType = docType === "D" ? "phdthesis" :
                    docType === "C" ? "inproceedings" :
                    "article";
  const firstAuthor = (paper.author || "").split(/[;；、,,，]/)[0]?.trim() || "Anon";
  const firstWord = (paper.title || "untitled").split(/\s+/)[0]
    .replace(/[^A-Za-z0-9一-龥]/g, "");
  const key = (firstAuthor + (year || "") + firstWord)
    .replace(/[^A-Za-z0-9一-龥]/g, "") || "ref";

  const escape = (s) => String(s || "").replace(/[{}\\]/g, "");
  const lines = [`@${entryType}{${key},`];
  if (paper.title) lines.push(`  title = {${escape(paper.title)}},`);
  if (paper.author) {
    const auths = splitAuthors(paper.author).map(escape).join(" and ");
    if (auths) lines.push(`  author = {${auths}},`);
  }
  if (paper.source) lines.push(`  journal = {${escape(paper.source)}},`);
  if (year) lines.push(`  year = {${year}},`);
  if (paper.volume) lines.push(`  volume = {${escape(paper.volume)}},`);
  if (paper.issue) lines.push(`  number = {${escape(paper.issue)}},`);
  if (paper.pages) lines.push(`  pages = {${escape(paper.pages)}},`);
  if (paper.keywords) lines.push(`  keywords = {${escape(paper.keywords)}},`);
  if (paper.abstract) lines.push(`  abstract = {${escape(paper.abstract)}},`);
  if (paper.doi) lines.push(`  doi = {${paper.doi}},`);
  if (paper.detailUrl) lines.push(`  url = {${paper.detailUrl}},`);
  // Strip trailing comma from last entry
  const last = lines.pop();
  lines.push(last.replace(/,$/, ""));
  lines.push("}");
  return lines.join("\n");
}

function formatRIS(paper) {
  const year = parseYear(paper.date);
  const docType = detectDocType(paper);
  const tyCode = docType === "D" ? "THES" :
                 docType === "C" ? "CONF" :
                 docType === "N" ? "NEWS" :
                 "JOUR";

  const lines = [`TY  - ${tyCode}`];
  if (paper.title) lines.push(`TI  - ${paper.title}`);
  if (paper.author) {
    splitAuthors(paper.author).forEach((a) => lines.push(`AU  - ${a}`));
  }
  if (paper.source) lines.push(`T2  - ${paper.source}`);
  if (year) lines.push(`PY  - ${year}`);
  if (paper.volume) lines.push(`VL  - ${paper.volume}`);
  if (paper.issue) lines.push(`IS  - ${paper.issue}`);
  if (paper.pages) lines.push(`SP  - ${paper.pages}`);
  if (paper.keywords) {
    paper.keywords.split(/[,，;；]/).map((k) => k.trim()).filter(Boolean)
      .forEach((k) => lines.push(`KW  - ${k}`));
  }
  if (paper.abstract) lines.push(`AB  - ${paper.abstract}`);
  if (paper.doi) lines.push(`DO  - ${paper.doi}`);
  if (paper.detailUrl) lines.push(`UR  - ${paper.detailUrl}`);
  lines.push("ER  - ");
  return lines.join("\n");
}

function csvEscape(value) {
  const s = String(value == null ? "" : value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function papersToCSV(papers) {
  const headers = ["标题", "作者", "来源", "日期", "卷", "期", "页码", "DOI", "被引", "下载", "等级", "关键词", "摘要", "详情链接"];
  const rows = [headers.map(csvEscape).join(",")];
  papers.forEach((p) => {
    const cleanedAuthor = splitAuthors(p.author).join(";");
    rows.push([
      p.title, cleanedAuthor, p.source, p.date, p.volume, p.issue, p.pages,
      p.doi || "", p.quote, p.download, p.level, p.keywords, p.abstract, p.detailUrl,
    ].map(csvEscape).join(","));
  });
  // UTF-8 BOM for Excel compatibility
  return "﻿" + rows.join("\n");
}

function papersToBibTeX(papers) {
  return papers.map(formatBibTeX).join("\n\n");
}

function papersToRIS(papers) {
  return papers.map(formatRIS).join("\n\n");
}

// ── CNKI Official Citation API (ShowExport) ──
//
// citationCache[paperId][mode] = "已格式化的引用文本"
const citationCache = {};
const STYLE_TO_DISPLAY_MODE = { gb7714: "GBTREFER", apa: "APA", mla: "MLA" };

// CNKI's export endpoints reject requests whose Origin is the chrome-extension://
// scheme. Run fetch from a CNKI page tab (MAIN world) so Origin is kns.cnki.net.
function isCnkiLikeUrl(url = "") {
  return /cnki\.net/i.test(url) || /edu\.cn/i.test(url);
}

async function getCnkiTab() {
  const active = await getActiveTab();
  if (active?.id && isCnkiLikeUrl(active.url)) return active;
  // 当前激活页不是知网/WebVPN，搜索所有已打开的相关标签页
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => t.id && isCnkiLikeUrl(t.url)) || null;
}

async function postViaCnkiPage(url, body) {
  const targetTab = await getCnkiTab();
  if (!targetTab) throw new Error("请在打开的知网页面上使用（接口需要从知网域调用）");
  const result = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    world: "MAIN",
    func: async (u, b) => {
      try {
        const r = await fetch(u, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: b,
        });
        return { ok: r.ok, status: r.status, text: await r.text() };
      } catch (e) {
        return { ok: false, status: 0, error: e.message };
      }
    },
    args: [url, body],
  });
  return result?.[0]?.result || { ok: false };
}

// GET via cnki tab MAIN-world fetch — returns response as text (or "" if request errored).
// Used to probe download endpoints when the iframe redirects to an HTML notice page.
async function getViaCnkiPage(url) {
  const targetTab = await getCnkiTab();
  if (!targetTab) return { ok: false };
  const result = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    world: "MAIN",
    func: async (u) => {
      try {
        const r = await fetch(u, { credentials: "include" });
        return { ok: r.ok, status: r.status, finalUrl: r.url, text: await r.text() };
      } catch (e) {
        return { ok: false, status: 0, error: e.message };
      }
    },
    args: [url],
  });
  return result?.[0]?.result || { ok: false };
}

// Heuristics on a CNKI response page (HTML body text) to classify why a
// download didn't return a PDF. Returns: "verify" | "quota" | "auth" | "unknown".
function classifyDownloadPage(href, text) {
  if (/\/(bar\/)?verify\/|\/captcha\//i.test(href)) return "verify";
  // settlementHtml = 结算页（额度耗尽时知网弹出的提示页路径），htmlread 也常带这个 marker
  if (/settlementHtml|\/orderpay\/|\/buy\//i.test(href)) return "quota";
  if (text) {
    if (/下载量已满|漫游下载量|当日下载量|下载额度|下载次数已|超出.*下载次数|已达.*下载.*上限|继续阅读|个人账号下载阅读|绑定账户/.test(text)) return "quota";
    if (/拼图校验|滑块|安全验证|verify|captcha/i.test(text)) return "verify";
    if (/请登录|未登录|登录后下载|未授权/.test(text)) return "auth";
  }
  return "unknown";
}

function citeHtmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items = doc.querySelectorAll(".literature-list > li");
  return Array.from(items).map((li) => {
    li.querySelectorAll(".index").forEach((s) => s.remove());
    return li.textContent.replace(/\s+/g, " ").trim();
  });
}

async function fetchOfficialCitations(targets, mode) {
  const displayMode = STYLE_TO_DISPLAY_MODE[mode];
  if (!displayMode) return new Map();

  const result = new Map();
  const need = [];
  for (const p of targets) {
    if (citationCache[p.id]?.[mode]) {
      result.set(p.id, citationCache[p.id][mode]);
    } else if (p.cookieName) {
      need.push(p);
    }
  }
  if (need.length === 0) return result;

  // Batch by 20 (CNKI default page size)
  const BATCH = 20;
  for (let i = 0; i < need.length; i += BATCH) {
    const batch = need.slice(i, i + BATCH);
    const fileNames = batch.map((p) => p.cookieName).join(",");
    const body = new URLSearchParams({
      FileName: fileNames,
      DisplayMode: displayMode,
      OrderParam: "0",
      OrderType: "desc",
      SelectField: "",
      PageIndex: "1",
      PageSize: String(batch.length),
      language: "CHS",
      uniplatform: "NZKPT",
      subject: "",
      random: String(Math.random()),
    }).toString();

    let texts = [];
    try {
      const res = await postViaCnkiPage("https://kns.cnki.net/dm8/api/ShowExport", body);
      if (res?.ok && res.text) texts = citeHtmlToText(res.text);
      else if (res?.error) addLog("error", "调用知网官方引用接口失败", `${res.error}\n模式: ${displayMode}`);
    } catch (err) {
      addLog("error", "调用知网官方引用接口失败", `${err.message}\n模式: ${displayMode}`);
    }

    // Pair returned texts with the batch input order; if mismatch, give up on this batch
    if (texts.length === batch.length) {
      batch.forEach((p, idx) => {
        if (!citationCache[p.id]) citationCache[p.id] = {};
        citationCache[p.id][mode] = texts[idx];
        result.set(p.id, texts[idx]);
      });
    } else if (texts.length > 0) {
      addLog("error", "知网引用接口返回数量不匹配", `期望 ${batch.length} 条，实际 ${texts.length} 条，已回退本地拼装`);
    }
  }
  return result;
}

// Single-paper endpoint — returns all three formats in one call. Used when a
// user clicks the per-card copy button. The batch ShowExport endpoint refuses
// single-row requests with 403, hence this separate path.
async function fetchSingleCitation(paper) {
  if (!paper.cookieName) return null;
  const body = new URLSearchParams({
    filename: paper.cookieName,
    displaymode: "GBTREFER,MLA,APA",
    uniplatform: "NZKPT",
    language: "CHS",
  }).toString();
  let res;
  try {
    res = await postViaCnkiPage("https://kns.cnki.net/dm8/API/GetExport", body);
  } catch (err) {
    addLog("error", "调用知网引用接口失败", err.message || String(err));
    return null;
  }
  if (!res?.ok || !res.text) {
    if (res?.error) addLog("error", "调用知网引用接口失败", res.error);
    return null;
  }
  let data;
  try { data = JSON.parse(res.text); } catch { return null; }
  if (data?.code !== 1 || !Array.isArray(data.data)) return null;
  const out = {};
  for (const entry of data.data) {
    const raw = entry.value?.[0] || "";
    const text = raw.replace(/<br\s*\/?>/gi, "").replace(/^\s*\[\d+\]\s*/, "").trim();
    if (entry.mode === "GBTREFER") out.gb7714 = text;
    else if (entry.mode === "APA") out.apa = text;
    else if (entry.mode === "MLA") out.mla = text;
  }
  return out;
}

async function getCitation(paper, style) {
  // Plain mode and styles without official equivalent → local format
  if (!STYLE_TO_DISPLAY_MODE[style]) return formatCitation(paper, style);
  // Already cached?
  if (citationCache[paper.id]?.[style]) return citationCache[paper.id][style];
  // No cookieName → fall back to local
  if (!paper.cookieName) return formatCitation(paper, style);
  // Single-paper: GetExport returns all 3 formats; cache them all.
  const all = await fetchSingleCitation(paper);
  if (all) {
    citationCache[paper.id] = { ...(citationCache[paper.id] || {}), ...all };
    if (all[style]) return all[style];
  }
  return formatCitation(paper, style);
}

async function downloadAsFile(filename, content, mimeType = "text/plain") {
  const blob = new Blob([content], { type: mimeType + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: true });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

// ── Fetch PDF Links (enriches papers with pdfLink, author, keywords) ──
async function fetchPdfLinks() {
  const pending = papers.filter((p) => !p.pdfLink && !p.pdfFailed);
  if (pending.length === 0) {
    $("#footer-status").textContent = "所有论文已有下载链接";
    return;
  }

  let done = 0;
  setProgress(0, `获取链接 0/${pending.length}`);

  async function fetchOne(paper) {
    try {
      const res = await sendToBackground({ type: "FETCH_TEXT", url: paper.detailUrl });
      if (res?.text) {
        const doc = new DOMParser().parseFromString(res.text, "text/html");

        // Try multiple strategies to find PDF download link
        let pdfLink = "";

        // Helper: extract href attribute directly (not resolved .href which may mangle relative URLs)
        const getHref = (el) => el?.getAttribute("href") || el?.href || "";

        // Strategy 1: .operate-btn container (domestic CNKI)
        const operateBtn = doc.querySelector(".operate-btn");
        if (operateBtn) {
          const el = Array.from(operateBtn.querySelectorAll("a")).find(
            (a) => /PDF下[载載]|整本下[载載]|Download\s*PDF/i.test(a.textContent)
          );
          if (el) pdfLink = getHref(el);
        }

        // Strategy 2: overseas CNKI (.btn-download-pdf #pdfDown)
        if (!pdfLink) {
          const dlEl = doc.querySelector(".btn-download-pdf a, a#pdfDown, a#cajDown");
          if (dlEl) {
            // Prefer PDF over CAJ
            const pdfEl = doc.querySelector(".btn-download-pdf a, a#pdfDown");
            pdfLink = getHref(pdfEl || dlEl);
          }
        }

        // Strategy 3: common selectors (btn-dlpdf, download.aspx, etc.)
        if (!pdfLink) {
          const dlEl = doc.querySelector("a.btn-dlpdf, a[href*='download.aspx']");
          if (dlEl) pdfLink = getHref(dlEl);
        }

        // Strategy 4: any link containing PDF download text on the page
        if (!pdfLink) {
          const allLinks = Array.from(doc.querySelectorAll("a[href]"));
          const dlLink = allLinks.find((a) => /PDF下[载載]|整本下[载載]|Download\s*PDF/i.test(a.textContent));
          if (dlLink) pdfLink = getHref(dlLink);
        }

        // Resolve relative URL to absolute based on detail page
        if (pdfLink && !pdfLink.startsWith("http")) {
          try {
            pdfLink = new URL(pdfLink, paper.detailUrl).href;
          } catch {}
        }

        if (pdfLink) paper.pdfLink = pdfLink;

        // Author extraction. Prefer per-anchor iteration: detail pages render
        // each author as a separate <a> inside the .author wrapper; using the
        // wrapper's textContent collapses adjacent names without delimiters.
        // Run unconditionally so older stored entries with collision artifacts
        // get repaired on the next "获取链接".
        const authorAs = doc.querySelectorAll(".author a, .author span");
        let extracted = Array.from(authorAs)
          .map((el) => cleanAuthorName(el.textContent))
          .filter(Boolean);
        if (extracted.length === 0) {
          const raw = Array.from(doc.querySelectorAll(".author"))
            .map((a) => a.textContent.trim()).join(";");
          extracted = splitAuthors(raw);
        }
        if (extracted.length > 0) paper.author = extracted.join(";");
        if (!paper.keywords) {
          paper.keywords = Array.from(doc.querySelectorAll(".keywords a"))
            .map((k) => k.textContent.replace(/;/g, "").trim()).filter(Boolean).join(",");
        }
        if (!paper.abstract) {
          const absEl = doc.querySelector("#ChDivSummary") || doc.querySelector(".abstract-text");
          if (absEl) paper.abstract = absEl.textContent.trim();
        }

        // Volume / Issue / Pages — try unified pattern first, then per-field fallback
        if (!paper.volume || !paper.issue || !paper.pages) {
          let infoText = "";
          for (const sel of [".top-tip", ".top-space", ".doc-top", ".wx-tit", ".sourinfo", ".doc-detail-info", ".doc-info"]) {
            const el = doc.querySelector(sel);
            if (el) infoText += " " + el.textContent;
          }
          // Unified pattern: "YYYY,VOL(ISS):PAGES" with optional spaces between any tokens
          const unified = infoText.match(/(\d{4})\s*[,，]?\s*(\d+)\s*\(\s*(\d+)\s*\)\s*[:：]\s*([\d\-–~]+)/);
          if (unified) {
            if (!paper.volume) paper.volume = unified[2];
            if (!paper.issue) paper.issue = unified[3];
            if (!paper.pages) paper.pages = unified[4].replace(/\s/g, "");
          }
          // Per-field fallbacks (handles "卷"/"期"/"P xx-xx" patterns)
          if (!paper.volume) {
            const m = infoText.match(/(\d+)\s*卷/) || infoText.match(/Vol\.?\s*(\d+)/i);
            if (m) paper.volume = m[1];
          }
          if (!paper.issue) {
            const m = infoText.match(/第\s*(\d+)\s*期/) || infoText.match(/No\.?\s*(\d+)/i);
            if (m) paper.issue = m[1];
          }
          if (!paper.pages) {
            const m = infoText.match(/(?:页码|Pages?)\s*[:：]?\s*(\d+\s*[-–~]\s*\d+|\d+)/i)
              || infoText.match(/\sP\s*(\d+\s*[-–~]\s*\d+)/i);
            if (m) paper.pages = m[1].replace(/\s/g, "");
          }
        }

        // DOI extraction — try dedicated element / link, then fallback to body text scan
        if (!paper.doi) {
          const doiPattern = /10\.[0-9]{4,9}\/[-._;()/:a-zA-Z0-9]+/;
          const doiEl = doc.querySelector("[class*='doi'] a, [class*='doi']")
            || doc.querySelector("a[href*='doi.org']");
          if (doiEl) {
            const m = (doiEl.textContent || "").match(doiPattern)
              || (doiEl.getAttribute("href") || "").match(doiPattern);
            if (m) paper.doi = m[0];
          }
          if (!paper.doi) {
            const bodyText = doc.body?.textContent || "";
            const m = bodyText.match(/DOI[\s:：]+\s*(10\.[0-9]{4,9}\/[-._;()/:a-zA-Z0-9]+)/i);
            if (m) paper.doi = m[1];
          }
        }

        const h1 = doc.querySelector(".wx-tit h1");
        if (h1) { h1.querySelectorAll("span").forEach((s) => s.remove()); paper.title = h1.textContent.trim() || paper.title; }
      }

      if (!paper.pdfLink) {
        paper.pdfFailed = true;
        addLog("error", `未找到下载链接: ${paper.title}`, `详情页: ${paper.detailUrl}`);
      }
    } catch (err) {
      paper.pdfFailed = true;
      addLog("error", `获取链接失败: ${paper.title}`, `${err.message}\n详情页: ${paper.detailUrl}`);
    }
    done++;
    setProgress(Math.round((done / pending.length) * 100), `获取链接 ${done}/${pending.length}`);
  }

  // Concurrent fetch with limit of 3
  const CONCURRENCY = 3;
  const queue = [...pending];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const paper = queue.shift();
      await fetchOne(paper);
      await new Promise((r) => setTimeout(r, 300));
    }
  });
  await Promise.all(workers);

  hideProgress();
  await savePapers();
  renderList();
  restoreChecks();
  updateFooter();
  if (settings.fetchLevels) loadAllLevels();
}

// ── Download Logic (via hidden iframe in page context — same as user clicking a link) ──
let consecutiveFails = 0;
let pendingResumeIds = [];
// URL the queue's auto-open should jump to. Set by downloadPaper when it
// returns verify/quota/blocked. For verify we use the webNav-captured URL
// directly (verify pages don't check Referer); for quota/blocked we use the
// detail page since the raw download URL bounces to "来源不正确" without a
// valid Referer (which a fresh tab can't supply).
let lastBlockOpenUrl = "";

// Returns: "success" | "verify" | "quota" | "fail"
async function downloadPaper(id) {
  const paper = papers.find((p) => p.id === id);
  if (!paper?.pdfLink) return "fail";

  setDownloadState(id, "downloading");

  // DOI 来源（Unpaywall / Sci-Hub 直链）：直接用 chrome.downloads 下载，不需要知网页面
  if (paper.pdfSource) {
    try {
      const filename = createSafeFilename(paper.title || paper.doi || "paper");
      await sendToBackground({ type: "MARK_DOWNLOAD" });
      const res = await sendToBackground({ type: "SAVE_DOWNLOAD", url: paper.pdfLink, filename });
      if (res?.ok && res.downloadId != null) {
        const result = await waitForDownloadById(res.downloadId);
        if (result === "success") {
          setDownloadState(id, "success");
          consecutiveFails = 0;
        } else {
          setDownloadState(id, "error", result);
          addLog("error", `下载失败: ${paper.title}`, `原因: ${result}\nURL: ${paper.pdfLink}`);
          // DOI 下载失败属于正常情况（Sci-Hub 可能不可用），不计入连续失败次数
        }
      } else {
        throw new Error(res?.error || "下载失败");
      }
    } catch (err) {
      setDownloadState(id, "error", err.message);
      addLog("error", `下载失败: ${paper.title}`, `${err.message}\nURL: ${paper.pdfLink}`);
      // DOI 下载失败不计入连续失败次数
    }
    return;
  }

  // Listen for sub-frame navigations on the download tab so we can capture the
  // iframe's final URL even when it lives on a different CNKI/WebVPN origin
  // (cross-origin reads inside the iframe are opaque to us).
  let frameFinalUrl = "";
  let navListener = null;

  try {
    // Trigger iframe in a CNKI/WebVPN tab so cookies and Referer are correct.
    // Falls back to any open tab matching cnki.net, libvpn, or webvpn domains.
    const tab = await getCnkiTab();
    if (!tab?.id) throw new Error("请打开知网页面后再下载");

    // 标记下一个下载属于插件，background 的 onDeterminingFilename 才会应用文件夹
    await sendToBackground({ type: "MARK_DOWNLOAD" });

    navListener = (details) => {
      if (details.tabId !== tab.id || details.frameId === 0) return;
      frameFinalUrl = details.url;
    };
    chrome.webNavigation.onCommitted.addListener(navListener);

    // Pre-subscribe before iframe load to avoid race.
    // 8s to start (chrome.downloads.onCreated fires within 1-3s on success),
    // 60s after that to finish (large PDFs may take a while).
    const downloadResultPromise = waitForDownload(paper.pdfLink, 15000, 60000);

    // Trigger download via hidden iframe in page's MAIN world.
    // Inject promise resolves once the frame fires onload (so we can sniff
    // the final URL/body — non-PDF responses cause navigation), or after a
    // short timeout (real PDF downloads suppress onload entirely).
    const inject = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: (url) => new Promise((resolve) => {
        let frame = document.getElementById("__cnki_dl_frame__");
        if (!frame) {
          frame = document.createElement("iframe");
          frame.id = "__cnki_dl_frame__";
          frame.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
          document.body.appendChild(frame);
        }
        let done = false;
        const fin = (v) => { if (!done) { done = true; resolve(v); } };
        frame.onload = () => {
          // onload firing means the frame navigated to an HTML page — NOT a real
          // download. Try to read URL/body (may fail across cnki.net subdomains).
          let href = "", text = "";
          try { href = frame.contentWindow.location.href || ""; } catch {}
          try { text = frame.contentDocument?.body?.textContent || ""; } catch {}
          fin({ kind: "navigated", href, text: text.slice(0, 600) });
        };
        setTimeout(() => fin({ kind: "no_onload" }), 3000);
        frame.src = url;
      }),
      args: [paper.pdfLink],
    });
    const result = inject?.[0]?.result || { kind: "no_onload" };

    if (result.kind === "navigated") {
      // iframe navigated to HTML → definitely not a real download.
      // Prefer webNavigation-captured URL (works across subdomains) over the
      // cross-origin opaque href we tried to read inside the inject script.
      const finalUrl = frameFinalUrl || result.href || "";
      let category = classifyDownloadPage(finalUrl, result.text || "");
      let probeText = "", probeUrl = "", probeErr = "";
      if (category === "unknown") {
        // Body content unknown — try background fetch as a fallback. May fail
        // (knsi often bounces foreign-Origin requests to ErrorMsg.html).
        try {
          const probe = await sendToBackground({ type: "FETCH_TEXT", url: paper.pdfLink });
          if (probe?.ok && probe.text) {
            probeText = probe.text;
            probeUrl = probe.finalUrl || "";
            category = classifyDownloadPage(probeUrl, probeText);
          } else {
            probeErr = probe?.error || `status=${probe?.status || "?"}`;
          }
        } catch (e) { probeErr = e.message || String(e); }
      }

      if (category === "verify") {
        lastBlockOpenUrl = finalUrl || paper.detailUrl;
        setDownloadState(id, "error", "触发知网验证码，已暂停");
        addLog("error", `触发验证码: ${paper.title}`, `URL: ${paper.pdfLink}\n验证页: ${finalUrl}\n请在浏览器中完成验证后点「继续下载」`);
        return "verify";
      }
      if (category === "quota") {
        lastBlockOpenUrl = paper.detailUrl;
        setDownloadState(id, "error", "下载额度已用完");
        addLog("error", `下载额度已用完: ${paper.title}`, `URL: ${paper.pdfLink}\n知网当日漫游下载量已达上限，可换账号或明日再试`);
        return "quota";
      }
      if (category === "auth") {
        setDownloadState(id, "error", "需要登录或权限不足");
        addLog("error", `权限不足: ${paper.title}`, `URL: ${paper.pdfLink}\n请检查登录状态或文献访问权限`);
        consecutiveFails++;
        return "fail";
      }
      // unknown — needs user intervention. Pause the queue and auto-open the
      // detail page (raw download URL bounces to ErrorMsg.html without a
      // valid Referer, so we send the user somewhere they can act on).
      lastBlockOpenUrl = paper.detailUrl;
      setDownloadState(id, "error", "下载页异常，已暂停");
      const detail = [
        `URL: ${paper.pdfLink}`,
        finalUrl ? `跳转到: ${finalUrl}` : "无法读取最终 URL",
        probeErr ? `探测失败: ${probeErr}` : probeUrl ? `探测最终 URL: ${probeUrl}` : "",
        `页面摘要: ${((probeText || result.text || "").replace(/\s+/g, " ").trim().slice(0, 300)) || "(空)"}`,
      ].filter(Boolean).join("\n");
      addLog("error", `下载受阻: ${paper.title}`, detail);
      return "blocked";
    }

    // kind === "no_onload" → frame didn't navigate, real download likely
    const downloadResult = await downloadResultPromise;
    if (downloadResult === "success") {
      setDownloadState(id, "success");
      consecutiveFails = 0;
      return "success";
    }
    if (downloadResult === "timeout") {
      setDownloadState(id, "error", "下载超时未启动");
      addLog("error", `下载超时: ${paper.title}`, `URL: ${paper.pdfLink}\n15 秒内未触发下载，可能是网络较慢或需要登录验证，可重试`);
      consecutiveFails++;
      return "fail";
    }
    setDownloadState(id, "error", downloadResult);
    addLog("error", `下载失败: ${paper.title}`, `原因: ${downloadResult}\nURL: ${paper.pdfLink}`);
    consecutiveFails++;
    return "fail";
  } catch (err) {
    setDownloadState(id, "error", err.message || "网络错误");
    addLog("error", `下载失败: ${paper.title}`, `${err.message}\nURL: ${paper.pdfLink}`);
    consecutiveFails++;
    return "fail";
  } finally {
    if (navListener) {
      try { chrome.webNavigation.onCommitted.removeListener(navListener); } catch {}
    }
  }
}

// Wait for a download to appear and complete
// Two-phase timeout: startTimeoutMs to see onCreated (i.e. download actually
// kicked off), then completeTimeoutMs after that for the file to finish.
// If start times out → "timeout" (didn't trigger at all).
// If complete times out after start fired → assume "success" (chrome handles
// the rest of the lifecycle in the downloads UI; we just wanted to know it ran).
// 用已知 downloadId 等待下载完成（避免 onCreated 竞态问题）
function waitForDownloadById(downloadId, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChange);
    };
    const timer = setTimeout(() => { cleanup(); resolve("timeout"); }, timeoutMs);
    const onChange = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") { cleanup(); resolve("success"); }
      else if (delta.state?.current === "interrupted") { cleanup(); resolve(delta.error?.current || "下载中断"); }
    };
    chrome.downloads.onChanged.addListener(onChange);
    // 检查是否已经完成（download 调用和监听器注册之间可能已完成）
    chrome.downloads.search({ id: downloadId }, ([item]) => {
      if (!item) return;
      if (item.state === "complete") { cleanup(); resolve("success"); }
      else if (item.state === "interrupted") { cleanup(); resolve(item.error || "下载中断"); }
    });
  });
}

function waitForDownload(expectedUrl, startTimeoutMs = 8000, completeTimeoutMs = 60000) {
  return new Promise((resolve) => {
    let matchedId = null;
    let startTimer = null, completeTimer = null;
    const cleanup = () => {
      if (startTimer) clearTimeout(startTimer);
      if (completeTimer) clearTimeout(completeTimer);
      chrome.downloads.onCreated.removeListener(onCreate);
      chrome.downloads.onChanged.removeListener(onChange);
    };
    startTimer = setTimeout(() => { cleanup(); resolve("timeout"); }, startTimeoutMs);

    const onCreate = (item) => {
      if (matchedId != null) return;
      matchedId = item.id;
      clearTimeout(startTimer);
      startTimer = null;
      completeTimer = setTimeout(() => { cleanup(); resolve("success"); }, completeTimeoutMs);
    };

    const onChange = (delta) => {
      if (delta.id !== matchedId) return;
      if (delta.state?.current === "complete") {
        cleanup();
        resolve("success");
      } else if (delta.state?.current === "interrupted") {
        cleanup();
        resolve(delta.error?.current || "下载中断");
      }
    };

    chrome.downloads.onCreated.addListener(onCreate);
    chrome.downloads.onChanged.addListener(onChange);
  });
}

async function runDownloadQueue(ids) {
  consecutiveFails = 0;
  pendingResumeIds = [];
  updateResumeButton();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (consecutiveFails >= 2) {
      addLog("error", "已连续失败2次，已暂停批量下载", "请检查网络或手动尝试普通下载");
      $("#footer-status").textContent = "已连续失败2次，已暂停";
      pendingResumeIds = ids.slice(i);
      break;
    }
    if (downloadState[id]?.status === "success") continue;
    const paper = papers.find((p) => p.id === id);
    if (!paper?.pdfLink) continue;
    const r = await downloadPaper(id);
    if (r === "verify" || r === "quota" || r === "blocked") {
      pendingResumeIds = ids.slice(i);
      if (r === "verify") {
        $("#footer-status").textContent = "⚠️ 触发知网验证码，已暂停。完成验证后点「继续下载」";
      } else if (r === "quota") {
        $("#footer-status").textContent = "⚠️ 当日下载额度已用完，已暂停（可换账号或次日再试）";
      } else {
        $("#footer-status").textContent = "⚠️ 下载受阻，已自动打开详情页，处理后点「继续下载」";
      }
      if (settings.autoOpenOnVerify && lastBlockOpenUrl) {
        try { await chrome.tabs.create({ url: lastBlockOpenUrl, active: true }); } catch {}
      }
      break;
    }
    // DOI 直链下载不需要间隔，知网下载保留间隔避免风控
    if (!paper.pdfSource) {
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
    }
  }
  updateResumeButton();
}

async function downloadSelected() {
  const selected = getSelectedIds();
  if (selected.length === 0) return;
  await runDownloadQueue(selected);
}

async function retryFailed() {
  const failedIds = papers
    .filter((p) => p.pdfLink && downloadState[p.id]?.status === "error")
    .map((p) => p.id);
  if (failedIds.length === 0) return;
  await runDownloadQueue(failedIds);
}

async function resumeDownload() {
  if (pendingResumeIds.length === 0) return;
  const ids = [...pendingResumeIds];
  pendingResumeIds = [];
  $("#footer-status").textContent = "继续下载中...";
  await runDownloadQueue(ids);
}

function updateResumeButton() {
  const btn = $("#btn-resume");
  if (!btn) return;
  btn.hidden = pendingResumeIds.length === 0;
  if (pendingResumeIds.length > 0) {
    btn.textContent = `继续下载 (${pendingResumeIds.length})`;
  }
}

function setDownloadState(id, status, error = "") {
  downloadState[id] = { status, error };
  updateCardState(id);
  updateFooter();
}

// ── Journal Levels ──
async function fetchLevel(url) {
  if (!url) return "无";
  if (levelCache.has(url)) return levelCache.get(url);
  if (levelPending.has(url)) return levelPending.get(url);
  const promise = (async () => {
    try {
      const res = await sendToBackground({ type: "FETCH_TEXT", url });
      if (!res?.text) return "无";
      const doc = new DOMParser().parseFromString(res.text, "text/html");
      const spans = Array.from(doc.querySelectorAll(".journalType.journalType2 > span"));
      return spans.map((s) => s.textContent.trim()).filter(Boolean).join("/") || "无";
    } catch { return "无"; }
  })();
  levelPending.set(url, promise);
  const result = await promise;
  levelCache.set(url, result);
  levelPending.delete(url);
  return result;
}

async function loadAllLevels() {
  if (!settings.fetchLevels) return;
  for (const paper of papers) {
    if (!paper.sourceUrl || paper.level !== "Wait") continue;
    paper.level = await fetchLevel(paper.sourceUrl);
    updateCardLevel(paper.id, paper.level);
  }
  await savePapers();
}

// ── Rendering ──
function getSortedPapers() {
  if (!sortField) return [...papers];
  return [...papers].sort((a, b) => {
    let va = a[sortField] || "", vb = b[sortField] || "";
    if (sortField !== "date") { va = parseInt(va) || 0; vb = parseInt(vb) || 0; }
    return va < vb ? (sortDir === "asc" ? -1 : 1) : va > vb ? (sortDir === "asc" ? 1 : -1) : 0;
  });
}

function renderList() {
  const list = $("#paper-list");
  const header = $("#list-header");
  list.innerHTML = "";

  if (papers.length === 0) {
    header.hidden = true;
    list.innerHTML = `
      <div class="empty">
        <svg class="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        <div class="empty-title">使用说明</div>
        <div class="empty-tip">温馨提示：建议每次下载不超过 20 篇，下载完成后间隔一段时间再继续，避免触发知网访问限制。</div>
        <div class="empty-steps">
          <div class="empty-step"><span class="step-num">1</span>在知网搜索结果页或期刊目录页，点击「添加本页」收藏文献</div>
          <div class="empty-step"><span class="step-num">2</span>点击「获取链接」解析 PDF 下载地址</div>
          <div class="empty-step"><span class="step-num">3</span>勾选文献后点击「下载」批量下载 PDF</div>
        </div>
        <div class="empty-new">
          <div class="empty-new-title">v1.2 新功能</div>
          <div class="empty-new-item"><span class="empty-new-tag">DOI</span>切到「DOI导入」标签页，粘贴 DOI 列表自动获取英文文献下载链接</div>
          <div class="empty-new-item"><span class="empty-new-tag">文件夹</span>指定下载子文件夹，所有文献自动归类保存</div>
          <div class="empty-new-item"><span class="empty-new-tag">稳定性</span>修复批量下载中途失败、支持学校 WebVPN 代理下载</div>
        </div>
      </div>`;
    updateFooter();
    return;
  }

  header.hidden = false;
  getSortedPapers().forEach((paper, idx) => list.appendChild(createPaperCard(paper, idx)));
  updateFooter();
  updateSortPills();
}

function createPaperCard(paper) {
  const card = document.createElement("div");
  card.className = "paper-card";
  card.dataset.id = paper.id;

  const state = downloadState[paper.id];
  if (state) card.dataset.status = state.status;
  const hasPdf = !!paper.pdfLink;
  if (!hasPdf && !state) card.dataset.status = "pending";

  const levelHtml = renderLevel(paper.level);
  const kwHtml = paper.keywords ? paper.keywords.split(",").map((k) => `<span class="kw-tag">${k}</span>`).join("") : "";

  const abstractHtml = paper.abstract ? `<div class="paper-abstract" hidden>${paper.abstract}</div>` : "";
  const hasAbstract = !!paper.abstract;

  card.innerHTML = `
    <label class="check">
      <input type="checkbox" class="paper-check" data-id="${paper.id}" ${hasPdf ? "" : "disabled"}>
      <span class="check-box"></span>
    </label>
    <div class="paper-body">
      <div class="paper-title-row">
        <div class="paper-title" title="${paper.title.replace(/"/g, "&quot;")}">${paper.title}</div>
        <div class="paper-title-actions">
          ${hasAbstract ? `<button class="icon-btn abstract-toggle-btn" data-id="${paper.id}" title="查看摘要"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></button>` : ""}
          <button class="icon-btn copy-info-btn" data-id="${paper.id}" title="复制文献信息"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
        </div>
      </div>
      <div class="paper-meta">
        ${paper.author ? `<span class="author">${splitAuthors(paper.author).join(";")}</span><span class="dot">&middot;</span>` : ""}
        ${paper.source ? `<span>${paper.source}</span><span class="dot">&middot;</span>` : ""}
        <span>${paper.date || "无日期"}</span>
      </div>
      ${paper.doi && paper.pdfSource
        ? `<div class="paper-doi">DOI: <a href="https://doi.org/${paper.doi}" target="_blank">${paper.doi}</a></div>`
        : paper.detailUrl ? `<div class="paper-doi"><a href="${paper.detailUrl}" target="_blank">查看详情 →</a></div>` : ""}
      ${abstractHtml}
      <div class="paper-bottom">
        <div class="paper-stats">
          ${paper.pdfSource ? `<span class="pdf-source-tag pdf-source-${paper.pdfSource.toLowerCase()}">${paper.pdfSource}</span>` : `<span>被引 <strong>${paper.quote || 0}</strong></span><span>下载 <strong>${paper.download || 0}</strong></span>`}
          ${levelHtml}
        </div>
        <div class="paper-action" data-id="${paper.id}">
          ${renderAction(paper.id, paper.pdfLink)}
        </div>
      </div>
      ${kwHtml ? `<div class="keyword-tags">${kwHtml}</div>` : ""}
    </div>
  `;
  return card;
}

function renderLevel(level) {
  if (!settings.fetchLevels || !level || level === "Wait" || level === "无") return "";
  return level.split("/").map((l) => `<span class="level-tag">${l}</span>`).join(" ");
}

function renderAction(id, pdfLink) {
  const state = downloadState[id];
  if (!state) {
    if (pdfLink) return `<button class="dl-btn" data-id="${id}">PDF</button>`;
    const paper = papers.find((p) => p.id === id);
    if (paper?.pdfFailed) return `<span class="failed-tag">未找到链接</span>`;
    return `<span class="pending-tag">待获取链接</span>`;
  }
  if (state.status === "downloading") return `<span class="status status-downloading"><span class="spinner"></span>下载中</span>`;
  if (state.status === "success") return `<span class="status status-success">&#10003; 完成</span>`;
  if (state.status === "error") return `<span class="status status-error" title="${state.error}">&#10007; 失败</span><button class="retry-btn" data-id="${id}">重试</button>`;
  return "";
}

function updateCardState(id) {
  const card = document.querySelector(`.paper-card[data-id="${id}"]`);
  if (!card) return;
  card.dataset.status = downloadState[id]?.status || "";
  const el = card.querySelector(".paper-action");
  if (el) el.innerHTML = renderAction(id, papers.find((p) => p.id === id)?.pdfLink);
}

function updateCardLevel(id, level) {
  const card = document.querySelector(`.paper-card[data-id="${id}"]`);
  if (!card) return;
  const stats = card.querySelector(".paper-stats");
  if (!stats) return;
  stats.querySelectorAll(".level-tag").forEach((el) => el.remove());
  const html = renderLevel(level);
  if (html) stats.insertAdjacentHTML("beforeend", html);
}

function updateSortPills() {
  $$(".sort-pill").forEach((p) => p.classList.toggle("active", p.dataset.sort === sortField));
}

function getSelectedIds() {
  return Array.from($$(".paper-check:checked")).map((cb) => parseInt(cb.dataset.id));
}

function restoreChecks() {
  $$(".paper-check").forEach((cb) => { if (!cb.disabled) cb.checked = true; });
}

function updateFooter() {
  const total = papers.length;
  const ready = papers.filter((p) => p.pdfLink).length;
  const selected = $$(".paper-check:checked").length;
  const done = Object.values(downloadState).filter((s) => s.status === "success").length;
  const failed = Object.values(downloadState).filter((s) => s.status === "error").length;
  const parts = [`${total} 篇`];
  if (ready < total) parts.push(`${ready} 可下载`);
  if (selected > 0) parts.push(`已选 ${selected}`);
  if (done > 0) parts.push(`完成 ${done}`);
  if (failed > 0) parts.push(`失败 ${failed}`);
  $("#footer-status").textContent = parts.join("  ·  ");
  $("#dl-count").textContent = selected > 0 ? `(${selected})` : "";
  $("#list-count").textContent = `${total} 篇`;
  const retryBtn = $("#btn-retry-failed");
  if (retryBtn) retryBtn.hidden = failed === 0;
}

function setProgress(pct, text) {
  $("#progress").hidden = false;
  $("#progress-fill").style.width = pct + "%";
  if (text) $("#progress-text").textContent = text;
}

function hideProgress() {
  $("#progress").hidden = true;
  $("#progress-fill").style.width = "0";
}

// ── Cite Menu (Floating UI) ──

let citeMenuEl = null;

function ensureCiteMenu() {
  if (citeMenuEl) return citeMenuEl;
  const el = document.createElement("div");
  el.className = "cite-menu";
  el.hidden = true;
  el.innerHTML = `
    <button class="cite-menu-item" data-style="plain">复制原始信息</button>
    <button class="cite-menu-item" data-style="gb7714">复制 GB7714 引用</button>
    <button class="cite-menu-item" data-style="apa">复制 APA 引用</button>
    <button class="cite-menu-item" data-style="mla">复制 MLA 引用</button>
  `;
  document.body.appendChild(el);

  el.addEventListener("click", async (e) => {
    const item = e.target.closest(".cite-menu-item");
    if (!item) return;
    const style = item.dataset.style;
    const id = parseInt(el.dataset.paperId);
    const paper = papers.find((p) => p.id === id);
    if (!paper) { hideCiteMenu(); return; }
    hideCiteMenu();
    const btn = document.querySelector(`.copy-info-btn[data-id="${id}"]`);
    if (btn) btn.classList.add("loading");
    try {
      const text = await getCitation(paper, style);
      await navigator.clipboard.writeText(text);
      if (btn) {
        btn.classList.remove("loading");
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1500);
      }
    } catch (err) {
      if (btn) btn.classList.remove("loading");
      addLog("error", "复制引用失败", err.message || String(err));
    }
  });

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (!el.hidden && !e.target.closest(".cite-menu") && !e.target.closest(".copy-info-btn")) {
      hideCiteMenu();
    }
  });

  // Close on scroll within the paper list (so it doesn't drift)
  const list = document.getElementById("paper-list");
  if (list) list.addEventListener("scroll", hideCiteMenu, true);
  window.addEventListener("resize", hideCiteMenu);

  citeMenuEl = el;
  return el;
}

function showCiteMenu(btn, paperId) {
  const menu = ensureCiteMenu();
  menu.dataset.paperId = String(paperId);
  menu.hidden = false;
  const rect = btn.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + "px";
  menu.style.right = (window.innerWidth - rect.right) + "px";
  menu.style.left = "auto";
}

function hideCiteMenu() {
  if (citeMenuEl) citeMenuEl.hidden = true;
}

// ── Export Menu (Floating UI) ──

let exportMenuEl = null;

function ensureExportMenu() {
  if (exportMenuEl) return exportMenuEl;
  const el = document.createElement("div");
  el.className = "cite-menu export-menu";
  el.hidden = true;
  el.innerHTML = `
    <div class="cite-menu-hint" id="export-menu-hint"></div>
    <button class="cite-menu-item" data-format="copy-gb7714">复制 GB7714 引用</button>
    <button class="cite-menu-item" data-format="copy-apa">复制 APA 引用</button>
    <button class="cite-menu-item" data-format="copy-mla">复制 MLA 引用</button>
    <div class="cite-menu-sep"></div>
    <button class="cite-menu-item" data-format="csv">导出为 CSV (Excel)</button>
    <button class="cite-menu-item" data-format="bibtex">导出为 BibTeX</button>
    <button class="cite-menu-item" data-format="ris">导出为 RIS (EndNote)</button>
  `;
  document.body.appendChild(el);

  el.addEventListener("click", async (e) => {
    const item = e.target.closest(".cite-menu-item");
    if (!item) return;
    const format = item.dataset.format;
    hideExportMenu();
    await doExport(format);
  });

  document.addEventListener("click", (e) => {
    if (!el.hidden && !e.target.closest(".export-menu") && !e.target.closest("#btn-export")) {
      hideExportMenu();
    }
  });

  window.addEventListener("resize", hideExportMenu);
  exportMenuEl = el;
  return el;
}

function showExportMenu(btn) {
  const menu = ensureExportMenu();
  // Update hint text based on current selection
  const selectedCount = $$(".paper-check:checked").length;
  const totalCount = papers.length;
  const hint = menu.querySelector("#export-menu-hint");
  if (hint) {
    hint.textContent = selectedCount > 0
      ? `将导出已勾选的 ${selectedCount} 篇`
      : `将导出全部 ${totalCount} 篇`;
  }
  menu.hidden = false;
  const rect = btn.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + "px";
  menu.style.right = (window.innerWidth - rect.right) + "px";
  menu.style.left = "auto";
}

function hideExportMenu() {
  if (exportMenuEl) exportMenuEl.hidden = true;
}

async function doExport(format) {
  // Use selected papers if any, otherwise all
  const selectedIds = getSelectedIds();
  const targets = selectedIds.length > 0
    ? papers.filter((p) => selectedIds.includes(p.id))
    : papers;
  if (targets.length === 0) {
    $("#footer-status").textContent = "没有可导出的文献";
    return;
  }

  // Bulk copy citation text to clipboard
  if (format.startsWith("copy-")) {
    const style = format.slice(5);
    $("#footer-status").textContent = `正在获取 ${style.toUpperCase()} 引用...`;
    let map = new Map();
    try {
      map = await fetchOfficialCitations(targets, style);
    } catch (err) {
      addLog("error", "批量获取引用失败", err.message || String(err));
    }
    const lines = targets.map((p) => {
      if (map.get(p.id)) return map.get(p.id);
      if (citationCache[p.id]?.[style]) return citationCache[p.id][style];
      return formatCitation(p, style);
    }).filter(Boolean);
    if (lines.length === 0) {
      $("#footer-status").textContent = "没有可复制的引用";
      return;
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      $("#footer-status").textContent = `已复制 ${lines.length} 篇 ${style.toUpperCase()} 引用到剪切板`;
    } catch (err) {
      $("#footer-status").textContent = "复制失败: " + (err.message || err);
    }
    return;
  }

  const ts = new Date().toISOString().slice(0, 10);
  const baseName = `cnki-papers-${ts}-${targets.length}`;
  let filename = "", content = "", mime = "";
  if (format === "csv") {
    filename = baseName + ".csv";
    content = papersToCSV(targets);
    mime = "text/csv";
  } else if (format === "bibtex") {
    filename = baseName + ".bib";
    content = papersToBibTeX(targets);
    mime = "application/x-bibtex";
  } else if (format === "ris") {
    filename = baseName + ".ris";
    content = papersToRIS(targets);
    mime = "application/x-research-info-systems";
  } else {
    return;
  }
  try {
    await downloadAsFile(filename, content, mime);
    $("#footer-status").textContent = `已导出 ${targets.length} 篇为 ${format.toUpperCase()}`;
  } catch (err) {
    $("#footer-status").textContent = "导出失败: " + (err.message || err);
  }
}

// ── Events ──
// ── DOI Import ──
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
};

function parseDois(text) {
  const pattern = /10\.[0-9]{4,9}\/[-._;()/:a-zA-Z0-9]+/g;
  const matches = text.match(pattern) || [];
  return [...new Set(matches)]; // 去重
}

async function fetchPdfByDoi(doi) {
  let meta = { title: "", source: "", date: "", author: "" };
  let pdfLink = "", pdfSource = "";

  // Step 1: Unpaywall — 获取元数据 + OA PDF
  try {
    const res = await sendToBackground({
      type: "FETCH_TEXT",
      url: `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=cnkihelper@heykee.com`,
      timeoutMs: 5000,
    });
    if (res?.ok && res.text) {
      const data = JSON.parse(res.text);
      meta.title = data.title || "";
      meta.source = data.journal_name || "";
      meta.date = data.year ? String(data.year) : "";
      meta.author = (data.z_authors || []).map((a) => a.family || "").filter(Boolean).join("; ");
      const oaUrl = data?.best_oa_location?.url_for_pdf;
      if (oaUrl) { pdfLink = oaUrl; pdfSource = "Unpaywall"; }
    }
  } catch {}

  if (pdfLink) return { pdfLink, pdfSource, ...meta };

  // Step 2: bban.top 直链兜底
  try {
    const bbanUrl = `https://sci.bban.top/pdf/${doi}.pdf?download=true`;
    const res = await sendToBackground({ type: "FETCH_TEXT", url: bbanUrl, timeoutMs: 10000, headers: BROWSER_HEADERS });
    if (res?.ok && res.text && !res.text.trimStart().startsWith("<")) {
      pdfLink = bbanUrl;
      pdfSource = "Sci-Hub";
    }
  } catch {}

  if (pdfLink) return { pdfLink, pdfSource, ...meta };
  if (meta.title) return { pdfLink: "", pdfSource: "", ...meta }; // 有元数据但无PDF
  return null;
}

let doiImportCancelled = false;
let doiFailedList = [];

async function importDois() {
  const text = $("#doi-input").value.trim();
  const dois = parseDois(text);
  if (dois.length === 0) { $("#doi-count").textContent = "未识别到有效 DOI"; return; }

  doiImportCancelled = false;
  doiFailedList = [];
  const btn = $("#btn-doi-import");
  const stopBtn = $("#btn-doi-stop");
  const copyFailedBtn = $("#btn-doi-copy-failed");
  btn.hidden = true;
  stopBtn.hidden = false;
  copyFailedBtn.hidden = true;

  let done = 0;
  const setDoiProgress = (pct, msg) => {
    $("#doi-progress").hidden = false;
    $("#doi-progress-fill").style.width = pct + "%";
    $("#doi-progress-text").textContent = msg;
  };
  setDoiProgress(0, `查询 0/${dois.length}`);

  const existingDois = new Set(papers.map((p) => p.doi).filter(Boolean));
  let added = 0, notFound = 0;

  const duplicates = dois.filter((doi) => existingDois.has(doi));
  const queue = dois.filter((doi) => !existingDois.has(doi));

  if (queue.length === 0) {
    $("#doi-count").textContent = duplicates.length > 0
      ? `${duplicates.length} 个 DOI 已在列表中，无需重复导入`
      : "未识别到有效 DOI";
    btn.hidden = false;
    stopBtn.hidden = true;
    copyFailedBtn.hidden = true;
    $("#doi-progress").hidden = true;
    return;
  }

  const CONCURRENCY = 2;

  async function processOne(doi) {
    const result = await fetchPdfByDoi(doi);
    const paper = {
      id: Math.abs(`doi:${doi}`.split("").reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)),
      doi,
      title: result?.title || doi,
      detailUrl: `https://doi.org/${doi}`,
      pdfLink: result?.pdfLink || "",
      pdfFailed: result !== null && !result?.pdfLink,
      pdfSource: result?.pdfSource || "",
      source: result?.source || "",
      date: result?.date || "",
      author: result?.author || "",
      keywords: "", quote: "0", download: "0", sourceUrl: "", level: "Wait",
    };
    if (!result?.pdfLink) {
      if (!result) addLog("error", `未找到任何信息: ${doi}`, `DOI: ${doi}`);
      else addLog("error", `未找到下载链接: ${result.title || doi}`, `DOI: ${doi}`);
      doiFailedList.push(doi);
      notFound++;
    }
    papers.push(paper);
    existingDois.add(doi);
    added++;
    done++;
    setDoiProgress(Math.round((done / dois.length) * 100), `查询 ${done}/${dois.length}`);
    renderList();
    restoreChecks();
    updateFooter();
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0 && !doiImportCancelled) {
      await processOne(queue.shift());
    }
  });
  await Promise.all(workers);

  await savePapers();
  $("#doi-progress").hidden = true;
  $("#doi-count").textContent = doiImportCancelled
    ? `已停止，已导入 ${added} 篇`
    : `已导入 ${added} 篇，${notFound} 篇未找到链接`;
  btn.hidden = false;
  stopBtn.hidden = true;
  copyFailedBtn.hidden = doiFailedList.length === 0;
}

// ── Nav Tab Switch ──
function switchTab(feature) {
  $$(".nav-item").forEach((btn) => btn.classList.toggle("active", btn.dataset.feature === feature));
  $$(".feature").forEach((el) => { el.hidden = el.id !== `feature-${feature}`; });
}

function bindEvents() {
  // Download folder
  $("#input-folder").addEventListener("input", async (e) => {
    settings.downloadFolder = e.target.value.trim();
    await chrome.storage.local.set({ downloadFolder: settings.downloadFolder });
    const tip = $("#folder-tip");
    if (settings.downloadFolder) {
      tip.textContent = "需关闭Chrome「下载前询问保存位置」";
    } else {
      tip.textContent = "";
    }
  });

  // Nav tab switch
  $$(".nav-item[data-feature]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.feature));
  });

  // DOI import
  $("#doi-input").addEventListener("input", () => {
    const dois = parseDois($("#doi-input").value);
    $("#doi-count").textContent = dois.length > 0 ? `识别到 ${dois.length} 个 DOI` : "";
  });
  $("#btn-doi-import").addEventListener("click", importDois);
  $("#btn-doi-stop").addEventListener("click", () => { doiImportCancelled = true; });
  $("#btn-doi-copy-failed").addEventListener("click", () => {
    navigator.clipboard.writeText(doiFailedList.join("\n")).then(() => {
      const btn = $("#btn-doi-copy-failed");
      const orig = btn.textContent;
      btn.textContent = "已复制！";
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  });

  // Add all papers from current page
  $("#btn-add-page").addEventListener("click", async () => {
    const ok = await ensureContentScript();
    if (!ok) { $("#footer-status").textContent = "请在知网页面使用"; return; }
    try {
      const result = await sendToContent({ type: "ADD_ALL_PAGE", useWebVPN: settings.useWebVPN });
      if (!result?.ok) {
        $("#footer-status").textContent = result?.error === "no_links" ? "当前页未找到文献" : "添加失败";
        return;
      }
      // Reset sort to default (insertion order) after adding
      if (result.added > 0 && sortField !== "") {
        sortField = "";
        sortDir = "desc";
        saveSort();
      }
      // Storage change will trigger renderList via onChanged listener
      $("#footer-status").textContent = result.added > 0
        ? `已添加 ${result.added} 篇 (本页共 ${result.total} 篇)`
        : `本页 ${result.total} 篇均已在列表中`;
    } catch (err) {
      $("#footer-status").textContent = "添加失败: " + err.message;
    }
  });

  // Fetch PDF links for pending papers
  $("#btn-fetch-links").addEventListener("click", fetchPdfLinks);

  // Batch download
  $("#btn-batch-dl").addEventListener("click", () => downloadSelected());

  // Retry failed
  $("#btn-retry-failed").addEventListener("click", () => retryFailed());
  $("#btn-resume").addEventListener("click", () => resumeDownload());

  // Clear
  $("#btn-clear").addEventListener("click", async () => {
    papers = [];
    Object.keys(downloadState).forEach((k) => delete downloadState[k]);
    pendingResumeIds = [];
    consecutiveFails = 0;
    Object.keys(citationCache).forEach((k) => delete citationCache[k]);
    await savePapers();
    renderList();
    updateResumeButton();
    updateFooter();
  });

  // Export menu (toggle)
  $("#btn-export").addEventListener("click", (e) => {
    e.stopPropagation();
    if (exportMenuEl && !exportMenuEl.hidden) {
      hideExportMenu();
    } else {
      showExportMenu(e.currentTarget);
    }
  });

  // Select all
  $("#select-all").addEventListener("change", (e) => {
    $$(".paper-check").forEach((cb) => { if (!cb.disabled) cb.checked = e.target.checked; });
    updateFooter();
  });

  // Sort
  $$(".sort-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      const field = pill.dataset.sort;
      if (sortField === field) { sortDir = sortDir === "desc" ? "asc" : "desc"; }
      else { sortField = field; sortDir = field === "date" ? "asc" : "desc"; }
      saveSort();
      renderList();
      restoreChecks();
      updateFooter();
    });
  });

  // Paper list clicks
  $("#paper-list").addEventListener("click", (e) => {
    const dl = e.target.closest(".dl-btn");
    if (dl) { downloadPaper(parseInt(dl.dataset.id)); return; }
    const retry = e.target.closest(".retry-btn");
    if (retry) { downloadPaper(parseInt(retry.dataset.id)); return; }

    // Abstract toggle
    const absBtn = e.target.closest(".abstract-toggle-btn");
    if (absBtn) {
      const card = absBtn.closest(".paper-card");
      const absEl = card?.querySelector(".paper-abstract");
      if (absEl) {
        absEl.hidden = !absEl.hidden;
        absBtn.classList.toggle("active", !absEl.hidden);
      }
      return;
    }

    // Copy / cite menu (toggle floating menu)
    const copyBtn = e.target.closest(".copy-info-btn");
    if (copyBtn) {
      e.stopPropagation();
      const id = parseInt(copyBtn.dataset.id);
      if (citeMenuEl && !citeMenuEl.hidden && parseInt(citeMenuEl.dataset.paperId) === id) {
        hideCiteMenu();
      } else {
        showCiteMenu(copyBtn, id);
      }
      return;
    }
  });

  // Checkbox changes
  $("#paper-list").addEventListener("change", (e) => {
    if (e.target.classList.contains("paper-check")) updateFooter();
  });

  // Toggles
  $("#toggle-webvpn").addEventListener("change", async (e) => {
    settings.useWebVPN = e.target.checked;
    await chrome.storage.local.set({ useWebVPN: settings.useWebVPN });
  });
  $("#toggle-levels").addEventListener("change", async (e) => {
    settings.fetchLevels = e.target.checked;
    await chrome.storage.local.set({ fetchLevels: settings.fetchLevels });
    renderList();
    restoreChecks();
    updateFooter();
    if (settings.fetchLevels) loadAllLevels();
  });
  $("#toggle-auto-open-verify").addEventListener("change", async (e) => {
    settings.autoOpenOnVerify = e.target.checked;
    await chrome.storage.local.set({ autoOpenOnVerify: settings.autoOpenOnVerify });
  });

  // Log panel
  $("#log-toggle").addEventListener("click", () => { $("#log-panel").hidden = !$("#log-panel").hidden; });
  $("#log-clear").addEventListener("click", () => { logs.length = 0; $("#log-list").innerHTML = ""; updateLogBadge(); $("#log-panel").hidden = true; });
  $("#log-copy-all").addEventListener("click", () => {
    const text = logs.filter((l) => l.level === "error").map((l) => `[${l.time}] ${l.title}\n  ${l.detail}`).join("\n\n");
    navigator.clipboard.writeText(text);
  });

  // Real-time storage sync (papers added from content script)
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.cnkiPapers) return;
    papers = changes.cnkiPapers.newValue || [];
    renderList();
    restoreChecks();
    updateFooter();
  });
}

// Show a dashed placeholder if the tip QR image hasn't been added yet.
function setupTipQrFallback() {
  const img = document.querySelector(".tip-qr-img");
  const ph = document.querySelector(".tip-qr-placeholder");
  if (!img || !ph) return;
  const showPh = () => { img.hidden = true; ph.hidden = false; };
  img.addEventListener("error", showPh);
  if (img.complete && img.naturalWidth === 0) showPh();
}

// ── Update Notes ──
const CURRENT_VERSION = "1.2.1";
const UPDATE_NOTE = 'v1.2.1 更新：修复插件改名后的兼容问题，DOI 下载失败不再触发批量暂停，优化权限范围';

async function checkUpdate() {
  const data = await chrome.storage.local.get(["lastSeenVersion"]);
  if (data.lastSeenVersion === CURRENT_VERSION) return;
  $("#update-text").innerHTML = UPDATE_NOTE;
  $("#update-banner").hidden = false;
  $("#update-close").addEventListener("click", async () => {
    $("#update-banner").hidden = true;
    await chrome.storage.local.set({ lastSeenVersion: CURRENT_VERSION });
  });
}

// ── Init ──
async function init() {
  await loadSettings();
  $("#toggle-webvpn").checked = settings.useWebVPN;
  $("#toggle-levels").checked = settings.fetchLevels;
  $("#toggle-auto-open-verify").checked = settings.autoOpenOnVerify;
  $("#input-folder").value = settings.downloadFolder;
  if (settings.downloadFolder) $("#folder-tip").textContent = "需关闭Chrome「下载前询问保存位置」";
  bindEvents();
  setupTipQrFallback();
  renderList();
  checkUpdate();
  if (papers.length > 0) {
    setTimeout(() => { restoreChecks(); updateFooter(); if (settings.fetchLevels) loadAllLevels(); }, 50);
  }
}

init();
