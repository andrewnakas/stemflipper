# Cross-origin isolation for `/stemflipper/` — what to change in the audiosaw repo

This is a hand-off, not a to-do for this repo: the file that needs editing lives in the
private audiosaw.com repo, which this one has no copy of.

## Read this first: it is now an optimisation, not a fix

It used to be load-bearing. The browser path ran UVR-MDX-NET, which costs **1.1 s per second
of audio on a GPU and 31 s on a single CPU core** — so a visitor without WebGPU effectively
could not run anything locally, and the only way to help them was to unlock WASM threads,
which needs these headers.

That changed when the default engine became Spleeter 4stems. Measured on an Apple M1:

| engine | WebGPU | 1 core, no isolation | threads (estimated) |
|---|---|---|---|
| Spleeter 4stems (default) | 0.21x | **0.66x** | ~0.35x |
| UVR-MDX-NET (2 stems) | 1.1x | 31x | 10x |
| htdemucs (4 stems) | ~18x | much worse | ~40x |

The default engine is now **faster than the song is long without any isolation at all**. So
these headers buy roughly a 2x speed-up on the default path, and a large one on the two-stem
path — worth having, not worth blocking on. Nothing in StemFlipper requires them:
`local/capability.ts` detects `crossOriginIsolated`, picks the cost accordingly, and the run
screen states the honest estimate either way.

## The change

`/stemflipper/*` is served by a Cloudflare Pages **Function**, and `_headers` does not apply
to Function responses. So the headers have to be set in the function itself —
`functions/stemflipper/[[path]].js` — not in `_headers`:

```js
const res = await fetch(upstream, init);           // the existing GitHub Pages proxy fetch
const out = new Response(res.body, res);
out.headers.set("Cross-Origin-Opener-Policy", "same-origin");
out.headers.set("Cross-Origin-Embedder-Policy", "credentialless");
return out;
```

Use **`credentialless`**, not `require-corp`, exactly as audiosaw's `/stem-splitter` already
does in `_headers`. With `require-corp` every cross-origin subresource must send a CORP
header, and the ones this app fetches do not: the ONNX models come from
`huggingface.co`, the onnxruntime wasm from `cdn.jsdelivr.net`. `credentialless` sends those
requests without credentials instead of requiring the header, so they keep loading.

## Two traps, both already paid for once

1. **A worker spawned from an isolated page must itself be served with a COEP header**, or it
   fails to be created at all — before its first line runs, with an opaque error. This is
   already documented in the audiosaw repo. The separation worker is a hashed asset under
   `/stemflipper/assets/`, so the header must cover the whole path, not just navigations.
2. **`sw.js` must bypass `/stemflipper`.** audiosaw has a root-scoped service worker doing
   network-first navigations and cache-first `STATIC_PATHS`. If it serves a cached response
   for a StemFlipper asset, that response will not carry the headers and isolation silently
   breaks for that request. Add `/stemflipper` to its `BYPASS` regex.

## One more thing is needed for threads to actually engage

Isolation is necessary but not sufficient. `local/ortRuntime.ts` points `wasmPaths` at
`https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/`. A cross-origin wasm fetch is
fine under `credentialless`, but if it ever turns out not to be, the fix is self-hosting
onnxruntime's binaries (~33 MB committed) the way audiosaw vendors them in `vendor/ort/`.
Deliberately not done here: it is 33 MB in the repo for a ~2x win on a path that is already
faster than realtime.

## How to verify, in this order

1. `curl -I https://audiosaw.com/stemflipper/` — both headers present.
2. `curl -I https://audiosaw.com/stemflipper/assets/<hashed>.js` — **also** both headers.
   If navigations have them and assets do not, the worker will not construct.
3. In the page console: `crossOriginIsolated` is `true`, and `typeof SharedArrayBuffer`
   is `"function"`.
4. Drop a file, pick "In your browser", and confirm the run screen's estimate dropped —
   `capability.ts` reads `crossOriginIsolated` and switches to the `threads` cost.
5. Confirm a run still completes. If the worker throws an opaque construction error, it is
   trap 1 or trap 2, not the header values.
6. Check the two-stem engine especially: it is the one with the most to gain (31x → 10x).
