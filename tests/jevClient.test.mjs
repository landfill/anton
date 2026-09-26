// node tests/jevClient.test.mjs — Jev System One 요청/응답 형태 검증(네트워크 없음)
import assert from "node:assert/strict";
import { buildJevRequest, normalizeJevResponse } from "../src/jev/jevClient.js";

const req = buildJevRequest("고마워...");
// @typesafe-ai/sdk 0.6.0의 질문 규격: choice는 label→설명 맵, score는 2개 이상 설명 배열
assert.equal(req.questions.emotion.type, "choice");
assert.ok(!Array.isArray(req.questions.emotion.criteria));
assert.equal(req.questions.intensity.type, "score");
assert.ok(Array.isArray(req.questions.intensity.criteria) && req.questions.intensity.criteria.length >= 2);
assert.equal(req.state.message, "고마워...");

// SDK의 SystemOneResult 형태를 흉내 낸 응답
const sample = {
  model: "jev-1.13.0",
  usage: { input_tokens: 180, output_tokens: 0 },
  answers: {
    emotion: { type: "choice", choice: "anxiety", confidence: 0.61, probabilities: { joy: 0.12, sadness: 0.05, anger: 0, surprise: 0.02, anxiety: 0.46, bewilderment: 0.3, disgust: 0, neutral: 0.05 } },
    intensity: { type: "score", score: 1.4, confidence: 0.7, legend: {}, probabilities: { 0: 0.05, 1: 0.55, 2: 0.3, 3: 0.08, 4: 0.02 } },
  },
};
const r = normalizeJevResponse(sample);
assert.equal(r.emotion, "anxiety");
assert.ok(Math.abs(r.intensity - 0.35) < 1e-9);
assert.equal(r.probabilities.bewilderment, 0.3);
assert.equal(r.model, "jev-1.13.0");
assert.equal(r.moment, null); // moment 질문이 없던 응답도 허용
const r2 = normalizeJevResponse({ ...sample, answers: { ...sample.answers, moment: { ...sample.answers.emotion, choice: "sadness" }, momentIntensity: { score: 4 } } });
assert.equal(r2.moment.emotion, "sadness");
assert.equal(r2.moment.intensity, 1);
assert.ok(req.state.latest_fragment !== undefined && req.questions.moment.type === "choice");
assert.throws(() => normalizeJevResponse({ answers: {} }));
console.log("jevClient: all passed");
