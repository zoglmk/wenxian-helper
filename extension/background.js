/* Service Worker - handles networking, downloads, and side panel setup */
importScripts("proxy-domains.js", "download-tracking.js");

// 动态脚本跨重启保留；启动和外部撤销权限时核对注册状态。
function syncProxyDomains() {
  ProxyDomains.update("sync").catch((err) => console.error("代理域名同步失败:", err));
}
syncProxyDomains();
chrome.permissions.onRemoved.addListener(syncProxyDomains);

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

async function handleSaveDownload({ url, filename, useFolder }) {
  await folderReady;
  const folder = useFolder ? DownloadTracking.folderName(cachedDownloadFolder) : "";
  if (folder) filename = `${folder}/${filename}`;
  const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
  return { ok: true, downloadId };
}

// 缓存文件夹设置
let cachedDownloadFolder = "";
const folderReady = chrome.storage.local.get(["downloadFolder"]).then((data) => {
  cachedDownloadFolder = (data.downloadFolder || "").trim();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.downloadFolder !== undefined) {
    cachedDownloadFolder = (changes.downloadFolder.newValue || "").trim();
  }
});

// 标记限于一个原始 URL，失败、验证码和等待结束后主动清理；遗留标记 15 秒过期。
const pendingDownloads = new Map();
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  for (const [token, task] of pendingDownloads) {
    if (task.expires <= Date.now()) { pendingDownloads.delete(token); continue; }
    if (!DownloadTracking.matches(item, task.url)) continue;
    pendingDownloads.delete(token);
    const basename = item.filename.split(/[\\/]/).pop();
    if (task.folder && basename) suggest({ filename: `${task.folder}/${basename}`, conflictAction: "uniquify" });
    else suggest();
    return;
  }
  suggest();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return;

  const handle = async () => {
    try {
      if (msg.type === "FETCH_TEXT") return await handleFetchText(msg);
      if (msg.type === "FETCH_POST") return await handleFetchPost(msg);
      if (msg.type === "SAVE_DOWNLOAD") return await handleSaveDownload(msg);
      if (msg.type === "MARK_DOWNLOAD") {
        if (!DownloadTracking.matches({ url: msg.url }, msg.url)) throw new Error("无效下载地址");
        await folderReady;
        const token = crypto.randomUUID();
        pendingDownloads.set(token, { url: msg.url, folder: DownloadTracking.folderName(cachedDownloadFolder), expires: Date.now() + 15000 });
        return { ok: true, token };
      }
      if (msg.type === "UNMARK_DOWNLOAD") { pendingDownloads.delete(msg.token); return { ok: true }; }
      if (msg.type === "UPDATE_PROXY_DOMAIN") {
        // 网站内容脚本无权修改域名设置。
        if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("sidepanel/index.html")) {
          throw new Error("请从文献助手设置中修改代理域名");
        }
        const domains = await ProxyDomains.update(msg.action, msg.domain);
        return { ok: true, domains };
      }
      return { ok: false, error: "unknown_type" };
    } catch (err) {
      return { ok: false, error: err?.message || "unknown_error" };
    }
  };

  handle().then(sendResponse);
  return true;
});
