# Kody

[English](README.md) | 简体中文

Kody 是一个从零实现的 Rust Coding Agent 核心框架。它把 Agent Loop、模型 Provider、工具执行、持久状态和客户端协议拆成独立边界，既可以嵌入 Rust 应用，也可以通过 JSON-RPC App Server 接入 CLI、桌面端、IDE 或 Web 客户端。

当前包含 Rust Agent Runtime、App Server，以及基于 Electron + React 的桌面客户端。实现对应这组数据模型：

- `Thread`：一条持久、线性的完整对话流。
- `Project`：用户导入或创建的代码资产，可以是普通目录或 Git 仓库。
- `Workspace`：与 Thread 一对一的运行目录，用于临时代码、日志和产物。
- `ThreadReference`：在消息中引用另一个 Thread 的摘要、完整记录、指定消息或产物。
- `ProjectReference`：在消息中为 Agent 暴露一个只读或可写 Project。
- `ManagedProcess`：由 Thread 拥有、可跨 Turn 存活的受监督后台命令及其有界持久输出。

## 已实现

- 多步 Agent Loop：模型输出、工具调用、结果回填、继续推理、完成/失败/取消。
- 对象安全的 `ModelProvider` 与结构化模型目录；内置 Echo、测试用 Scripted、支持流式工具调用的 OpenAI Responses，以及 OpenAI-compatible Chat Completions 适配器。
- Provider Registry：同一进程可注册多个 Provider 实例，`provider/list` 返回无凭据的能力描述，`provider/models` 返回模型、默认项和可用推理强度；每次 Turn 独立选择 Provider 和模型。
- Provider 可在运行时配置、替换、健康检查和移除；已排队 Turn 持有自己的 Provider 租约，因此配置更新只影响后续 Turn。
- 独立的 Codex 外部 Turn 后端：通过官方 `codex app-server` JSONL stdio 协议使用 ChatGPT 登录和套餐额度，并把流式消息、推理、工具、文件变更、审批及结构化提问映射回 Kody 事件。
- `read_file`、`write_file`、`list_directory`、`shell` 工具及路径越界、符号链接逃逸、只读 Project 检查。
- 命令执行显式审批：默认每一次 `shell` 或 `start_process` 调用都等待客户端批准；Renderer 重连可通过 Thread 快照恢复待审批项。Codex 后端的命令和文件变更审批也复用同一 Broker。
- 结构化 User Input：后端可以暂停 Turn 并请求单选、自由输入或敏感输入；待处理问题可在 Thread 快照中恢复，答案只交给正在等待的后端，不进入事件或持久对话。
- Thread/Turn 原子状态迁移，阻止同一 Thread 并发 Turn 和 Turn 重复执行。
- Draft-first 创建：空白输入框不落库，首次发送通过幂等 RPC 一次创建 Thread/Workspace/可选 Project 与首个 Turn，失败自动回滚。
- 输入框可为每个 Turn 选择 `Read only`、`Ask for commands` 或 `Full access`，并由原生 agent loop 与 Codex backend 共同执行同一权限语义。
- 首轮完成后自动生成 Thread 标题；标题生成器可替换，失败时使用 Unicode 安全的本地摘要。
- 完整 Process Manager：`start/list/read-output/stop` 工具、独立进程组、`TERM → KILL`、stdout/stderr 持续 drain、byte cursor 有界持久日志、幂等 origin、配额、重启 Lost 恢复和服务退出清理。
- Thread 右上角上下文卡片：汇总有效 Thread/Project 引用和当前 Turn/工具/审批活动；托管后台进程单独计数，并可在 Inspector 查看输出或停止。
- 引用解析与上下文预算；被引用对话作为低优先级 JSON 参考数据注入，不复制进当前 Thread。
- 版本化 JSON 持久化，原子替换、启动校验及中断 Turn 恢复。
- JSON-RPC 2.0 over HTTP/WebSocket；WebSocket 推送 Turn 事件并按 Thread 订阅。
- Electron Settings 中的 Provider 配置、模型目录与逐 Turn 模型选择；API Key 由主进程使用系统安全存储加密，Renderer 只能看到脱敏后的 Profile。
- macOS 应用内自动更新：后台静默检查公开的 GitHub Release，按 CPU 架构下载签名、公证后的 ZIP，显示进度，并在重启前干净关闭 Rust App Server；源码仓库和发布凭据不会暴露给 Renderer。
- 本地服务 Bearer Token、WebSocket Origin 检查、Renderer RPC 白名单和非 loopback 绑定保护。

## 结构

```text
crates/
├── kody-core/
│   ├── domain.rs       # Thread / Project / Workspace / Turn / Message
│   ├── runtime.rs      # Agent Loop、取消、审批、状态机
│   ├── context.rs      # 当前历史和跨 Thread/Project 引用解析
│   ├── provider/       # Provider 中立协议和适配器
│   ├── tools/          # 工具接口与内置工具
│   ├── process.rs      # 长生命周期进程监督、输出日志和独立事件流
│   ├── store.rs        # InMemoryStore / JsonFileStore
│   └── event.rs        # Turn/Process 独立事件与进程内广播
└── kody-app-server/
    ├── rpc.rs          # JSON-RPC 方法
    ├── server.rs       # HTTP / WebSocket、鉴权、Turn 管理
    ├── codex_backend.rs # Codex ExternalTurnBackend 与事件桥接
    └── codex/           # 官方 codex app-server 安全 stdio 客户端
apps/
└── desktop/
    ├── src/main/       # Electron 主进程与 App Server 生命周期
    ├── src/preload/    # 最小权限 IPC Bridge
    └── src/renderer/   # React 对话工作台
```

更完整的设计说明见 [docs/architecture.md](docs/architecture.md)，协议见 [docs/app-server-protocol.md](docs/app-server-protocol.md)，桌面交互约束见 [apps/desktop/UI_SPEC.md](apps/desktop/UI_SPEC.md)。

持续集成会检查 Rust 格式、Clippy、完整测试以及桌面端类型和构建。macOS 发布流程会在 Apple Silicon 与 Intel Runner 上分别完成 Developer ID 签名、Apple 公证、stapling 和 Gatekeeper 校验；本地与 GitHub Actions 配置见 [docs/releasing.md](docs/releasing.md)。

## 快速开始

需要 Rust 1.87 或更新版本：

```bash
cargo test --workspace
cargo run -p kody-app-server
```

桌面端开发：

```bash
npm install
npm run desktop:dev
```

Electron 主进程会在随机 loopback 端口启动并认证 Rust App Server，Token 只保留在主进程；Renderer 只能通过白名单 IPC 调用 JSON-RPC。Provider Profile 在 Settings 中管理，对话输入框可为新的或已有的 Thread 选择 Provider 和模型。执行 `npm run desktop:package` 会先构建 release 版 Rust Server，再生成桌面安装产物。

服务默认监听 `127.0.0.1:8765`。未配置时会在进程内生成随机认证 Token，不会把它写入日志；独立客户端集成应通过 `KODY_SERVER_TOKEN` 注入固定的高熵 Token。Electron 桌面端会为每次子进程启动自动生成并私有持有 Token。

```bash
export KODY_SERVER_TOKEN='replace-with-a-long-random-token'
export KODY_HOME="$PWD/.kody"
cargo run -p kody-app-server
```

HTTP JSON-RPC 示例：

```bash
curl http://127.0.0.1:8765/v1/rpc \
  -H "Authorization: Bearer $KODY_SERVER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

桌面端使用首次消息创建 Thread；指定工作目录时，该目录会被自动导入为 Project，并成为默认可写引用：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "thread/create-and-start",
  "params": {
    "client_request_id": "LOCAL_DRAFT_UUID",
    "message": "Implement OAuth",
    "provider": "openai",
    "model": "gpt-example",
    "permission_mode": "ask",
    "references": [],
    "working_directory": "/absolute/path/to/repo"
  }
}
```

启动 Turn，并临时引用其他 Thread/Project：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "turn/start",
  "params": {
    "thread_id": "THREAD_UUID",
    "message": "根据设计实现登录，并修改 frontend",
    "provider": "openai",
    "model": "gpt-example",
    "permission_mode": "ask",
    "references": [
      {
        "kind": "thread",
        "thread_id": "DESIGN_THREAD_UUID",
        "mode": "summary"
      },
      {
        "kind": "project",
        "project_id": "FRONTEND_PROJECT_UUID",
        "access": "read_write"
      }
    ]
  }
}
```

## 配置 Provider 与模型

桌面端 Settings 支持多个命名 Profile：

- `OpenAI`：使用流式 [Responses API](https://platform.openai.com/docs/api-reference/responses)，支持模型输出、推理增量和多工具调用。
- `OpenAI-compatible`：使用非流式 `/chat/completions`，用于兼容服务和本地模型网关。

Profile 保存后，主进程会通过私有的已认证控制通道调用 `provider/configure`，并在 App Server 重连时严格对齐 Provider Registry。`provider/list`、`provider/models` 和 `provider/health` 只返回无凭据的元数据。默认模型可在 Profile 中设定，每次 Turn 也可显式指定 `model`。

独立 App Server 仍可以通过环境变量启动一个 OpenAI-compatible `/chat/completions` Provider：

```bash
export KODY_OPENAI_PROVIDER_ID=openai
export KODY_OPENAI_BASE_URL=https://api.openai.com/v1
export KODY_OPENAI_API_KEY='...'
export KODY_OPENAI_MODEL='your-model-name'
cargo run -p kody-app-server
```

也支持对应的 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL` 环境变量。Provider 构建完成后，API Key 会从进程环境移除，避免被工具、托管进程或 Codex 侧车继承。Turn 未显式传 `model` 时会使用 Provider 的默认模型。

自定义 Provider 只需实现一个对象安全的 async trait；可运行示例见 [custom_provider.rs](crates/kody-core/examples/custom_provider.rs)。

## 使用 Codex 套餐额度

`codex` 是一个独立的外部 Turn 执行后端，不是把 Codex OAuth Token 塞进通用模型请求的 Provider 适配器。Kody 启动官方 `codex app-server` 侧车，通过 JSONL stdio 调用它的 Account、Model、Thread 和 Turn API。用户可在桌面端 Settings 中选择 **Connect ChatGPT**，登录后的 Codex Turn 使用该 ChatGPT 账号可用的 Codex 套餐额度；独立 API Key Profile 则仍按 API 用量计费。具体账号行为见 [Codex Authentication](https://developers.openai.com/codex/auth)。

Kody 不读取 `~/.codex/auth.json`，不接收 Codex OAuth/Refresh Token，也不会把它们当作 API Key。登录、登出、刷新和凭据保存都属于官方侧车。Kody 只保存 Thread 到外部 Codex Thread ID 的不透明绑定，并接收经过有界化和脱敏的事件。协议形式见 [Codex app-server](https://developers.openai.com/codex/app-server)。

## 关键环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `KODY_HOME` | 当前目录下 `.kody` | 状态文件和 Thread Workspace 根目录 |
| `KODY_BIND` | `127.0.0.1:8765` | App Server 监听地址 |
| `KODY_SERVER_TOKEN` | 每次启动随机生成 | HTTP/WS 认证 Token |
| `KODY_ALLOWED_ORIGINS` | 空 | 逗号分隔的允许 WebSocket Origin；原生无 Origin 客户端不受影响 |
| `KODY_ALLOW_REMOTE` | `0` | 设为 `1` 才允许二进制绑定非 loopback 地址 |
| `KODY_MAX_STEPS` | `24` | 单 Turn 最大模型循环次数 |
| `KODY_REQUIRE_COMMAND_APPROVAL` | `true` | 是否要求客户端批准模型发起的 `shell`/`start_process` 命令 |
| `KODY_CODEX_PATH` | 自动发现 | 可信宿主显式指定 `codex` 可执行文件；设置后不回退到 `PATH` 或 ChatGPT 应用内置版本 |
| `KODY_CODEX_SERVICE_TIER` | `fast` | Codex 侧车的可信宿主配置；可选 `fast` 或 `flex`，其他值按 `fast` 处理，不向 Renderer 暴露 |

## 安全边界

- 文件工具只能访问 Workspace 或当前 Thread 已引用的 Project，并拒绝绝对路径、`..` 和符号链接逃逸。
- Shell 和 Managed Process 使用同一份净化环境，不继承 Provider Key、Server Token 或用户 Cargo 凭据；但命令执行不是操作系统级文件沙箱。因此默认 `Ask for commands`，而 `Full access` 会明确跳过交互审批。部署方仍应在容器、Seatbelt、Landlock 等外部沙箱中运行服务。
- 前台 `shell` 在返回、取消或超时时清理整个临时进程组；长期命令必须使用 `start_process`，且不能自行 daemonize/脱离监督组。Managed Process 输出单独写入权限受限的有界日志，不进入 Turn 历史。
- App Server 默认只允许 loopback，所有 RPC/WS 操作都要求 Token；有 `Origin` 的 WebSocket 客户端还必须显式加入允许列表。
- `provider/configure`、`provider/remove` 和 Codex Account RPC 只供已认证的可信控制端使用；Electron Renderer 的 RPC 白名单故意排除它们。Renderer 只能把用户当次输入的 API Key 作为写入请求交给主进程，不能从存储或服务读回已保存的 API Key、App Server Token 或 Codex 凭据。
- Electron 使用 `safeStorage` 加密 API Key，Profile 文件通过同目录原子替换写入，Unix 目录/文件权限收紧为 `0700`/`0600`。Linux 上无法确认 Secret Store 或仅有不安全的 `basic_text` 后端时会拒绝保存凭据。
- Provider 错误、Codex stderr/协议错误和公共工具元数据在进入 RPC、日志或事件前会脱敏并限长。结构化 User Input 的答案，尤其是敏感答案，不写入公开事件和 Thread 快照。
- `.kody/state.json` 包含对话内容，Unix 下以 `0600` 原子快照写入。备份和磁盘加密由部署方负责。

当前 JSON Store 面向单进程本地应用；事件广播也只在进程内保留，不提供历史事件重放。`StateStore` 和事件边界已独立，后续可替换为 SQLite/Postgres 和持久事件日志。

## 文档与参与贡献

- [文档索引](docs/README.md)
- [架构设计](docs/architecture.md)
- [App Server 协议](docs/app-server-protocol.md)
- [开发指南](docs/development.md)
- [macOS 发布流程](docs/releasing.md)
- [更新记录](CHANGELOG.md)

欢迎提交 Issue 和 Pull Request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)；安全漏洞请按照 [SECURITY.md](SECURITY.md) 私下报告，不要创建公开 Issue。

## 开源许可证

Kody 允许用户任选 [Apache License 2.0](LICENSE-APACHE) 或 [MIT License](LICENSE-MIT) 使用。除非贡献者明确另行声明，提交给 Kody 的贡献也按相同的双许可证条款授权。
