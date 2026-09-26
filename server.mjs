// Jev Face Lab 로컬 서버
// - 정적 파일 서빙 (ES module / fetch 때문에 file:// 로는 동작하지 않음)
// - /api/jev : TypeSafe AI Jev(System One) 프록시. API 키는 서버에만 두고 브라우저에 노출하지 않는다.
//   키는 환경변수 TYPESAFE_API_KEY 또는 프로젝트 루트의 .env 에서 읽는다.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);

// .env 간단 파서 (의존성 없이)
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

const API_KEY = process.env.TYPESAFE_API_KEY?.trim();
const BASE_URL = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/+$/, "");
const MODEL = process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".obj": "text/plain; charset=utf-8",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function handleJev(req, res) {
  if (!API_KEY) return sendJson(res, 503, { error: "TYPESAFE_API_KEY is not configured on the server." });
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body." });
  }
  // 브라우저가 보낸 state/questions 만 전달한다.
  const body = { state: payload.state, questions: payload.questions, model: payload.model || MODEL };
  const started = Date.now();
  try {
    const call = () => fetch(`${BASE_URL}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-TypeSafe-Runtime": `node/${process.versions.node}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    let upstream = await call();
    // 429 / 5xx 는 한 번만 재시도(빠른 타이핑 중 일시적 제한 대비)
    if (upstream.status === 429 || upstream.status >= 500) {
      const ra = Number(upstream.headers.get("retry-after-ms")) || Number(upstream.headers.get("retry-after")) * 1000 || 400;
      await new Promise((r) => setTimeout(r, Math.min(ra, 2000)));
      upstream = await call();
    }
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Jev-Latency": String(Date.now() - started),
    });
    res.end(text);
  } catch (err) {
    sendJson(res, 502, { error: `Upstream error: ${err.message}` });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/jev/status") {
    return sendJson(res, 200, { configured: Boolean(API_KEY), model: MODEL });
  }
  if (url.pathname === "/api/jev" && req.method === "POST") return handleJev(req, res);

  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT) || file.includes(`${ROOT}\\.env`) || file.endsWith(".env")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

// 포트가 사용 중이면 다음 포트로 자동 이동(최대 10번)
let port = PORT;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && port < PORT + 10) {
    console.log(`포트 ${port} 사용 중 → ${port + 1} 시도`);
    port += 1;
    server.listen(port);
  } else {
    console.error(err.code === "EADDRINUSE" ? `포트 ${PORT}~${port}가 모두 사용 중입니다. PORT 환경변수로 다른 포트를 지정하세요.` : err);
    process.exit(1);
  }
});
server.on("listening", () => {
  console.log(`Jev Face Lab → http://localhost:${port}`);
  console.log(API_KEY ? `Jev API: 연결됨 (model ${MODEL})` : "Jev API: 키 없음 → 브라우저의 로컬 Jev 시뮬레이터로 동작");
});
server.listen(port);
