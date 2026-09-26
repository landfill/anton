// Jev 클라이언트
// - remote: 로컬 서버(/api/jev)를 거쳐 TypeSafe AI Jev System One API(POST /v1/systemone) 호출.
//   질문 2개를 한 번의 왕복으로 묻는다: 수신자 감정(choice) + 강도(score).
// - local : 키가 없을 때 쓰는 규칙 기반 시뮬레이터(localJev.js).
// 두 경로 모두 { emotion, intensity, confidence, probabilities, cues, source, latencyMs } 로 정규화한다.
import { analyzeLocal, focusSegment, EMOTIONS } from "./localJev.js";

const EMOTION_CRITERIA = {
  joy: "기쁨·고마움·반가움·안도",
  sadness: "슬픔·서운함·상처·상실감",
  anger: "분노·짜증·모욕감",
  surprise: "놀람·충격·예상 밖",
  anxiety: "불안·걱정·초조·긴장",
  bewilderment: "당혹·당황·어리둥절·어색함",
  disgust: "혐오·불쾌·거부감",
  neutral: "특별한 감정 반응 없음",
};
const INTENSITY_RUBRIC = ["감정 반응 없음", "미묘함(스치는 정도)", "뚜렷함", "강함", "매우 강함(압도적)"];

export function buildJevRequest(message) {
  return {
    state: {
      task: "아래 메시지를 받은 수신자의 감정 반응을 판단한다. 문장부호(말줄임표, 마침표, 느낌표), 앞뒤 문장의 반전, 어투의 온도까지 고려한다. latest_fragment는 수신자가 지금 막 읽은 마지막 구절이다.",
      message,
      latest_fragment: focusSegment(message),
    },
    questions: {
      emotion: { type: "choice", instructions: "메시지 전체를 다 읽은 수신자가 가장 강하게 느낄 감정", criteria: EMOTION_CRITERIA },
      intensity: { type: "score", instructions: "메시지 전체에 대한 수신자의 감정 반응 강도", criteria: INTENSITY_RUBRIC },
      moment: { type: "choice", instructions: "latest_fragment를 읽는 바로 그 순간 수신자가 느낄 즉각적인 감정(앞 내용을 뒤집는 말이면 뒤집힐 때의 감정)", criteria: EMOTION_CRITERIA },
      momentIntensity: { type: "score", instructions: "latest_fragment를 읽는 순간의 감정 반응 강도", criteria: INTENSITY_RUBRIC },
    },
  };
}

const fromChoiceScore = (c, s) => {
  if (!c?.choice) return null;
  const probabilities = Object.fromEntries(EMOTIONS.map((e) => [e, Number(c.probabilities?.[e] ?? 0)]));
  const intensity = Math.max(0, Math.min(1, Number(s?.score ?? 2) / (INTENSITY_RUBRIC.length - 1)));
  return { emotion: c.choice, intensity, confidence: Number(c.confidence ?? 0), probabilities };
};

export function normalizeJevResponse(data) {
  const overall = fromChoiceScore(data?.answers?.emotion, data?.answers?.intensity);
  if (!overall) throw new Error("Unexpected Jev response shape");
  return {
    ...overall,
    moment: fromChoiceScore(data?.answers?.moment, data?.answers?.momentIntensity),
    cues: [],
    model: data.model,
    usage: data.usage,
  };
}

export class JevClient {
  constructor() {
    this.mode = "local"; // "remote" | "local"
    this.remoteAvailable = false;
    this.model = null;
    this._abort = null;
  }

  async init() {
    try {
      const r = await fetch("/api/jev/status", { cache: "no-store" });
      const s = await r.json();
      this.remoteAvailable = Boolean(s.configured);
      this.model = s.model;
      if (this.remoteAvailable) this.mode = "remote";
    } catch {
      this.remoteAvailable = false;
    }
    return this;
  }

  setMode(mode) {
    this.mode = mode === "remote" && this.remoteAvailable ? "remote" : "local";
  }

  /** 이전 요청은 취소하고 최신 텍스트만 판단한다. */
  async analyze(message) {
    const t0 = performance.now();
    if (this.mode === "local" || !message.trim()) {
      const r = analyzeLocal(message);
      const m = analyzeLocal(focusSegment(message));
      return { ...r, moment: { ...m, fragment: focusSegment(message) }, source: "local", latencyMs: performance.now() - t0 };
    }
    this._abort?.abort();
    const ctrl = new AbortController();
    this._abort = ctrl;
    const res = await fetch("/api/jev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildJevRequest(message)),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || body?.error || body?.detail || `HTTP ${res.status}`);
    const r = normalizeJevResponse(body);
    // 원격 판단에도 사람이 읽을 수 있는 단서는 로컬 분석기로 보조 표시한다
    r.cues = analyzeLocal(message).cues;
    if (r.moment) r.moment.fragment = focusSegment(message);
    return { ...r, source: "remote", latencyMs: performance.now() - t0 };
  }
}
