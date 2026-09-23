# 回归验证

## v1.3.0 反馈修复与设置交互（2026-09-23，最新执行）

在前一轮补丁 `3608cc6` 上继续，保留知网原有下载路径、权限范围和全部既有修改。ProQuest 范围经用户追加为学位论文、期刊及当前登录会话可访问的全文；下方历史记录中的“仅公开、匿名详情请求”不再代表本轮实现。功能与文案一起同步现有草稿 PR，仍待用户验收后合并、打 tag 和发布。

### 改动和回归覆盖

- 「添加本页」在回复后读取最新存储快照，显示 `共 40 篇 · 本次新增 20 篇`，重复添加显示新增 0；不依赖存储通知恰好先到达。沿用清空后的任务失效判断。
- ProQuest 增加期刊 `jnlArticle`、实际页面的“开放阅览”标记、完整作者、卷期页及 DOI。搜索页仅标“全文文献”的学位论文和期刊先收藏待确认，预览和仅摘要跳过；详情和下载阶段才确认权限。期刊按文章类型导出，学位论文沿用原类型。
- 详情请求使用当前浏览器会话并禁用缓存。允许明确公开全文，或当前详情同时提供全文标记与有效非预览媒体入口的文献；每次下载重新检查权限和新签名，再验证 PDF 响应。退出登录或权限失效会跳过，不触发订购。原重试锁、指定 ID、清空隔离及旧文献兼容保留。
- 域名说明更新为搜索结果页地址和授权提示；域名、指定文件夹为同级折叠设置，均默认收起。「稳定性」提示改为「自定义域名」。文件夹只有点击「保存」后生效，区分尚未保存、已保存、恢复默认及保存失败；保存过程中继续输入不会被迟到结果覆盖。

先新增计数、期刊解析/收藏用例，修复前 3 项失败；会话请求用例随后复现匿名请求问题，权限确认用例也在实现前失败。新增及扩展用例覆盖真实点击入口、队列和 Chrome 文件 API，不只测试解析函数。此轮比前一轮净增加 **9 项 Node 测试**：计数、期刊元数据/导出、收藏候选、会话权限、权限撤销、带会话无缓存请求、`available` 卡片重试，以及两项文件夹保存状态/失败/并发草稿测试。

### 实际执行结果

| 验证 | 命令 / 脚本 | 通过 / 失败 |
|---|---|---|
| Node 自动测试 | `node --test tests/*.test.cjs` | 81 / 0 |
| 计数与期刊 | `playwright-cli -s=feedback run-code --filename tests/browser-journal-feedback.js` | 5 / 0 |
| 登录权限本地样例 | `playwright-cli -s=feedback run-code --filename tests/browser-proquest-session.js` | 4 / 0 |
| 原 ProQuest 场景 | `playwright-cli -s=feedback run-code --filename tests/browser-proquest.js` | 7 / 0 |
| 前一轮两项补丁 | `playwright-cli -s=feedback run-code --filename tests/browser-release-patch.js` | 9 / 0 |
| 原有知网、代理及 DOI 集成 | `playwright-cli -s=feedback run-code --filename tests/browser-integration.js` | 10 / 0 |
| 混合来源队列 | `playwright-cli -s=feedback run-code --filename tests/browser-mixed-download.js` | 1 / 0 |
| 设置交互与窄侧栏 | `playwright-cli -s=feedback run-code --filename tests/browser-settings.js` | 4 / 0 |

共 40 组浏览器检查，使用独立 Chrome for Testing 153.0.8010.53、CDP 19223、本地 fixture，命令通过 Playwright skill 的 CLI wrapper 执行。新增文件夹保存操作后另外重跑混合队列，确认实际保存目录；其余浏览器脚本同步增加展开和保存步骤。设置检查覆盖 430px 和 320px 宽度、同级标题、默认折叠、草稿不生效、保存反馈、重载保留及留空恢复。实际读回上述通过场景引用的 **20 份 PDF、1 份 CSV**：PDF 文件头、文件尾及单页结构正确，CSV 标题和作者有效。

原旧学位论文 fixture 中用于排除的未知条目改为仅摘要；本轮允许收藏“全文”候选，其权限排除由新的期刊和会话样例覆盖，并未取消预览、未知权限或 HTML 拦截。初次计数脚本在后台标签页的动画帧轮询超时，改用有界定时轮询后通过；登录脚本初次仍命中 Chrome 缓存的旧后台，重新加载扩展后用虚构 `pq_fixture_member` Cookie 完成学位论文/期刊下载、撤销和恢复权限，最后清除虚构 Cookie。失败尝试不计为通过。全部业务及浏览器 JS 语法、Python fixture 语法和 `git diff --check` 通过。

可复跑脚本已入库；本地运行证据在忽略提交的 `output/playwright/feedback-*-results*`、`feedback-*-browser-run*`、`journal-feedback-browser-run.json`、`proquest-session-browser-run.json`、`settings-ui-results.json`、`feedback-final-node-tests.txt` 和 `feedback-files-verified.json`。这些脚本会清空测试清单，禁止在日常浏览器配置运行。

### 真实网站与未执行项目

本轮实际访问用户截图中的公开期刊 [ProQuest 文档 3268524212](https://www.proquest.com/docview/3268524212)，完成收藏、解析和真实 Chrome 下载。插件和 Chrome 均确认成功，磁盘文件核对为 **7,855,693 字节、15 页**；作者 6 人、刊名、卷期页及 DOI 解析正确。自动化等待曾超时，之后单独读回确认下载完成，不能把首次脚本等待写成直接通过。真实访问发生在启用本地映射之前，没有使用机构账号；本轮会话扩展后的公开期刊代码路径与这次真实下载一致。

没有执行真实知网/图书馆账号或真实 ProQuest 机构账号测试，也没有购买、订购操作。真实账号权限不能由 Cookie 样例推断为已验收。原生导出“另存为”对话框本轮未单独重跑，集成测试仍使用测试页自动保存并校验原请求；日常浏览器权限、下载设置及系统代理未修改。

本轮覆盖范围内未发现新增回归。发布前最少手工确认：重新加载扩展并刷新站点；在知网和实际代理各下载一篇；在 ProQuest 公开期刊及有权限的登录页面各下载一篇，确认预览跳过；展开指定文件夹，保存后下载一篇确认目录。真实账号未验收前保持 PR 草稿。

## v1.3.0 发布前两项补丁（2026-09-23，上一轮记录）

基线为 `codex/custom-proxy-domains` / `9ce2cb65f0b8ad275209e7172865cf3f973e659f`，开始时工作区干净。本次只修复 ProQuest 单篇失败重试和知网执行标签页选择，未提交、推送、合并、打 tag 或发布。

### 修改与失败复现

- `sidepanel/index.js`：单篇、批量失败重试及暂停后的继续下载进入同一带锁队列。已确认公开但缺链接的 ProQuest 文献可进入 `downloadProquestPaper()` 重新解析；文件下载仍取决于本次公开状态、有效新链接及 PDF 校验。保留普通队列的 `canDownloadPaper()` 筛选、指定 ID 范围和清空失效机制。知网缺链接的失败重试仍走原有解析。
- `getCnkiTab()` / `confirmCnkiTab()`：当前页优先，但所有候选必须通过内容脚本明确返回 `isCnki === true`。沿用已有权限尝试注入；每个候选最多探测 2 秒，关闭、失去权限、无响应和无效网址均不阻断后续候选。没有改主机权限、代理编码、端口或 iframe 下载地址。
- `content/main.js`：删除主机名包含 `cnki` 就返回真的捷径；沿用现有搜索结果、目录和详情页特征确认内容，避免 `cnki.school.edu.cn` 门户误报。

先扩展现有 `proquest.test.cjs`、`proxy-domains.test.cjs` 再修改实现。基线 56/56 通过；第一轮新增/调整用例后 70 项中 16 项失败，复现卡片重试不请求详情、普通高校页抢先等问题。实际内容脚本的域名误报另行先复现失败；补丁检查中补测并修复了暂停后继续重试。最终净新增 **16 项**，另将原先两条“内置域名直接返回”的断言改为必须验证 PING，保留当前有效页优先的断言。

新增覆盖：卡片真实点击绑定 → 队列 → 第二次解析 → 文件 API；preview/unknown 排除；连续点击互斥；清空时迟到结果；再次解析失败仍可重试；单篇 ID 隔离；批量重试及暂停恢复。标签页覆盖当前普通高校页、当前 ProQuest、有效知网页优先、仅普通高校页返回 null、严格 PING、动态加载、关闭/无权限/无响应、注入后再次验证。

### 本次实际结果

| 验证 | 命令 / 脚本 | 通过 / 失败 |
|---|---|---|
| Node 自动测试 | `node --test tests/*.test.cjs` | 72 / 0 |
| 补丁浏览器场景 | `playwright-cli -s=patch run-code --filename tests/browser-release-patch.js` | 9 / 0 |
| 原有集成场景 | `playwright-cli -s=patch run-code --filename tests/browser-integration.js` | 10 / 0 |
| ProQuest 浏览器场景 | `playwright-cli -s=patch run-code --filename tests/browser-proquest.js` | 7 / 0 |
| 三种来源混合队列 | `playwright-cli -s=patch run-code --filename tests/browser-mixed-download.js` | 1 / 0 |

浏览器命令通过 `/Users/zgm/.codex/skills/playwright/scripts/playwright_cli.sh` 执行，接入独立 Chrome for Testing 153.0.8010.53（CDP 19223）。本地服务新增公开但缺 PDF、未知公开状态和详情延迟样例。9 组新增场景实际点击按钮、检查第二次详情 HTTP 请求、Chrome 完成状态和清空后的存储；同开高校门户、ProQuest、代理与知网页验证选择，并由选中的代理页完成原有 iframe 下载。

原有场景覆盖知网直连、教育网代理、自定义域名输入和动态注册、各端口/路径、下载归属及目录、跨页收藏与选择、导出、DOI、预览/HTML 排除。域名授权拒绝、移除、撤销和旧格式文献兼容另由 Node 测试覆盖。实际读回本轮通过场景产生的 **16 份 PDF、1 份 CSV**：PDF 文件头、文件尾和 1 页结构有效，CSV 标题和作者正确。`node --check`（两处业务 JS、两个相关浏览器脚本）、Python fixture 语法解析与 `git diff --check` 通过。

ProQuest 浏览器脚本首次重跑在文件名断言失败：历史同名文件让 Chrome 添加 `(3)` 后缀，下载本身为 complete。仅调整测试以允许 Chrome 标准重名后缀，仍严格校验标题和子目录；随后 7 组全部重跑通过。未改下载文件名实现，也未清理历史文件。

当前结果在忽略提交的 `output/playwright/release-patch-*-results.json`、`release-patch-results.json`、`release-patch-node-tests.txt` 和 `release-patch-files-verified.json`；下方历史结果不计入本次。重跑方法沿用本文的独立配置说明，启用 ProQuest 本地映射后运行四个脚本；新脚本同样会清空测试清单，不能在日常浏览器使用。

### 未执行和最少手工验收

本轮没有执行真实网站测试：浏览器使用本地映射；没有真实知网/湖北图书馆账号，也未测试 ProQuest 订阅或购买流程。原生导出“另存为”对话框未重跑，沿用集成脚本在测试页将导出暂改自动保存并验证原始 `saveAs` 请求的方式。日常浏览器权限、下载设置和系统代理未改。

在上述范围未发现新增回归；真实账号及未知代理页面结构仍待确认。发布前重新加载扩展并刷新网页后，最少做两项：

1. 实际知网及自定义图书馆代理各下载一篇；同时打开普通高校页和 ProQuest，确认仍能通过有效知网页下载，目录正确。
2. 实际 ProQuest 公开全文跨页收藏后勾选下载；可用断网再恢复制造一次请求失败，分别点单篇和批量重试，确认完成且不重复。仅预览文献应跳过。

## ProQuest v1.3.0（2026-09-23，此前验收记录，待发布）

56 项 Node 自动测试通过；7 组 ProQuest 本地浏览器场景、原有 10 组集成场景，以及知网 / ProQuest / DOI 混合队列均通过。继续使用独立 Chrome for Testing 153.0.8010.53，没有修改日常浏览器配置。

### 真实无账号验证

- 在真实 ProQuest 页面识别了简化公开页和带阅读器工具栏的详情布局。
- 真实搜索页当前加载 20 条记录，识别 2 篇公开学位论文；重复收藏已存在的一篇后只新增另一篇，其余 18 条跳过。
- 真实预览文档 `2308608269` 被跳过，没有加入清单或下载预览 PDF。
- 公开文档 `3343567210` 从插件收藏、重新请求匿名详情、验证 PDF 到 Chrome 下载完成全链路通过。读回磁盘文件为 **4,489,091 字节、104 页**，文件头 `%PDF-1.6`、文件尾完整，保存到指定 `proquest-public/` 子目录。详情地址不含会话查询参数，清单不存媒体签名。
- 真实访问验证发生在本地测试域名映射启用之前；结果不依赖模拟 PDF。没有 ProQuest 机构账号，也未验证订阅或已购买全文。

### 本地浏览器回归

`browser-proquest.js` 验证两页来回翻页、重复添加去重、取消勾选跨页及重载保留、两种详情布局解析、仅下载已选记录、标题和目录、每次下载刷新签名、访问状态变为预览时跳过、拒绝 HTML，以及预览按钮与全文按钮使用同一 CSS 类的负面样例。

`browser-integration.js` 原有 10 组回归重跑通过，覆盖知网直连、教育网代理、自定义图书馆代理、DOI 下载、清单和错误处理。`browser-mixed-download.js` 验证三种来源在同一个队列中各完成一次真实 Chrome 文件下载并保留子目录，RIS 导出同时包含三类条目。

这些浏览器用例通过本地 `browser-fixture.py` 服务运行。沿用下方重跑方式，并在**专用测试浏览器进程**额外把 `www.proquest.com`、`proquest.com`、`media.proquest.com` 映射到 `127.0.0.1`；ProQuest 样例使用 HTTPS 18543 端口。不要在这个映射仍启用时测试真实 ProQuest。测试的隐藏复选框通过可见 label 点击，切换页面后保持目标标签页前台，避免后台页面计时器影响自动化。

结果保存在忽略提交的 `output/playwright/proquest-fixture-results.json`、`proquest-cnki-regression-results.json`、`proquest-mixed-results.json`；对应脚本可复跑。新增主机权限的 manifest 断言已更新为精确的三处 ProQuest 主机，原知网匹配和可选代理权限断言保留。

发布前仍需真实知网和图书馆账号验收。ProQuest 的自动全结果翻页、机构订阅及购买流程尚未实现；本版是用户翻页后累积收藏，再统一勾选下载。后续接入约定见 [ProQuest 计划](../plans/PROQUEST.md)。

## 前一轮 v1.2.3 记录

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
