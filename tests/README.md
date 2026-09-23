# 回归验证

无需新增依赖：`node --test tests/*.test.cjs`。

2026-09-23：在独立用户目录的 Chrome for Testing 154 加载本地扩展验证域名功能。浏览器真实权限 API、内容脚本注入、收藏、链接解析与下载 API 均参与测试；知网页面和 PDF 为本地测试响应，不代表已经使用湖北省图书馆账号完成在线下载。

- 授权拒绝不保存；允许授权后注册动态脚本。
- `library.hb.cn`、`ycfw.library.hb.cn:8000`、`alias.library.hb.cn:18765` 的 HTTP/HTTPS 页面注入成功，普通图书馆公告页不误识别。
- 重启后域名和脚本保留；移除设置同时撤销权限和注册。
- 知网直连、教育网代理、图书馆代理的模拟文献可以收藏、解析，并经原有 MAIN world iframe 完成下载；原始代理路径和端口保持不变。
- DOI 直链经真实 Chrome downloads API 下载本地 PDF 成功。

仍需发布前用实际已登录的知网及代理账号验收。未猜测或改写 WebVPN 编码规则。
