# Contributing

感谢你愿意为 dsh-course-selector 贡献。

## 开发流程

1. Fork 并 clone 本仓库。
2. `npm install --legacy-peer-deps`。
3. 改动后保证检查通过：
   ```sh
   npm run typecheck          # tsc --noEmit 严格类型
   npm run build              # tsdown 产出 lib/
   ```
4. 宿主（node）改动需重启 dsh 生效；客户端（src/client）改动刷新页面即可。
5. 涉及新工具/权限门/URL 策略的改动，说明安全影响（SSRF/审批）与隐私承诺。
6. 提交 PR 并附验证方式。

## 约定

- 只操作用户自己账号、正常频率浏览；**不实现也不宣传抢课/刷课**（浙大志愿制随机筛选）。
- 新 URL/域默认拒绝，必要入口走 `url-policy.ts` 白名单 + `permission.ts` 权限门。
- 风险行为（打开浏览器、执行动作、写评分站）需 ask/审批，`allow-hosts.json` 持久化需用户显式同意。
- 注释用英文，面向用户的文案保持中文。
- 不要提交 `lib/`、`node_modules/`、`scratch/`（已 gitignore）。

## 提交信息

简要、动词开头，如 `feat: add mac browser channel detection` / `fix: crawl grid row parsing`。