# dsh-plugin-discover-model

Optional embedding model package for `dsh-plugin-discover`. It contains the
int8-quantized `multilingual-e5-small` ONNX model (384 dimensions, 512 tokens),
its tokenizer, and an embedding API plus a line-delimited JSON server for the
Host to run in a child process.

The main plugin does **not** depend on this package. Installing it is an
explicit user action (`model pull`), so users who leave `vector.mode` off never
download these ~420 MB.

## Contents

| File | Size | SHA-256 |
|---|---:|---|
| `model_quantized.onnx` | 118,308,185 B | `f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193` |
| `tokenizer.json` | 17,082,730 B | `0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39` |
| `config.json` | 658 B | `cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1` |
| `tokenizer_config.json` | 443 B | `a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b` |
| `special_tokens_map.json` | 167 B | `d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7` |

- Model: `Xenova/multilingual-e5-small`, converted from
  `intfloat/multilingual-e5-small`.
- Source: `https://hf-mirror.com/Xenova/multilingual-e5-small/resolve/main/`
- 384 dimensions, 512-token limit, `query:` / `passage:` prefixes.
- Inputs: `input_ids`, `attention_mask`, `token_type_ids`; output:
  `last_hidden_state`.

## Install

The model package is not a dependency of the plugin. Install it explicitly
through the plugin's CLI:

```bash
dsh-plugin-discover model status
dsh-plugin-discover model pull      # dsh-plugin-discover-model@0.1.0 from npm
```

`model pull` runs `pnpm add` in the DSH profile directory, so the package lands
in the profile's `node_modules` together with its runtime dependencies
(`onnxruntime-node`, `@huggingface/tokenizers`). It then verifies every file
against `manifest.json` (SHA-256 by default) and writes a `model.json` pointer
into the plugin's index directory; `model status` reports the installed
package, its runtime dependencies, and the pointer.

pnpm may exit non-zero with `ERR_PNPM_IGNORED_BUILDS` because
`onnxruntime-node`'s build script is skipped. The package ships prebuilt CPU
binaries, so a verified install is a warning, not a failure.

If npm is unavailable, install from the GitHub Release asset or from a local
checkout:

```bash
dsh-plugin-discover model pull --spec "https://github.com/apeiria-network/dsh-plugin-discover/releases/download/model-v0.1.0/dsh-plugin-discover-model-0.1.0.tgz"
dsh-plugin-discover model pull --spec "link:D:\dsh-plugin-discover\models\multilingual-e5-small"
dsh-plugin-discover model pull --spec "file:D:\dsh-plugin-discover\models\multilingual-e5-small\dsh-plugin-discover-model-0.1.0.tgz"
```

The packed tarball is about 78.5 MiB; installing it also pulls
`onnxruntime-node` (about 300 MB unpacked). The model files are identical in
every channel — `manifest.json` records their sizes and SHA-256.

## API

```js
import { createEmbedder, verifyModel } from 'dsh-plugin-discover-model'

const embedder = await createEmbedder()
const query = await embedder.embedQuery('任务完成时给我发微信通知')
const passage = await embedder.embedPassage('Notifies via WeCom when a turn ends.')
await embedder.dispose()
```

`embed`/`embedMany` handle the e5 prefix, truncate to 512 tokens (keeping the
last token), mean-pool over the token vectors, and L2-normalize so a dot product
is a cosine similarity.

`server.js` is the child-process protocol. Each stdin line is one JSON request:

```json
{"id":2,"op":"embed","kind":"query","texts":["..."],"maxTokens":512}
```

and each stdout line is one response:

```json
{"id":2,"model":"multilingual-e5-small","dimensions":384,"vectors":[[...]]}
```

`{"op":"info"}` returns metadata without loading the model. The server exits
after 5 minutes idle.

## Verification

The package was installed from its tarball into the `web` profile. Both the
package's own `verify.js` and `server.js` were run from the installed location:

```json
{
  "loadMs": 946,
  "dimensions": 384,
  "queryTokens": 13,
  "simWecom": 0.812,
  "simPdf": 0.7326,
  "documents": 50,
  "docsMs": 240,
  "msPerDoc": 4.8,
  "rssMb": 410
}
```

The server returned 384-dimensional vectors for one query and two passages.

The ONNX session is capped at **4 intra-op threads** and **1 inter-op thread**
(`DSH_MODEL_THREADS` overrides the former). The default one-thread-per-core
pool saturated the 16-core host and then degraded to 12–15 s per 50 documents
under CPU quota/thermal pressure; four threads hold 2.3–3.1 s and leave the
rest of the machine alone. The Host does not recycle the child by document
count; `DSH_MODEL_RECYCLE_DOCS` is an optional escape hatch.
Steady-state RSS is around 410–520 MB, which is why the Host must run this in a
child process, not in the main process.

## License

MIT for the package code. Model weights: `intfloat/multilingual-e5-small`,
MIT; ONNX conversion by `Xenova/multilingual-e5-small`. Verify the current
upstream license before redistribution. See `LICENSE`.

## Status

- Model weights, tokenizer, runtime dependencies, API, server, pull/status:
  ready and tested.
- Main plugin vector runtime: `fields` and `readme` are implemented; it reads
  `model.json`, spawns `server.js`, caches fp16 vectors and excerpts, and
  reranks the BM25 top-50. `vector.mode` stays `off` by default; opt in per row.
