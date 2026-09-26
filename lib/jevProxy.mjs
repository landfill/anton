// Jev(TypeSafe AI System One) 프록시 — Web 표준 Request/Response 기반.
// Vercel 함수(api/jev/*)와 로컬 서버(server.mjs)가 같은 로직을 쓴다.
// API 키는 서버 환경변수에만 있고 브라우저로 나가지 않는다.
//
// 환경변수
//   TYPESAFE_API_KEY          (필수) Jev API 키
//   TYPESAFE_DEFAULT_MODEL    기본 jev-latest
//   TYPESAFE_BASE_URL         기본 https://api.typesafe.ai
//   JEV_RATE_LIMIT_PER_MIN    IP당 분당 허용 호출 수(기본 180 — 클라이언트 최대 150회 + 여유)
//   JEV_GLOBAL_LIMIT_PER_MIN  인스턴스 전체 분당 허용 호출 수(기본 1500)
//   JEV_ALLOWED_ORIGINS       호출을 허용할 추가 Origin(쉼표 구분). 같은 호스트는 항상 허용
//   JEV_MAX_MESSAGE_CHARS     메시지 최대 길이(기본 500)

const env = (k, d) => (typeof process !== "undefined" && process.env?.[k]?.trim()) || d;
const num = (k, d) => { const v = Number(env(k, "")); return Number.isFinite(v) && v > 0 ? v : d; };

export function jevConfig() {
  return {
    apiKey: env("TYPESAFE_API_KEY", ""),
    model: env("TYPESAFE_DEFAULT_MODEL", "jev-latest"),
    baseURL: env("TYPESAFE_BASE_URL", "https://api.typesafe.ai").replace(/\/+$/, ""),
    perIpPerMin: num("JEV_RATE_LIMIT_PER_MIN", 180),
    globalPerMin: num("JEV_GLOBAL_LIMIT_PER_MIN", 1500),
    allowedOrigins: env("JEV_ALLOWED_ORIGINS", "").split(",").map((s) => s.trim()).filter(Boolean),
    maxChars: num("JEV_MAX_MESSAGE_CHARS", 500),
  };
}

// ── 요청 제한(슬라이딩 윈도 1분) ─────────────────────────────
// 서버리스는 인스턴스마다 메모리가 따로라 "최선 노력" 제한이다(인스턴스가 재사용되는 동안 유지).
// 여러 인스턴스에 걸친 엄격한 제한이 필요하면 Upstash/Vercel KV 같은 공유 저장소로 바꾼다.
const WINDOW_MS = 60_000;
const hits = new Map(); // key -> number[] (timestamps)
function allow(key, limit, now = Date.now()) {
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return { ok: false, retryAfterMs: WINDOW_MS - (now - arr[0]), remaining: 0 };
  }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > WINDOW_MS) hits.delete(k);
  return { ok: true, remaining: limit - arr.length };
}
export function _resetRateLimit() { hits.clear(); }

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

function clientIp(request) {
  const h = request.headers;
  return (h.get("x-real-ip") || h.get("x-forwarded-for")?.split(",")[0] || h.get("cf-connecting-ip") || "local").trim();
}

function originAllowed(request, cfg) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // 같은 출처의 일부 요청·서버 간 호출은 Origin이 없다(아래 Sec-Fetch-Site로 보완)
  let o;
  try { o = new URL(origin); } catch { return false; }
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (host && o.host === host) return true;
  return cfg.allowedOrigins.includes(origin);
}

/** GET /api/jev/status */
export function handleStatus() {
  const cfg = jevConfig();
  return json(200, { configured: Boolean(cfg.apiKey), model: cfg.model, limitPerMin: cfg.perIpPerMin });
}

/** POST /api/jev */
export async function handleJev(request) {
  const cfg = jevConfig();
  if (request.method !== "POST") return json(405, { error: "Method not allowed" }, { Allow: "POST" });
  if (!cfg.apiKey) return json(503, { error: "TYPESAFE_API_KEY is not configured on the server." });
  if (!originAllowed(request, cfg) || request.headers.get("sec-fetch-site") === "cross-site") {
    return json(403, { error: "Origin not allowed." });
  }

  const ip = clientIp(request);
  const perIp = allow(`ip:${ip}`, cfg.perIpPerMin);
  if (!perIp.ok) {
    return json(429, { error: `요청 제한: 분당 ${cfg.perIpPerMin}회를 넘었습니다.` }, { "Retry-After": String(Math.ceil(perIp.retryAfterMs / 1000)), "retry-after-ms": String(perIp.retryAfterMs) });
  }
  const global = allow("global", cfg.globalPerMin);
  if (!global.ok) {
    return json(429, { error: "서버 전체 요청 제한에 걸렸습니다. 잠시 후 다시 시도하세요." }, { "Retry-After": String(Math.ceil(global.retryAfterMs / 1000)) });
  }

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: "Invalid JSON body." }); }
  const message = payload?.state?.message;
  if (typeof message !== "string" || !payload.questions || typeof payload.questions !== "object") {
    return json(400, { error: "state.message and questions are required." });
  }
  if ([...message].length > cfg.maxChars) return json(413, { error: `메시지는 ${cfg.maxChars}자까지 판단합니다.` });

  const body = JSON.stringify({ state: payload.state, questions: payload.questions, model: cfg.model });
  const call = () => fetch(`${cfg.baseURL}/v1/systemone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  const started = Date.now();
  try {
    let upstream = await call();
    // 429 / 5xx 는 한 번만 재시도
    if (upstream.status === 429 || upstream.status >= 500) {
      const ra = Number(upstream.headers.get("retry-after-ms")) || Number(upstream.headers.get("retry-after")) * 1000 || 400;
      await new Promise((r) => setTimeout(r, Math.min(ra, 2000)));
      upstream = await call();
    }
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Jev-Latency": String(Date.now() - started),
        "X-RateLimit-Remaining": String(perIp.remaining),
      },
    });
  } catch (err) {
    return json(502, { error: `Upstream error: ${err.message}` });
  }
}
