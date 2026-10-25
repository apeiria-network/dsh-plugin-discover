# 更新日志

## 1.0.0 — 2026-10-25

首个发布版本。

**是什么**：DSH 本地插件检索器。用中文或英文口语找 DeepSeek Harness 插件：本地 BM25 词面检索加可选向量重排，返回排好序的候选和安装目标。不连服务端、查询不调模型、插件永不安装、模型不自动下载。

**安装**：

```bash
dsh plugin --profile web add dsh-plugin-discover
```

装完建一次索引（约 25 MB 下载）：`npx dsh-plugin-discover build`，或直接在会话里让 AI 建。详见 README。

**主要能力**：

- 中文口语查询，AI 自动补英文改写；4 路 BM25 检索、RRF 融合、同仓库合并
- 质量过滤四档（strict / balanced / loose / off）与无关结果筛选四档（none / low / medium / high）
- 可选向量模式（balance / high）：独立模型包显式拉取，默认关闭，不开零开销
- CLI：`build` / `status` / `search` / `model pull`
- 插件详情页配置表单，保存即热生效

**已知限制**：

- 仅在 Windows 上验证过；macOS / Linux 理论可用，未实测
- 向量模式需先显式拉取约 420 MB 模型包，不会自动下载
- 中文查询依赖 AI 补英文改写；改写漂移可能带进相邻插件

**数据**：索引来自 dsh.so（CC-BY-4.0）与 dsh-plugin-catalog（CC0-1.0），仅本地缓存，按更新周期自动刷新。
