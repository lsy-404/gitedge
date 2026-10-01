# GitEdge

GitEdge 是在 Cloudflare 边缘运行的轻量 Git Forge。产品包含 Vue 3 中英双语前端、独立授权门户、个人与组织命名空间，以及仓库、Issue、Pull Request、Wiki 和 Git Smart HTTP v2 路径。

## 当前能力

- Vue 3 + TypeScript + Vite，使用 Vue I18n 提供简体中文和英文界面。
- Gateway 是唯一公开入口，Auth、Forge、Git 通过 Service Bindings 内部调用。
- Auth 使用 D1、PBKDF2-HMAC-SHA256 和 HttpOnly/Secure/SameSite=Lax 会话 Cookie，并支持 GitHub OAuth 外部登录。
- GitHub 登录提供“仅身份识别”和“读取账户资料”两档；读取档只请求 `read:user user:email read:org`，不请求仓库权限，OAuth token 不落盘。
- Forge 提供个人/组织命名空间、组织成员、仓库、Issue、Pull Request 元数据和 Wiki 页面 API。
- Git Worker 复用 `git-on-cloudflare` 的 Smart HTTP v2、Durable Objects、R2、KV 与 Queue 核心。
- 公开仓库创建时同步 Git 路由缓存，可以通过标准 Git 客户端发现和拉取。

首批 Pull Request 是协作元数据，不包含 diff、ref 校验或 merge；Git push 所需的 PAT 数据模型与协议鉴权核心已保留，但 PAT 签发界面尚未接入。因此当前版本是可运行的项目框架，不应当作完整 GitHub/GitLab 替代品。

## 架构

| 服务    | 公网入口 | 主要职责                                     | 资源                            |
| ------- | -------- | -------------------------------------------- | ------------------------------- |
| Gateway | 是       | SPA、路由、会话校验、可信身份注入            | Static Assets、Service Bindings |
| Auth    | 否       | 注册、密码/GitHub 登录、外部身份、会话验证   | D1                              |
| Forge   | 否       | 组织、仓库与 Issue/PR/Wiki API、Git 路由同步 | D1、KV                          |
| Git     | 否       | Smart HTTP、refs、pack、对象存储与维护任务   | DO、R2、D1、KV、Queue           |

浏览器请求经 Gateway 转发；客户端提供的 `X-GitEdge-*` 身份头会被删除，Forge 只接收 Gateway 从 Auth 会话中生成的可信身份。Git pack body 由 Gateway 流式转发给 Git Worker。

## 本地开发

需要 Node.js、npm 和已登录或可本地运行的 Wrangler。

```bash
npm ci
npm --prefix apps/web ci
npm run db:migrate:local
npm run build:web
npm run dev
```

Gateway 默认监听 `http://localhost:8877`。四个本地 Worker 共用 `.wrangler/state`，因此 Auth、Forge 与 Git 看到同一个 D1 和 KV 状态。

常用验证命令：

```bash
npm run typecheck
npm test
npm run test:web
npm run deploy:dry-run
npm run test:workers
```

## Cloudflare 部署

1. 在同一个 Cloudflare 账户创建 D1 数据库 `gitedge`、KV namespace、R2 bucket `gitedge-git-repos` 和 Queue `gitedge-git-repo-maint`。
2. 将 `workers/auth`、`workers/forge`、`workers/git` 配置中的资源占位符替换为实际 ID。
3. 将 Gateway 的示例自定义域名替换为实际域名；若仅使用 `workers.dev`，移除示例 route 并启用 `workers_dev`。
4. 如需 GitHub 登录，在 GitHub 创建 OAuth App，将 callback URL 设置为 `https://<你的域名>/api/auth/github/callback`，然后为 Auth Worker 配置 `GITHUB_CLIENT_ID` 与 `GITHUB_CLIENT_SECRET` secret。不要把凭据写入 JSONC 或提交到 Git。
5. 先执行 `npm run deploy:dry-run`，再执行 `npm run deploy`。脚本会构建前端、应用 D1 migration，并按 Auth → Forge → Git → Gateway 顺序部署。

```bash
npx wrangler secret put GITHUB_CLIENT_ID --config workers/auth/wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config workers/auth/wrangler.jsonc
```

详细边界见 `docs/gateway-topology.md`。

## 来源与许可证

Git 协议和存储核心基于 `zllovesuki/git-on-cloudflare` 的固定基线。上游 MIT 声明保存在 `LICENSES/MIT-git-on-cloudflare.txt`；本仓库的发行条款见根目录 `LICENSE`。
