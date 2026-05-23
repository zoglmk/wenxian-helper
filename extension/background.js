/* Service Worker - handles networking, downloads, and side panel setup */

// Open side panel on extension icon click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function handleFetchText({ url, referrer, timeoutMs, headers }) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      referrer: referrer || undefined,
      signal: controller.signal,
      headers: headers || {},
    });
    return { ok: res.ok, status: res.status, text: await res.text(), finalUrl: res.url };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleFetchPost({ url, body, referrer, headers }) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      ...(headers || {}),
    },
    body: body || "",
    redirect: "follow",
    referrer: referrer || undefined,
  });
  return { ok: res.ok, status: res.status, text: await res.text(), finalUrl: res.url };
}

async function handleSaveDownload({ url, filename }) {
  const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
  return { ok: true, downloadId };
}

// 缓存文件夹设置
let cachedDownloadFolder = "";
chrome.storage.local.get(["downloadFolder"]).then((data) => {
  cachedDownloadFolder = (data.downloadFolder || "").trim();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.downloadFolder !== undefined) {
    cachedDownloadFolder = (changes.downloadFolder.newValue || "").trim();
  }
});

// 插件待处理的下载计数（只有插件主动标记的下载才应用文件夹）
let pluginDownloadPending = 0;

// 拦截知网 iframe 触发的下载，仅对插件标记的下载加文件夹前缀
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (pluginDownloadPending <= 0) { suggest(); return; }
  pluginDownloadPending--;
  const folder = cachedDownloadFolder.replace(/[\/:*?"<>|\\]/g, "_");
  if (!folder) { suggest(); return; }
  const basename = item.filename.split(/[\\/]/).pop() || item.filename;
  suggest({ filename: folder + "/" + basename, conflictAction: "uniquify" });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return;

  const handle = async () => {
    try {
      if (msg.type === "FETCH_TEXT") return await handleFetchText(msg);
      if (msg.type === "FETCH_POST") return await handleFetchPost(msg);
      if (msg.type === "SAVE_DOWNLOAD") return await handleSaveDownload(msg);
      if (msg.type === "MARK_DOWNLOAD") { pluginDownloadPending++; return { ok: true }; }
      return { ok: false, error: "unknown_type" };
    } catch (err) {
      return { ok: false, error: err?.message || "unknown_error" };
    }
  };

  handle().then(sendResponse);
  return true;
});
