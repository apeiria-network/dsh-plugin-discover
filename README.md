# dsh-plugin-discover

English | [中文](README.zh.md)

Find DeepSeek Harness (DSH) plugins by asking the AI in plain Chinese or English. Once installed, just say "find me a plugin that …" and you get ranked candidates with their install targets.

- **Local**: the index is a file on your machine — no server, no upload, no telemetry.
- **No model calls at query time**: ranking is deterministic and regression-testable; the AI only explains the results.
- **The plugin never installs**: it returns install targets only; whether and when to install is decided by you and the current LLM session, through DSH's own plugin manager and approval channel.
- **No automatic model download**: the embedding model is a separate optional package, installed only when you explicitly pull it. You don't need it unless you enable vector enhancement.

## Install

Like any DSH plugin: **Plugins → Add plugin** in the Web UI, or

```bash
dsh plugin --profile web add dsh-plugin-discover
```

From a local directory (development or an unpublished version):

```bash
dsh plugin --profile web add link:D:\dsh-plugin-discover
```

The package contains code only (about 72 kB): no index data, no model weights, no native binaries — installation takes seconds.

## Quick start

**1. Build the index (once)**

Nothing is downloaded during installation. Build the local index once:

```bash
npx dsh-plugin-discover build
```

About 25 MB to download (the dsh.so plugin directory), typically a minute or two depending on the network. You can also just ask the AI in a session to build it — it runs in the background and returns immediately, without blocking the conversation.

The index is stored per user and shared by all profiles, about 20 MB on disk:

| OS | Directory |
|---|---|
| Windows | `%LOCALAPPDATA%\dsh-plugin-discover\` |
| macOS | `~/Library/Caches/dsh-plugin-discover/` |
| Linux | `${XDG_CACHE_HOME:-~/.cache}/dsh-plugin-discover/` |

Builds always write a new directory and switch only on success; a failed build never touches the existing index, and a lock guarantees one build at a time. To reset completely, delete the directory and build again.

**2. Just ask**

> 帮我找一个任务完成时能发微信通知的插件

The AI calls `plugin_discover` and explains the results, for example:

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

Each result carries stars, verification level, security risk, update date, and an install target; the AI explains the descriptions in its answer. To install one, hand the install target to DSH's plugin manager — this tool never installs anything itself.

**3. (Optional) enable vector mode**: see [Optional vector mode and model package](#optional-vector-mode-and-model-package).

## How it works

```
your original words + up to 3 AI rewrites
  → local BM25 lexical search (four query routes, RRF fusion,
    packages from one repository merged into one card)
  → quality filters (security / verification / compatibility)
  → irrelevant candidates screened out
  → candidates + install targets
```

- **Chinese queries need an English rewrite**: plugin names, topics, and descriptions in the catalog are English; the AI adds the rewrite automatically — you don't need to do anything.
- **Not every term must match**: lexical search combines terms with OR, so long Chinese sentences still return results; names and topics weigh more than descriptions.
- **`noMatch` is a correct result**: when there is not enough evidence that a matching plugin exists, the tool returns empty and suggests rephrasing instead of forcing a candidate. Better empty than misleading.
- **Duplicate entries are merged**: one card per install target and upstream repository; forks and re-uploaded copies fold into the upstream and no longer appear separately. Same-named but distinct projects are never force-merged.
- **Uninstallable entries are not returned**: plugins whose upstream repository is gone and that can only be installed from GitHub do not appear in results.
- **The local index goes stale**: the report header carries a "data as of" date; when the index exceeds the update cycle (one week by default), the next search refreshes it first and waits for success; only a failed refresh falls back to the old index, with a clear notice.

## Tool parameters

The parameters of `plugin_discover` are filled in by the session model; you never construct them by hand. They are listed for integration and troubleshooting:

| Parameter | Type | Meaning |
|---|---|---|
| `query` | string | The user's original words, not paraphrased. Required for a search; pass `""` for `explain` / `refresh`. |
| `queryAlts` | string[] | Up to 3 rewrites: an English/term version (required for Chinese), 3–5 capability keywords, one usage-scenario sentence. |
| `limit` | number | Result count, 1–20; defaults to the configured value when omitted. |
| `explain` | string | A result id / exact name / install target; returns that record without searching. |
| `readme` | boolean | With `explain`: also returns the plugin's README. |
| `readmeMaxChars` | integer | README character cap, default 200000. |
| `refresh` | boolean | Returns immediately; builds/updates the index in the background. |
| `filters` | object | Temporary override of `preset` (strict/balanced/loose/off) and `minVerificationLevel` (0–5). |

## Configuration

Open this plugin's **detail page** in the plugin manager; the configuration section is rendered right on that page. Saving takes effect immediately — the host reloads only this plugin; the process and sessions do not restart.

| Setting | Default | Notes |
|---|---|---|
| Index directory | OS default | See the table above. After changing it, point the CLI at the same directory with `--index-dir`. |
| Index update cycle | Week (7 days) | Day / week / month (30 days) / 3 months (90 days). A search that finds the index older than the cycle refreshes it first and waits for success. |
| Filter preset | Balanced | Strict / balanced / loose / off — see the table below. |
| Minimum verification level (balanced only) | 4 | 0 = no floor; 1–5 require level ≥ N. Entries with unknown verification are not removed. |
| Result count (top N) | 10 | Range 1–20. |
| Irrelevant-result filter strength | medium | none (off) / low / medium / high. Higher levels are less likely to force results and more likely to return empty for edge needs. |
| Vector search enhancement | off | off / balance (field vectors) / high (README vectors) — see [Optional vector mode and model package](#optional-vector-mode-and-model-package). |
| Vectorization range (top N) | 50 | Number of candidates entering vector rerank, range 2–200; ignored when enhancement is off. |
| Single-request timeout (seconds) | 30 | README single-request timeout, range 5–300. |
| Total README fetch timeout (minutes) | 5 | Range 1–10; after it, remaining records skip GitHub and go to the npm CDN. |
| GitHub request concurrency | 4 | Range 1–8; the rate is fixed at 1 request/second per worker and is not configurable. |

Filter presets:

| Preset | Security | Verification | Compatibility |
|---|---|---|---|
| `strict` | audited + low | L5 | must pass |
| `balanced` (default) | excludes audited high/critical; unaudited pass with a badge | ≥ L4 (configurable); missing passes | pass or unknown |
| `loose` | only excludes high/critical | no floor | annotated only |
| `off` | only excludes critical | no floor | not checked |

"Unknown" is not "failing": entries with missing fields are down-weighted and annotated, not filtered. Fewer than three surviving candidates relaxes the preset one step, noted in the report.

## CLI

```bash
dsh-plugin-discover build   [--index-dir <dir>] [--json] [--quiet]
dsh-plugin-discover status  [--index-dir <dir>] [--json]
dsh-plugin-discover search  <query> [--alt <text>]... [--limit <n>] \
                             [--preset strict|balanced|loose|off] \
                             [--min-verification <0-5>] [--explain <id>] \
                             [--readme] [--readme-max-chars <n>] [--json]
dsh-plugin-discover model status [--index-dir <dir>] [--profile <name>] [--json]
dsh-plugin-discover model pull   [--spec <spec>] [--profile <name>] \
                                  [--index-dir <dir>] [--dry-run] [--no-verify] [--json]
```

- `build` / `status`: build the index, check its status.
- `search`: try a query without a session; `--alt` repeats up to three times for rewrites.
- `model pull` / `model status`: explicit pull and status for the optional model package, see below.

DSH plugins cannot register `dsh` subcommands, so the CLI ships as the package's own bin. With a linked install (`link:`) there is no global bin; use `node lib/cli.js build` instead.

## Optional vector mode and model package

Lexical search (the default) covers most needs. Vector mode reranks candidates with a local embedding model, improving matches where the wording differs but the meaning is close; in measured comparisons it showed no clear advantage for most queries (better in some, worse in others), so it is off by default — enable it if you want to experiment.

The cost is a separate model package `dsh-plugin-discover-model` (int8-quantized [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small), 384 dimensions): about 80 MB to download, roughly 420 MB installed with the ONNX runtime; runtime memory about 400–500 MB. The model runs in a child process, exits after 5 minutes idle, and costs nothing while vector mode is off; ONNX defaults to 4 threads (override with the `DSH_MODEL_THREADS` environment variable). It is not a dependency of the plugin; only `model pull` installs it:

```bash
# default: install from npm
dsh-plugin-discover model pull

# fallback: install from the GitHub Release asset
dsh-plugin-discover model pull --spec "https://github.com/apeiria-network/dsh-plugin-discover/releases/download/model-v0.1.0/dsh-plugin-discover-model-0.1.0.tgz"

# development: install from a local directory or packed tarball
dsh-plugin-discover model pull --spec "link:D:\dsh-plugin-discover\models\multilingual-e5-small"
dsh-plugin-discover model pull --spec "file:D:\path\to\dsh-plugin-discover-model-0.1.0.tgz"

dsh-plugin-discover model status
```

`model pull` installs the package into the current DSH profile, verifies every file against the manifest (SHA-256 by default), and writes a `model.json` pointer into the index directory. pnpm may exit with an `ERR_PNPM_IGNORED_BUILDS` warning because `onnxruntime-node`'s build script is skipped — the prebuilt CPU binary still works; it is a warning, not a failure. Other install failures return a non-zero exit code and keep the installed version in place.

Once installed, set **Vector search enhancement** on the plugin detail page to:

| Mode | Behavior |
|---|---|
| `off` (default) | No model, no vectors. |
| `balance` | Field-vector rerank: concatenates the candidate's catalog fields — name, title, topics, capability tags, description — into one text, computes semantic similarity, and fuses it with the lexical ranking. |
| `high` | Field + README vectors: besides the field vectors, fetches each candidate's README for semantic comparison. |

Network behavior (only `high` goes online):

- README source order: GitHub raw → exact-version npm CDN → field-vector fallback; cache hits stay offline.
- Fixed rate limit (4 req/s globally), a 30-second per-request guard, and a total budget of 5 minutes by default; timeouts degrade gracefully and never fail the whole query.
- Networks that cannot reach GitHub directly fall back to the npm CDN, then to field vectors.
- Three consecutive GitHub 403/429 responses or timeouts open a 10-minute circuit; the result carries a `readme.circuit` notice the AI relays to you.
- Vector caches stay local (`<indexDir>/cache/`) and invalidate automatically when the data changes.
- A missing model or a failed model start degrades to lexical ranking with a notice — never silent, never an automatic download.

## Data and privacy

- Primary source: the [dsh.so plugin directory](https://www.dsh.so/plugins-index.json), CC-BY-4.0. Every report carries `Powered by dsh.so — DSH Developer Hub` and the source data timestamp.
- Supplement: [dsh-plugin-catalog](https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json), CC0-1.0 (compatibility info and repository URLs).
- The npm registry is used only to resolve exact README versions, not for inclusion or ranking.
- Only entries with an install target are included — every result answers "how do I install it".
- The index is a local cache: not uploaded, not shared, not served.

## Known limits

- Chinese queries depend on the AI's English rewrite; a drifted rewrite can pull in adjacent plugins or miss the target. The evidence gates suppress part of it, not all of it.
- Some broad scenarios (e.g. "use it from my phone" needs) may recall weakly.
- `updatedAt` comes from catalog data; entries outside the catalog show no update date.
- Upstream detection relies on the catalog title; copies without one may still appear as separate entries.
- Vector mode is off by default; pull the model package before enabling it.
- Verified on Windows only; macOS / Linux should work in theory but are untested.

## License

MIT for the code. Index data keeps its source licenses and attribution (CC-BY-4.0 for dsh.so, CC0-1.0 for the catalog).
