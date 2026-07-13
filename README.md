# Cody

Cody 是一个从零实现的 Rust Coding Agent 核心框架。它把 Agent Loop、模型 Provider、工具执行、持久状态和客户端协议拆成独立边界，既可以嵌入 Rust 应用，也可以通过 JSON-RPC App Server 接入 CLI、桌面端、IDE 或 Web 客户端。

当前包含 Rust Agent Runtime、App Server，以及基于 Electron + React 的桌面客户端。实现对应这组数据模型：

- `Thread`：一条持久、线性的完整对话流。
- `Project`：用户导入或创建的代码资产，可以是普通目录或 Git 仓库。
- `Workspace`：与 Thread 一对一的运行目录，用于临时代码、日志和产物。
- `ThreadReference`：在消息中引用另一个 Thread 的摘要、完整记录、指定消息或产物。
- `ProjectReference`：在消息中为 Agent 暴露一个只读或可写 Project。
- `ManagedProcess`：由 Thread 拥有、可跨 Turn 存活的受监督后台命令及其有界持久输出。

## 已实现

- 多步 Agent Loop：模型输出、工具调用、结果回填、继续推理、完成/失败/取消。
- 对象安全的 `ModelProvider`，内置 Echo、测试用 Scripted，以及 OpenAI-compatible Chat Completions Provider。
- Provider Registry：同一进程可注册多个 Provider 实例，每次 Turn 独立选择 Provider 和模型。
- `read_file`、`write_file`、`list_directory`、`shell` 工具及路径越界、符号链接逃逸、只读 Project 检查。
- 命令执行显式审批：默认每一次 `shell` 或 `start_process` 调用都等待客户端批准；Renderer 重连可通过 Thread 快照恢复待审批项。
- Thread/Turn 原子状态迁移，阻止同一 Thread 并发 Turn 和 Turn 重复执行。
- Draft-first 创建：空白输入框不落库，首次发送通过幂等 RPC 一次创建 Thread/Workspace/可选 Project 与首个 Turn，失败自动回滚。
- 首轮完成后自动生成 Thread 标题；标题生成器可替换，失败时使用 Unicode 安全的本地摘要。
- 完整 Process Manager：`start/list/read-output/stop` 工具、独立进程组、`TERM → KILL`、stdout/stderr 持续 drain、byte cursor 有界持久日志、幂等 origin、配额、重启 Lost 恢复和服务退出清理。
- Thread 右上角上下文卡片：汇总有效 Thread/Project 引用和当前 Turn/工具/审批活动；托管后台进程单独计数，并可在 Inspector 查看输出或停止。
- 引用解析与上下文预算；被引用对话作为低优先级 JSON 参考数据注入，不复制进当前 Thread。
- 版本化 JSON 持久化，原子替换、启动校验及中断 Turn 恢复。
- JSON-RPC 2.0 over HTTP/WebSocket；WebSocket 推送 Turn 事件并按 Thread 订阅。
- 本地服务 Bearer Token、WebSocket Origin 检查和非 loopback 绑定保护。

## 结构

```text
crates/
├── cody-core/
│   ├── domain.rs       # Thread / Project / Workspace / Turn / Message
│   ├── runtime.rs      # Agent Loop、取消、审批、状态机
│   ├── context.rs      # 当前历史和跨 Thread/Project 引用解析
│   ├── provider/       # Provider 中立协议和适配器
│   ├── tools/          # 工具接口与内置工具
│   ├── process.rs      # 长生命周期进程监督、输出日志和独立事件流
│   ├── store.rs        # InMemoryStore / JsonFileStore
│   └── event.rs        # Turn/Process 独立事件与进程内广播
└── cody-app-server/
    ├── rpc.rs          # JSON-RPC 方法
    └── server.rs       # HTTP / WebSocket、鉴权、Turn 管理
apps/
└── desktop/
    ├── src/main/       # Electron 主进程与 App Server 生命周期
    ├── src/preload/    # 最小权限 IPC Bridge
    └── src/renderer/   # React 对话工作台
```

更完整的设计说明见 [docs/architecture.md](docs/architecture.md)，协议见 [docs/app-server-protocol.md](docs/app-server-protocol.md)，桌面交互约束见 [apps/desktop/UI_SPEC.md](apps/desktop/UI_SPEC.md)。

## 快速开始

需要 Rust 1.87 或更新版本：

```bash
cargo test --workspace
cargo run -p cody-app-server
```

桌面端开发：

```bash
npm install
npm run desktop:dev
```

Electron 主进程会在随机 loopback 端口启动并认证 Rust App Server，Token 只保留在主进程；Renderer 只能通过白名单 IPC 调用 JSON-RPC。执行 `npm run desktop:package` 会先构建 release 版 Rust Server，再生成桌面安装产物。

服务默认监听 `127.0.0.1:8765`。启动日志会输出本次服务的认证 Token；生产集成建议通过 `CODY_SERVER_TOKEN` 注入固定的高熵 Token。

```bash
export CODY_SERVER_TOKEN='replace-with-a-long-random-token'
export CODY_HOME="$PWD/.cody"
cargo run -p cody-app-server
```

HTTP JSON-RPC 示例：

```bash
curl http://127.0.0.1:8765/v1/rpc \
  -H "Authorization: Bearer $CODY_SERVER_TOKEN" \
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

## 配置 OpenAI-compatible Provider

内置适配器支持 OpenAI 及实现 `/chat/completions` 的兼容服务：

```bash
export CODY_OPENAI_PROVIDER_ID=openai
export CODY_OPENAI_BASE_URL=https://api.openai.com/v1
export CODY_OPENAI_API_KEY='...'
export CODY_OPENAI_MODEL='your-model-name'
cargo run -p cody-app-server
```

也支持对应的 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL` 环境变量。Turn 未显式传 `model` 时会使用 Provider 的默认模型。

自定义 Provider 只需实现一个对象安全的 async trait；可运行示例见 [custom_provider.rs](crates/cody-core/examples/custom_provider.rs)。

## 关键环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CODY_HOME` | 当前目录下 `.cody` | 状态文件和 Thread Workspace 根目录 |
| `CODY_BIND` | `127.0.0.1:8765` | App Server 监听地址 |
| `CODY_SERVER_TOKEN` | 每次启动随机生成 | HTTP/WS 认证 Token |
| `CODY_ALLOWED_ORIGINS` | 空 | 逗号分隔的允许 WebSocket Origin；原生无 Origin 客户端不受影响 |
| `CODY_ALLOW_REMOTE` | `0` | 设为 `1` 才允许二进制绑定非 loopback 地址 |
| `CODY_MAX_STEPS` | `24` | 单 Turn 最大模型循环次数 |
| `CODY_REQUIRE_COMMAND_APPROVAL` | `true` | 是否要求客户端批准模型发起的 `shell`/`start_process` 命令；兼容旧变量 `CODY_REQUIRE_SHELL_APPROVAL` |

## 安全边界

- 文件工具只能访问 Workspace 或当前 Thread 已引用的 Project，并拒绝绝对路径、`..` 和符号链接逃逸。
- Shell 和 Managed Process 使用同一份净化环境，不继承 Provider Key、Server Token 或用户 Cargo 凭据；但命令执行不是操作系统级文件沙箱。因此默认必须审批，部署方仍应在容器、Seatbelt、Landlock 等外部沙箱中运行服务。
- 前台 `shell` 在返回、取消或超时时清理整个临时进程组；长期命令必须使用 `start_process`，且不能自行 daemonize/脱离监督组。Managed Process 输出单独写入权限受限的有界日志，不进入 Turn 历史。
- App Server 默认只允许 loopback，所有 RPC/WS 操作都要求 Token；有 `Origin` 的 WebSocket 客户端还必须显式加入允许列表。
- `.cody/state.json` 包含对话内容，Unix 下以 `0600` 原子快照写入。备份和磁盘加密由部署方负责。

当前 JSON Store 面向单进程本地应用；事件广播也只在进程内保留，不提供历史事件重放。`StateStore` 和事件边界已独立，后续可替换为 SQLite/Postgres 和持久事件日志。
