/**
 * A stand-in for the Space, so the upload flow can be tested without a GPU.
 *
 * It replays the SSE frames recorded from a REAL run (test/fixtures/gradio_frames.jsonl)
 * at a fraction of their original spacing, and serves the CI fixture bundle as the result.
 * That makes the one path CI could never cover — drop a file, watch it run, land on the
 * result — an ordinary test.
 *
 *   node scripts/mock_backend.mjs [--port 7861] [--mode ok|quota|sleeping|drop|slow]
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? true]] : [])),
);
const PORT = Number(args.port || process.env.MOCK_PORT || 7861);
const MODE = String(args.mode || process.env.MOCK_MODE || "ok");
/** Replay at 1/SPEED of the original timing; the real run took 28 s. */
const SPEED = Number(args.speed || (MODE === "slow" ? 1 : 25));

const FIXTURE_DIR = resolve(HERE, "../public/fixtures/ci");
const BUNDLE_ROOT = "/ci";

const frames = (await readFile(resolve(HERE, "../test/fixtures/gradio_frames.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const fixtureProject = JSON.parse(await readFile(join(FIXTURE_DIR, "project.json"), "utf8"));

const MIME = {
  ".json": "application/json",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".mid": "audio/midi",
  ".sfz": "text/plain",
  ".dspreset": "application/xml",
  ".vital": "application/json",
  ".txt": "text/plain",
  ".zip": "application/zip",
};

const QUOTA_ERROR =
  "You have exceeded your GPU quota (59s left vs. 60s requested). Sign-up on Hugging Face to get more quotas or retry in 2:13:40";

function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type, accept");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
}

function json(res, code, body) {
  cors(res);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

/** The finished-run frame, pointed at the fixture instead of the original bundle. */
function completedFrame(eventId) {
  const project = structuredClone(fixtureProject);
  project._server = { bundle_root: BUNDLE_ROOT };
  return {
    msg: "process_completed",
    event_id: eventId,
    success: true,
    output: {
      data: [
        {
          path: `${BUNDLE_ROOT}/bundle.zip`,
          url: `http://localhost:${PORT}/gradio_api/file=${BUNDLE_ROOT}/bundle.zip`,
          size: 1234567,
          orig_name: "bundle.zip",
          meta: { _type: "gradio.FileData" },
        },
        "**tempo** 120 BPM",
        "editor link",
        project,
      ],
      is_generating: false,
      duration: 3.2,
    },
  };
}

function failedFrame(eventId, error) {
  return { msg: "process_completed", event_id: eventId, success: false, output: { error } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Sleeping Space: refuse everything, as an unreachable container would.
  if (MODE === "sleeping") {
    cors(res);
    res.writeHead(503);
    res.end("asleep");
    return;
  }

  if (path === "/gradio_api/upload" && req.method === "POST") {
    await readBody(req);
    json(res, 200, ["/tmp/mock/song.wav"]);
    return;
  }

  if (path === "/gradio_api/queue/join" && req.method === "POST") {
    await readBody(req);
    json(res, 200, { event_id: "mock-event-1" });
    return;
  }

  if (path === "/gradio_api/reset" && req.method === "POST") {
    await readBody(req);
    json(res, 200, {});
    return;
  }

  if (path === "/gradio_api/queue/data") {
    cors(res);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);

    if (MODE === "quota") {
      setTimeout(() => {
        send({ msg: "process_starts", event_id: "mock-event-1" });
        send(failedFrame("mock-event-1", QUOTA_ERROR));
        res.end();
      }, 50);
      return;
    }

    let closed = false;
    req.on("close", () => (closed = true));
    const t0 = frames[0]?.at ?? 0;
    for (const f of frames) {
      if (closed) return;
      const wait = Math.max(0, (f.at - t0) / SPEED);
      await new Promise((r) => setTimeout(r, wait === 0 ? 0 : Math.min(wait, 4000)));
      if (closed) return;
      if (f.msg.msg === "process_completed") {
        if (MODE === "drop") {
          send({ msg: "close_stream" });
          res.end();
          return;
        }
        send(completedFrame(f.msg.event_id));
      } else {
        send(f.msg);
      }
    }
    res.end();
    return;
  }

  // /gradio_api/file=/ci/<rel> -> public/fixtures/ci/<rel>
  const fileMatch = path.match(/^\/gradio_api\/file=(.*)$/);
  if (fileMatch) {
    const abs = fileMatch[1];
    if (!abs.startsWith(BUNDLE_ROOT + "/")) {
      json(res, 403, { error: "outside the bundle" });
      return;
    }
    const rel = normalize(abs.slice(BUNDLE_ROOT.length + 1)).replace(/^(\.\.[/\\])+/, "");
    const file = join(FIXTURE_DIR, rel);
    try {
      const info = await stat(file);
      cors(res);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] || "application/octet-stream",
        "content-length": info.size,
      });
      createReadStream(file).pipe(res);
    } catch {
      cors(res);
      res.writeHead(404);
      res.end("not found");
    }
    return;
  }

  cors(res);
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`mock stemflipper backend (mode=${MODE})`);
});

server.listen(PORT, () => {
  console.log(`mock backend on http://localhost:${PORT} (mode=${MODE}, ${frames.length} frames, speed x${SPEED})`);
});
