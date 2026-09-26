// Jev Face Lab 로컬 서버
// - 정적 파일 서빙 (ES module / fetch 때문에 file:// 로는 동작하지 않음)
// - /api/jev : TypeSafe AI Jev(System One) 프록시. API 키는 서버에만 두고 브라우저에 노출하지 않는다.
//   키는 환경변수 TYPESAFE_API_KEY 또는 프로젝트 루트의 .env 에서 읽는다.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleJev, handleStatus, jevConfig } from "./lib/jevProxy.mjs";

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

// Node 요청 → Web Request 로 바꿔 Vercel 함수와 같은 프록시 로직(lib/jevProxy.mjs)을 쓴다
async function toWebRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("x-real-ip", req.socket.remoteAddress || "local");
  return new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
}
async function sendWebResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/jev/status") return sendWebResponse(res, handleStatus());
  if (url.pathname === "/api/jev") return sendWebResponse(res, await handleJev(await toWebRequest(req)));

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
  const cfg = jevConfig();
  console.log(cfg.apiKey ? `Jev API: 연결됨 (model ${cfg.model}, IP당 분당 ${cfg.perIpPerMin}회 제한)` : "Jev API: 키 없음 → 브라우저의 로컬 Jev 시뮬레이터로 동작");
});
server.listen(port);
