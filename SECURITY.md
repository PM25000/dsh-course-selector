# Security

## 报告漏洞

请勿在公开 Issue 提交安全漏洞。通过仓库的 GitHub Security Advisory 或维护者私有渠道报告，
说明：复现步骤、影响范围、受影响版本。

## 安全设计

- **URL 门控**（`src/node/url-policy.ts`）：scheme 黑名单、host:port 白名单、强制 loopback；
  嵌入性探测（XFO/CSP）阻止不可信站点被镜像。
- **权限门**（`src/node/permission.ts`）：`tools/pre-execute` 拦截——SSRF 防护、首次访问 ask、
  高危工具审批；允许名单 `allow-hosts.json` 写入需用户显式同意。
- **凭据**：浏览器登录态仅存于用户本机 `$DSH_HOME/data/course-selector/profile`（持久上下文），
  插件不收集、不上传。
- **合规**：只支持正常浏览选课（志愿制随机筛选），不包含抢课/高并发机制。