# 回归验证

2026-09-23：45 项自动测试及最终浏览器集成回归通过。仅本地提交，未推送、打 tag 或发布。

## 自动测试

无需新增依赖：`node --test tests/*.test.cjs`。

覆盖域名标准化、权限拒绝/撤销、动态注册、原有页面选择和 MAIN world iframe 调用；下载归属、中断、启动/完成超时、监听与文件夹标记清理；清单并发合并、旧回复隔离、选择导出、解析重试、DOI 去重重试、作者和安全文本渲染、PDF 文件头。

本轮新增 3 项文件名回归：API 回调晚于文件名事件、相同 URL 并发下载不串名；后台休眠后按下载 ID 恢复文件名；启动失败/中断/提前完成后清理记录。DOI 使用指定子目录，导出保留文件名及“另存为”，不继承文献目录。

## 最终浏览器回归

使用官方 Chrome for Testing **153.0.8010.53**，独立用户目录；与日常 Chrome 分开。页面、DOI 元数据和 PDF 均由 `browser-fixture.py` 在本机提供，通过测试浏览器进程的域名映射接入。没有真实图书馆账号，没有改写代理编码规则，也没有改动日常浏览器设置。

`browser-integration.js` 完整运行通过，并核对本轮新下载的 Chrome `complete` 状态及磁盘文件，避免历史下载记录误入结果。

| 场景 | 实际结果 |
|---|---|
| 粘贴完整网址 | 去掉路径、参数和端口，只保存 `library.hb.cn`，注册 `*://*.library.hb.cn/*` |
| 直连 `https://kns.cnki.net:18543` | 收藏 → 解析 → 原有 iframe 下载成功 |
| 教育网 `http://webvpn.school.edu.cn:18580` | 收藏、WebVPN 解析及下载成功 |
| 自定义代理 | 根域名 HTTPS、`ycfw` 子域名 HTTP、`alias` 子域名 HTTPS 均成功；不限定 8000 端口 |
| 重定向与文件夹 | 保留原始请求地址、端口、代理路径及页面 Referer；按原始 URL 归属，5 份 PDF 保存到指定子目录 |
| 勾选与导出 | 排序/重载保留取消选择；无 PDF 文献可选中导出，CSV 已读回作者及标题 |
| 失败与清空 | 503 后重试成功；安全验证页暂停；清空后延迟返回的解析结果未复活文献 |
| 其他下载 | 验证码失败后，另一份下载未继承文献目录 |
| DOI | JSON 假 PDF 被拒绝，重试更新原记录并保留勾选；作者完整，HTML 标签按文字显示；PDF 实际保存到指定目录 |
| 普通图书馆页 | 未误加文献收藏按钮 |

HTTP 样例触发了 Chrome 的“不安全下载”确认；本轮只在下载记录中确认了本机生成的测试 PDF，没有关闭全局安全保护。未确认时，插件等待超时后提示检查浏览器下载列表，未标记成功。

自动化导出部分仅在隔离测试页临时把 `saveAs` 改为自动保存，其他下载 API 和文件名事件仍为真实 Chrome 实现。随后又单独使用未修改的导出流程，核对原生“另存为”对话框的默认名称和位置、点击保存，并读回 230 字节的 DOI 元数据 CSV。无 PDF 元数据 CSV 为 217 字节；测试 PDF 均核对 `%PDF-1.4` 文件头及完整文件尾。

本轮发现并补修了模拟 API 未覆盖的文件名问题：Chrome 文件名监听可能让 API 指定的名称/目录被服务器名称覆盖。现在 API 下载名称按 ID 登记，在文件名事件中恢复；后台休眠使用会话存储恢复，完成/中断清理。参见 [Chrome downloads 文档](https://developer.chrome.com/docs/extensions/reference/api/downloads#event-onDeterminingFilename)。

本地结果位于忽略提交的 `output/playwright/integration-results.json`、`integration-final.png` 和 `integration-downloads/`。

## 重跑方式

仅在专用测试浏览器配置中运行；脚本会清空测试清单、更改测试域名和目录，并产生下载文件。

1. 为本地测试服务生成临时证书，运行 `python3 tests/browser-fixture.py --cert <证书> --key <私钥>`。服务仅监听 `127.0.0.1:18580` 和 `127.0.0.1:18543`。
2. 启动独立 Chrome for Testing，加载 `extension/`，开启该测试配置的开发者模式。使用该进程的 `--host-resolver-rules` 将 `kns.cnki.net`、`*.school.edu.cn`、`library.hb.cn`、`*.library.hb.cn` 指向本机；固定 HTTPS API `api.unpaywall.org`、`sci.bban.top` 指向 `127.0.0.1:18543`。只通过 `--ignore-certificate-errors-spki-list` 信任临时证书的 SPKI，不安装系统证书。
3. 在测试配置里把默认下载目录设为独立输出目录，并允许本地样例的多文件下载。用插件设置实际授权 `library.hb.cn`，不要在日常配置里做这些操作。
4. Playwright CLI 通过 CDP 接入该浏览器，打开侧边栏页面，以 `run-code` 执行 `browser-integration.js` 的函数。保持页面前台，HTTP 样例的确认操作仅用于上述本地文件。
5. 读取 `window.integrationResults`，再检查记录指向的真实文件。原生“另存为”需要另行在有界面的测试浏览器中确认，不能用自动保存替代这项验收。

`browser-state.js`、`browser-doi.js` 是早先的分项脚本。最终整合优先使用本地服务，避免路由拦截遗漏 Service Worker 首次请求。

## 验证边界

早先的 Chrome for Testing 154 测试构建曾发生原生 `EXC_BAD_ACCESS / SIGSEGV`，失败轮次未算通过。换用 153.0.8010.53 后，本轮完整集成及原生另存为均完成，没有再次出现原生崩溃。

仍需发布前用实际已登录的知网及湖北图书馆代理账号验收。当前结果证明本地模拟页面上的插件接入、解析、浏览器下载和保存链路，不能推断真实账号权限、验证码、额度或未知 WebVPN 页面结构已经通过。
