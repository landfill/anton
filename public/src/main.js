// Jev Face Lab — 앱 진입점
// 텍스트 입력 → Jev → 수신자 감정 + 강도 → 표정 변환 엔진 → 52 blendshape → 사진 기반 얼굴 모델
import * as THREE from "three";
import { buildFaceRig, BLENDSHAPE_NAMES } from "./face/faceRig.js";
import { FaceView } from "./face/faceView.js";
import { JevClient, isComposing } from "./jev/jevClient.js";
import { EMOTIONS, EMOTION_LABELS, analyzeLocal, focusSegment } from "./jev/localJev.js";
import { expressionFromAnalysis, DEFAULT_EXPRESSIVENESS } from "./expression/emotionMap.js";
import { FaceAnimator } from "./expression/animator.js";

const $ = (id) => document.getElementById(id);
// 예시: 7가지 감정이 고루 나오도록 + 입력 도중 표정이 뒤집히는 "반전" 문장
const EXAMPLES = [
  { text: "사랑해 ㅎㅎ" },
  { text: "헐 대박 합격했어!!" },
  { text: "너 때문에 너무 속상해" },
  { text: "미안해 ㅠㅠ" },
  { text: "너 진짜 최악이야 ㅡㅡ" },
  { text: "닥쳐" },
  { text: "헐 설마 그게 진짜야?!" },
  { text: "우리 얘기 좀 해" },
  { text: "어떡해 사고 났어" },
  { text: "그게 무슨 말이야;;" },
  { text: "으 역겨워 🤮" },
  { text: "알겠어." },
  { text: "고마워..." },
  { text: "고마워. 다시는 연락하지 마.", flip: true },
  { text: "축하해! 근데 나 안 가", flip: true },
  { text: "보고 싶었어. 근데 이제 필요 없어", flip: true },
  { text: "너는 아주 사랑스러....럽지 않은 인상이지만 너를 좋아하... 지도 않아..", flip: true, from: "joy", label: "사랑스러....럽지 않은… (롤러코스터)" },
];
const levelOf = (x) => (x < 0.05 ? "반응 없음" : x < 0.5 ? "미묘함" : x < 0.7 ? "뚜렷함" : x < 0.88 ? "강함" : "매우 강함");
const colorOf = (e) => `var(--${e})`;

// ── 얼굴 모델 로드 ────────────────────────────────────────
const [model, tesselation, texture] = await Promise.all([
  fetch("assets/face-landmarks.json").then((r) => r.json()),
  fetch("src/face/tesselation.json").then((r) => r.json()),
  new THREE.TextureLoader().loadAsync("assets/face.webp"),
]);
const rig = buildFaceRig(model, tesselation);
const view = new FaceView($("face"), rig, texture);
const animator = new FaceAnimator();
$("loading").remove();

const stage = $("stage");
new ResizeObserver(() => view.resize(stage.clientWidth, stage.clientHeight)).observe(stage);
view.resize(stage.clientWidth, stage.clientHeight);

// ── Jev ─────────────────────────────────────────────────
const jev = await new JevClient().init();
function renderEngine() {
  $("modeRemote").disabled = !jev.remoteAvailable;
  $("modeRemote").title = jev.remoteAvailable ? `TypeSafe AI Jev (${jev.model})` : "서버에 TYPESAFE_API_KEY가 설정되지 않았습니다";
  $("modeRemote").setAttribute("aria-pressed", String(jev.mode === "remote"));
  $("modeLocal").setAttribute("aria-pressed", String(jev.mode === "local"));
  $("engineDot").classList.toggle("live", jev.mode === "remote");
  $("metaEngine").textContent = jev.mode === "remote" ? "Jev API" : "로컬 시뮬레이터";
  $("metaModel").textContent = jev.mode === "remote" ? jev.model : "rule-based (offline)";
}
for (const b of document.querySelectorAll(".seg")) {
  b.addEventListener("click", () => { jev.setMode(b.dataset.mode); renderEngine(); runAnalysis(); });
}
renderEngine();

// ── 파이프라인 표시 ───────────────────────────────────────
const stageEl = (s) => document.querySelector(`.pipeline [data-stage="${s}"]`);
function pulse(...stages) {
  for (const s of stages) {
    const el = stageEl(s);
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("pulse"), 260);
  }
}

// ── 분포 / 근거 / 기록 UI ─────────────────────────────────
const distEl = $("dist");
const distRows = {};
for (const e of EMOTIONS) {
  const li = document.createElement("li");
  li.style.setProperty("--c", colorOf(e));
  li.innerHTML = `<span class="name">${EMOTION_LABELS[e]}</span><span class="bar"><span></span></span><span class="val">0.00</span>`;
  distEl.append(li);
  distRows[e] = { li, bar: li.querySelector(".bar > span"), val: li.querySelector(".val") };
}

// 표정 기준: "live" = 방금 읽은 구절 위주(재미용, 기본), "whole" = 메시지 전체
let basis = "live";
try { if (localStorage.getItem("jev-face-basis") === "whole") basis = "whole"; } catch {}
const mixLabel = (r) => {
  const topP = r.probabilities[r.emotion] ?? 0;
  return r.emotion === "neutral" ? [] : EMOTIONS
    .filter((e) => e !== "neutral" && e !== r.emotion && (r.probabilities[e] ?? 0) >= topP * 0.6 && (r.probabilities[e] ?? 0) > 0.08)
    .sort((a, b) => r.probabilities[b] - r.probabilities[a]).slice(0, 2);
};
const shortLabel = (r) => (!r || r.intensity < 0.05 ? "중립" : `${[r.emotion, ...mixLabel(r)].map((e) => EMOTION_LABELS[e]).join("·")} ${r.intensity.toFixed(2)}`);

/** 얼굴을 움직일 판단: live면 지금 구절 80% + 전체 20% (구절이 무덤덤하면 전체 판단으로 돌아감) */
function faceAnalysis(r) {
  const m = r.moment;
  if (basis === "whole" || !m) return r;
  const a = 0.8 * Math.min(1, m.intensity / 0.25);
  const probabilities = {};
  for (const e of EMOTIONS) probabilities[e] = a * (m.probabilities[e] ?? 0) + (1 - a) * (r.probabilities[e] ?? 0);
  const emotion = EMOTIONS.reduce((x, y) => (probabilities[y] > probabilities[x] ? y : x), "neutral");
  return { ...r, emotion, probabilities, intensity: a * m.intensity + (1 - a) * r.intensity };
}

function renderAnalysis(r) {
  const root = document.documentElement;
  const f = faceAnalysis(r);
  root.style.setProperty("--emo", colorOf(f.intensity < 0.05 ? "neutral" : f.emotion));
  // 카드 = 얼굴이 보여 주는 판단. 주 감정 + 비중이 비슷한 보조 감정(주 감정의 60% 이상): 예) 슬픔 · 당혹 · 놀람
  const mix = mixLabel(f);
  $("verdictKicker").textContent = basis === "live" ? "지금 읽는 순간" : "메시지 전체를 읽고";
  $("verdictEmotion").textContent = f.intensity < 0.05 ? "중립" : EMOTION_LABELS[f.emotion];
  $("verdictMix").textContent = mix.length && f.intensity >= 0.05 ? ` · ${mix.map((e) => EMOTION_LABELS[e]).join(" · ")}` : "";
  $("verdictLevel").textContent = levelOf(f.intensity);
  $("verdictIntensity").textContent = f.intensity.toFixed(2);
  $("verdictMeter").style.width = `${Math.round(f.intensity * 100)}%`;
  $("verdictOther").textContent = !$("message").value.trim() ? ""
    : basis === "live" ? `메시지 전체: ${shortLabel(r)}` : r.moment ? `지금 읽는 부분: ${shortLabel(r.moment)}` : "";

  for (const e of EMOTIONS) {
    const p = r.probabilities[e] ?? 0;
    distRows[e].bar.style.width = `${Math.round(p * 100)}%`;
    distRows[e].val.textContent = p.toFixed(2);
    distRows[e].li.classList.toggle("top", e === r.emotion);
  }
  $("confidence").textContent = `신뢰도 ${Math.round((r.confidence ?? 0) * 100)}%`;

  const cues = $("cues");
  cues.replaceChildren();
  if (!r.cues?.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = $("message").value.trim() ? "뚜렷한 감정 단서가 없습니다." : "메시지를 입력하면 Jev가 반응한 단서가 여기에 표시됩니다.";
    cues.append(li);
  } else {
    for (const c of r.cues) {
      const li = document.createElement("li");
      li.style.setProperty("--c", colorOf(c.emotion || "neutral"));
      const code = document.createElement("code");
      code.textContent = c.text;
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = c.label + (c.emotion ? ` → ${EMOTION_LABELS[c.emotion]}` : "");
      li.append(code, lbl);
      cues.append(li);
    }
  }
  $("cueSource").textContent = r.source === "remote" ? "단서: 로컬 보조 분석" : "";
  $("metaLatency").textContent = r.latencyMs < 1 ? "<1 ms" : `${Math.round(r.latencyMs)} ms`;

  $("pEmotion").textContent = `${EMOTION_LABELS[f.emotion]} ${f.intensity.toFixed(2)}`;
  $("pJev").textContent = r.source === "remote" ? `${Math.round(r.latencyMs)}ms` : "로컬";
}

const history = [];
function pushHistory(text, r) {
  if (!text.trim() || history[0]?.text === text) return;
  history.unshift({ text, r });
  history.length = Math.min(history.length, 12);
  const ol = $("history");
  ol.replaceChildren();
  for (const h of history) {
    const li = document.createElement("li");
    li.style.setProperty("--c", colorOf(h.r.emotion));
    li.title = "이 메시지 다시 보기";
    const dot = document.createElement("span"); dot.className = "dot";
    const txt = document.createElement("span"); txt.className = "txt"; txt.textContent = h.text;
    const emo = document.createElement("span"); emo.className = "emo"; emo.textContent = `${EMOTION_LABELS[h.r.emotion]} ${h.r.intensity.toFixed(2)}`;
    li.append(dot, txt, emo);
    li.addEventListener("click", () => { setMessage(h.text); });
    ol.append(li);
  }
}

// ── 입력 → 판단 ─────────────────────────────────────────
const input = $("message");
let seq = 0;
// 원격 호출 간격: 계속 타이핑해도 0.4초에 한 번(최신 텍스트로), 멈추면 0.12초 뒤 마지막 한 번 → 사용자당 최대 분당 150회
const REMOTE_MIN_GAP_MS = 400;
const REMOTE_SETTLE_MS = 120;
let remoteTimer = 0;
let lastRemoteAt = 0;
let limitToastAt = 0;
let historyTimer = 0;
let readingTimer = 0;
let current = null;

// 표현 강도(사용자 조절, 이 브라우저에만 기억)
let gain = DEFAULT_EXPRESSIVENESS;
try { const g = parseFloat(localStorage.getItem("jev-face-gain")); if (g >= 0.5 && g <= 2.5) gain = g; } catch {}
const gainInput = $("gain");
gainInput.value = gain;
$("gainOut").textContent = `×${gain.toFixed(1)}`;
gainInput.addEventListener("input", () => {
  gain = +gainInput.value;
  $("gainOut").textContent = `×${gain.toFixed(1)}`;
  try { localStorage.setItem("jev-face-gain", String(gain)); } catch {}
  if (current) { const f = faceAnalysis(current); animator.setTarget(expressionFromAnalysis(f, gain), f.intensity); }
});

for (const b of document.querySelectorAll(".basis button")) {
  b.setAttribute("aria-pressed", String(b.dataset.basis === basis));
  b.addEventListener("click", () => {
    basis = b.dataset.basis;
    try { localStorage.setItem("jev-face-basis", basis); } catch {}
    for (const o of document.querySelectorAll(".basis button")) o.setAttribute("aria-pressed", String(o.dataset.basis === basis));
    if (current) applyAnalysis(current);
  });
}

function applyAnalysis(r) {
  current = r;
  const f = faceAnalysis(r);
  animator.setTarget(expressionFromAnalysis(f, gain), f.intensity);
  renderAnalysis(r);
  pulse("jev", "emotion", "convert", "blend");
}

function scheduleRemote() {
  if (remoteTimer) return; // 이미 예약됨: 실행 시점의 최신 텍스트를 보낸다
  const wait = Math.max(REMOTE_SETTLE_MS, lastRemoteAt + REMOTE_MIN_GAP_MS - performance.now());
  remoteTimer = setTimeout(() => {
    remoteTimer = 0;
    // 한글 조합 중(끝이 낱자모)이면 보내지 않는다 — 글자가 완성되면 다음 입력이 다시 예약한다
    if (isComposing(input.value)) return;
    lastRemoteAt = performance.now();
    runAnalysis();
  }, wait);
}

async function runAnalysis() {
  const text = input.value;
  const my = ++seq;
  stageEl("jev").classList.toggle("busy", jev.mode === "remote" && !!text.trim());
  try {
    const r = await jev.analyze(text);
    if (my !== seq) return;
    applyAnalysis(r);
  } catch (err) {
    if (err.name === "AbortError" || my !== seq) return;
    // 이번 호출만 로컬 판단으로 대체하고 Jev 모드는 유지한다(일시적 429/5xx 대비)
    if (err.status === 429) {
      $("pJev").textContent = "요청 제한";
      if (performance.now() - limitToastAt > 30000) {
        limitToastAt = performance.now();
        toast(`Jev 요청 제한에 걸려 잠시 로컬 시뮬레이터로 표시합니다. (${err.message})`);
      }
    } else {
      toast(`Jev API 호출 실패: ${err.message} — 이번 입력은 로컬 시뮬레이터 결과로 표시합니다.`);
    }
    const r = { ...analyzeLocal(text), moment: { ...analyzeLocal(focusSegment(text)), fragment: focusSegment(text) }, source: "local", latencyMs: 0 };
    if (my === seq) applyAnalysis(r);
  } finally {
    if (my === seq) stageEl("jev").classList.remove("busy");
  }
}

function onTextChanged() {
  const text = input.value;
  $("pText").textContent = `${[...text].length}자`;
  pulse("text");
  autoGrow();

  // 읽는 중: 시선이 입력창으로 내려오고, 입력이 멈추면 다시 앞을 본다
  animator.setReading(!!text.trim());
  $("reading").hidden = !text.trim();
  clearTimeout(readingTimer);
  readingTimer = setTimeout(() => { animator.setReading(false); $("reading").hidden = true; }, 1100);

  if (jev.mode === "remote") scheduleRemote();
  else runAnalysis();

  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => current && pushHistory(input.value, current), 900);
}
// input 이벤트는 한글 IME 조합 중에도 발생하므로 자모 단위 변화까지 반영된다
input.addEventListener("input", onTextChanged);
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) e.preventDefault(); });

function autoGrow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  input.style.overflowY = input.scrollHeight > 132 ? "auto" : "hidden";
}

function setMessage(text) {
  stopTyping();
  input.value = text;
  onTextChanged();
  input.focus();
}
$("clearBtn").addEventListener("click", () => setMessage(""));

// 예시: 한 글자씩 타이핑해서 판단이 어떻게 바뀌는지 보여 준다
let typingTimer = 0;
function stopTyping() { clearTimeout(typingTimer); typingTimer = 0; }
// slow: 반전 문장용 — 표정이 바뀌는 과정을 볼 수 있게 천천히, 문장부호 뒤에서는 뜸을 들인다
function typeOut(text, slow = false) {
  stopTyping();
  input.value = "";
  onTextChanged();
  const chars = [...text];
  const T = slow
    ? { char: 280, space: 260, punctInRun: 300, pause: 1000 }
    : { char: 150, space: 120, punctInRun: 200, pause: 260 };
  let k = 0;
  const step = () => {
    if (k >= chars.length) { typingTimer = 0; return; }
    input.value += chars[k++];
    onTextChanged();
    const ch = chars[k - 1], next = chars[k];
    const isP = (c) => /[.!?…,~]/.test(c || "");
    // 말줄임표처럼 이어지는 부호 중간은 짧게, 부호가 끝나는 지점에서 한 번 멈춘다
    const delay = isP(ch) ? (isP(next) ? T.punctInRun : T.pause) : ch === " " ? T.space : T.char;
    typingTimer = setTimeout(step, delay);
  };
  typingTimer = setTimeout(step, 250);
  input.focus();
}
for (const ex of EXAMPLES) {
  // 점 색 = 로컬 판단 기준의 예상 감정(반전 문장은 처음 → 끝 두 색)
  const end = analyzeLocal(ex.text);
  const start = ex.from ? { emotion: ex.from } : analyzeLocal(focusSegment([...ex.text].slice(0, Math.ceil([...ex.text].length * 0.3)).join("")));
  const b = document.createElement("button");
  b.className = "chip";
  b.title = `${ex.text}\n예상: ${ex.flip ? `${EMOTION_LABELS[start.emotion]} → ` : ""}${EMOTION_LABELS[end.emotion]} (한 글자씩 자동 입력)`;
  const dot = document.createElement("span");
  dot.className = "chip-dot";
  dot.style.setProperty("--a", colorOf(ex.flip ? start.emotion : end.emotion));
  dot.style.setProperty("--b", colorOf(end.emotion));
  const txt = document.createElement("span");
  txt.className = "chip-text";
  txt.textContent = ex.label || ex.text;
  b.append(dot, txt);
  if (ex.flip) {
    const tag = document.createElement("span");
    tag.className = "chip-tag";
    tag.textContent = "반전";
    b.append(tag);
  }
  b.addEventListener("click", () => typeOut(ex.text, !!ex.flip));
  $("examples").append(b);
}
input.addEventListener("keydown", stopTyping);

// ── Blendshape 인스펙터 ──────────────────────────────────
const GROUPS = [
  ["눈", (n) => n.startsWith("eye")],
  ["눈썹", (n) => n.startsWith("brow")],
  ["턱", (n) => n.startsWith("jaw")],
  ["입", (n) => n.startsWith("mouth")],
  ["볼 · 코 · 혀", (n) => /^(cheek|nose|tongue)/.test(n)],
];
const manual = new Float32Array(BLENDSHAPE_NAMES.length);
const bsRows = [];
for (const [title, test] of GROUPS) {
  const g = document.createElement("div");
  g.className = "bs-group";
  g.innerHTML = `<h3>${title}</h3>`;
  BLENDSHAPE_NAMES.forEach((name, i) => {
    if (!test(name)) return;
    const row = document.createElement("div");
    row.className = "bs-row";
    row.innerHTML = `<span class="n" title="${name}">${name}</span><span class="b"><span></span></span><span class="v">0.00</span>`;
    const slider = document.createElement("input");
    Object.assign(slider, { type: "range", min: 0, max: 1, step: 0.01, value: 0 });
    slider.setAttribute("aria-label", name);
    slider.hidden = true;
    slider.addEventListener("input", () => { manual[i] = +slider.value; });
    row.querySelector(".b").after(slider);
    g.append(row);
    bsRows[i] = { row, bar: row.querySelector(".b > span"), barWrap: row.querySelector(".b"), val: row.querySelector(".v"), slider };
  });
  $("bsList").append(g);
}
const manualToggle = $("manual");
manualToggle.addEventListener("change", () => {
  for (let i = 0; i < bsRows.length; i++) {
    const r = bsRows[i];
    r.slider.hidden = !manualToggle.checked;
    r.barWrap.hidden = manualToggle.checked;
    if (manualToggle.checked) { manual[i] = lastWeights[i]; r.slider.value = manual[i]; }
  }
});

// 탭
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) { t.classList.toggle("active", t === tab); t.setAttribute("aria-selected", String(t === tab)); }
    for (const b of document.querySelectorAll(".tab-body")) b.hidden = b.dataset.body !== tab.dataset.tab;
  });
}

// ── 토스트 ──────────────────────────────────────────────
let toastTimer = 0;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

// ── 렌더 루프 ────────────────────────────────────────────
const lastWeights = new Float32Array(BLENDSHAPE_NAMES.length);
let last = performance.now();
let frame = 0;
let fpsAcc = 0, fpsN = 0;
function loop(now) {
  const dt = Math.max(0, (now - last) / 1000);
  last = now;
  const out = animator.update(dt);
  const weights = manualToggle.checked ? manual : out.weights;
  lastWeights.set(weights);
  view.update(weights, out.head, { flush: out.physio.flush, flushColor: out.physio.color, pale: out.physio.pale });

  fpsAcc += dt; fpsN++;
  if (++frame % 6 === 0) {
    let active = 0;
    for (let i = 0; i < weights.length; i++) {
      const v = weights[i];
      if (v > 0.02) active++;
      const r = bsRows[i];
      if (!manualToggle.checked) r.bar.style.width = `${(v * 100).toFixed(1)}%`;
      r.val.textContent = v.toFixed(2);
      r.row.classList.toggle("on", v > 0.02);
    }
    $("pBlend").textContent = `활성 ${active} / 52`;
  }
  if (fpsAcc > 1) { $("pFace").textContent = `${Math.round(fpsN / fpsAcc)} fps`; fpsAcc = 0; fpsN = 0; }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// 초기 상태
applyAnalysis(await jev.analyze(""));
window.__jevFace = { rig, view, animator, jev, setMessage, typeOut };
