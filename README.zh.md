# dsh-plugin-discover

[English](README.md) | 中文

用中文或英文口语找 DeepSeek Harness（DSH）插件。装好之后，直接对 AI 说"帮我找一个能……的插件"，它会返回排好序的候选和对应的安装目标。

- **本地运行**：索引是你机器上的文件——不连服务端、不上传、不采集任何数据。
- **查询不调模型**：排序由代码确定、可回归；AI 只负责解释结果。
- **插件不安装**：只给安装目标；装不装、何时装由你和当前LLM会话决定，走 DSH 自己的插件管理与审批通道。
- **向量模型不自动下载**：向量模型是独立可选包，只有你显式拉取才会安装。不使用向量增强时不需要下载向量模型。

## 安装

和装任何 DSH 插件一样：Web 端 **插件 → 添加插件**，或命令行

```bash
dsh plugin --profile web add dsh-plugin-discover
```

从本地目录安装（开发或试用未发布版本）：

```bash
dsh plugin --profile web add link:D:\dsh-plugin-discover
```

包里只有代码（约 72 kB）：不带索引数据、不带模型权重、不带原生二进制，安装是秒级的。

## 快速开始

**1. 建索引（一次性）**

安装阶段不下载任何东西，先建一次本地索引：

```bash
npx dsh-plugin-discover build
```

下载约 25 MB（dsh.so 插件目录），视网络通常一两分钟完成。也可以直接在会话里让 AI 建库——后台执行、立即返回，不阻塞对话。

索引按用户全局存放，所有 profile 共用，约占 20 MB 磁盘：

| 系统 | 目录 |
|---|---|
| Windows | `%LOCALAPPDATA%\dsh-plugin-discover\` |
| macOS | `~/Library/Caches/dsh-plugin-discover/` |
| Linux | `${XDG_CACHE_HOME:-~/.cache}/dsh-plugin-discover/` |

构建总是写入新目录、成功后才切换，失败不影响现有索引；同一时刻只会有一份构建（锁保护）。想彻底重置，删掉整个目录再建即可。

**2. 直接问**

> 帮我找一个任务完成时能发微信通知的插件

AI 会调用 `plugin_discover` 检索并解释结果，例如：

```
🔍 10 个候选 · 过滤 balanced（排除 1094 条）

① dsh-wecom-notify · 1★ · L5 已验证 · 低风险
   DSH 插件：任务完成 / 报错 / 需要用户选择时，自动通过企业微信群机器人 webhook 发送通知
   [装: github:ljnljn2005/dsh-wecom-notify]
② dsh-clawbot · 11★ · L5 已验证 · 低风险
   在 DSH 里接入微信官方 ilink 机器人网关：扫码绑定后，AI 能主动给自己发微信通知
   [装: github:cryjkd/dsh-clawbot#1.5.0]
③ @chenweigao/dsh-perch-notify · L5 已验证 · 低风险
   Webhook notifications for DSH sessions — POST on approval requests and turn ends
   [装: github:chenweigao/dsh-perch-notify]

数据截至 2026-10-25 · Powered by dsh.so
```

每条带星数、验证等级、安全风险、更新时间和安装目标；描述保持英文，由 AI 在回答里翻译。想装哪个，把安装目标交给 DSH 的插件管理即可——本工具自己永远不装。

**3.（可选）开启向量模式**：见[可选向量模式与模型包](#可选向量模式与模型包)。

## 它怎么工作

```
你的原话 + AI 给的最多 3 条改写
  → 本地 BM25 词面检索（4 路查询分别检索，RRF 融合，同仓库的多个包合并成一张卡）
  → 质量过滤（安全 / 验证等级 / 兼容性）
  → 筛去不相关的候选
  → 返回候选 + 安装目标
```

- **中文查询需要英文改写**：目录里的插件名、标签、描述都是英文，AI 会自动补英文/术语改写，你不用管。
- **不要求所有词都命中**：词面检索按 OR 组合，中文长句也能出结果；名称和标签的权重高于描述。
- **`noMatch` 是正确结果**：没有足够证据表明存在匹配插件时，工具返回空并建议换说法，而不是硬凑一个。宁可空，不误导。
- **本地索引数据会过期**：报告头部带"数据截至"；索引超过更新周期（默认一周）时，下次检索会先自动刷新、等待成功后再出结果；刷新失败才用旧索引兜底，并明确提示。

## 工具参数

`plugin_discover` 的参数由会话模型填写，你不需要手工构造；列出供集成与排查参考：

| 参数 | 类型 | 语义 |
|---|---|---|
| `query` | string | 用户原话，不转述。检索必填；`explain` / `refresh` 时传 `""`。 |
| `queryAlts` | string[] | 最多 3 条改写：英文/术语版（中文查询必需）、3–5 个能力词、一句使用场景。 |
| `limit` | number | 返回条数，1–20；省略时用配置值。 |
| `explain` | string | 传结果 id / 精确名称 / 安装目标，返回该条完整记录，不检索。 |
| `refresh` | boolean | 立即返回，后台建/更新索引。 |
| `filters` | object | 临时覆盖 `preset`（strict/balanced/loose/off）与 `minVerificationLevel`（0–5）。 |

## 配置

打开插件管理页里本插件的**详情页**，配置区直接显示在页面中。保存即生效——宿主只重载本插件，进程与会话不重启。

| 配置项 | 默认 | 说明 |
|---|---|---|
| 索引目录 | 系统默认路径 | 见上表。改后 CLI 需用 `--index-dir` 指向同一目录。 |
| 索引更新周期 | 周（7 天） | 天 / 周 / 月（30 天）/ 3 个月（90 天）。检索时发现超过周期，先刷新并等待成功再出结果。 |
| 过滤档位 | 均衡（balanced） | 严格 / 均衡 / 宽松 / 关闭，见下表。 |
| 最低验证等级（仅均衡档） | 4 | 0 = 不限；1–5 要求验证等级 ≥ N。验证等级未知的条目不因此被删。 |
| 结果返回数量（top N） | 10 | 范围 1–20。 |
| 无关结果筛选强度 | medium | none（关闭）/ low / medium / high。越高越不容易硬凑结果，也越可能对边缘需求返回空。 |
| 向量化检索增强 | off | off / balance（字段向量）/ high（README 向量），见[可选向量模式与模型包](#可选向量模式与模型包)。 |
| 向量化范围（top N） | 50 | 参与向量重排的候选数，范围 2–200；增强为 off 时不生效。 |
| 单请求超时（秒） | 30 | README 单请求超时，范围 5–300。 |
| README抓取总超时时长（分钟） | 5 | 范围 1–10；超时后剩余记录跳过 GitHub、走 npm CDN。 |
| GitHub 请求并发 | 4 | 范围 1–8；速率固定为每 worker 1 次/秒，不可配置。 |

过滤档位：

| 档位 | 安全 | 验证 | 兼容 |
|---|---|---|---|
| `strict` | audited + low | L5 | 必须通过 |
| `balanced`（默认） | 排除 audited high/critical；未审计放行并标注 | ≥ L4（可配）；缺失放行 | 通过或未知 |
| `loose` | 只排除 high/critical | 不限 | 只标注 |
| `off` | 只排除 critical | 不限 | 不判断 |

"未知"不等于"不达标"：字段缺失的条目降权并标注，不过滤。过滤后不足 3 条时自动放宽一档，报告中注明。

## CLI

```bash
dsh-plugin-discover build   [--index-dir <dir>] [--json] [--quiet]
dsh-plugin-discover status  [--index-dir <dir>] [--json]
dsh-plugin-discover search  <query> [--alt <text>]... [--limit <n>] \
                             [--preset strict|balanced|loose|off] \
                             [--min-verification <0-5>] [--explain <id>] [--json]
dsh-plugin-discover model status [--index-dir <dir>] [--profile <name>] [--json]
dsh-plugin-discover model pull   [--spec <spec>] [--profile <name>] \
                                  [--index-dir <dir>] [--dry-run] [--no-verify] [--json]
```

- `build` / `status`：建索引、看状态。
- `search`：不进会话直接试查询；`--alt` 可重复最多 3 次给改写。
- `model pull` / `model status`：可选模型包的显式拉取与状态，见下节。

DSH 插件不能向 `dsh` 命令注册子命令，所以 CLI 作为包自带的 bin 提供。链接安装（`link:`）时没有全局 bin，用 `node lib/cli.js build` 代替。

## 可选向量模式与模型包

词面检索（默认）已覆盖大多数需求。向量模式用本地嵌入模型对候选做语义重排，能改善"说法不同但意思相近"的匹配；实测中它对多数查询没有明显优势（部分场景略优、部分略劣），所以默认关闭，想试再开。

代价是一个独立模型包 `dsh-plugin-discover-model`（int8 量化的 [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small)，384 维）：下载约 80 MB，连同 ONNX 运行时装完约 420 MB；运行时内存约 400–500 MB。模型跑在子进程，空闲 5 分钟自动退出，不开向量时零开销；ONNX 默认 4 线程（可用环境变量 `DSH_MODEL_THREADS` 覆盖）。它不是主插件的依赖，只有 `model pull` 才装：

```bash
# 默认：从 npm 安装
dsh-plugin-discover model pull

# 备用：从 GitHub Release 资产安装
dsh-plugin-discover model pull --spec "https://github.com/apeiria-network/dsh-plugin-discover/releases/download/model-v0.1.0/dsh-plugin-discover-model-0.1.0.tgz"

# 开发：从本地目录或 tarball 安装
dsh-plugin-discover model pull --spec "link:D:\dsh-plugin-discover\models\multilingual-e5-small"
dsh-plugin-discover model pull --spec "file:D:\path\to\dsh-plugin-discover-model-0.1.0.tgz"

dsh-plugin-discover model status
```

`model pull` 把模型包装进当前 DSH profile，按 manifest 逐文件校验（默认 SHA-256），并在索引目录写 `model.json` 指针。安装时 pnpm 可能以 `ERR_PNPM_IGNORED_BUILDS` 警告 `onnxruntime-node` 的构建脚本被跳过——预编译 CPU 二进制仍然可用，这是警告不是失败；其他安装失败会返回非零退出码，并保留已安装的版本。

装好后，在插件详情页把「向量化检索增强」改为：

| 模式 | 行为 |
|---|---|
| `off`（默认） | 不加载模型、不算向量。 |
| `balance` | 字段向量重排：把候选的目录字段——名称、标题、标签（topics）、能力标签、描述——拼成文本算语义相似度，与词面名次加权融合。 |
| `high` | 字段 + README 向量重排：在字段向量之外，额外抓取候选的 README 做语义比对。 |

网络行为（仅 `high` 模式联网）：

- README 来源顺序：GitHub raw → npm CDN 精确版本 → 字段向量兜底；命中缓存不联网。
- 固定限速（全局 4 req/s）、单请求 30 秒保护、总预算默认 5 分钟；超时自动降级，不影响整次查询。
- 无法直连 GitHub 的网络环境下自动走 npm CDN，再不行回退字段向量。
- GitHub 连续返回 403/429 或连续超时会熔断 10 分钟；结果带 `readme.circuit` 提示，AI 会转告你。
- 向量缓存放本地（`<indexDir>/cache/`），随数据更新自动失效。
- 模型缺失或启动失败时自动降级为词面排序并附提示，不会静默出错，也不会自动下载。

## 数据与隐私

- 主源：[dsh.so 插件目录](https://www.dsh.so/plugins-index.json)，CC-BY-4.0。每份报告带 `Powered by dsh.so — DSH Developer Hub` 与源数据时间戳。
- 补充：[dsh-plugin-catalog](https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json)，CC0-1.0（兼容信息与仓库地址）。
- npm registry 只用于解析 README 的精确版本，不参与收录与排序。
- 只收录有安装目标的条目——每条结果都能回答"怎么装"。
- 索引只是本机缓存：不上传、不共享、不作为服务分发。

## 已知限制

- 中文查询依赖 AI 补英文改写；改写偏了会带进相邻插件或漏掉目标。判断门槛能压掉一部分，压不干净。
- 某些泛化场景（如"手机上用"类需求）召回可能偏弱。
- `updatedAt` 来自目录数据；不在目录里的条目不显示更新时间。
- 向量模式默认关闭；开启前需先显式拉取模型包。
- 目前仅在 Windows 上验证过；macOS / Linux 理论可用，未实测。

## 许可

代码 MIT。索引数据保留源许可与署名（dsh.so CC-BY-4.0，catalog CC0-1.0）。
