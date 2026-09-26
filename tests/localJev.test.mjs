// node tests/localJev.test.mjs
import assert from "node:assert/strict";
import { analyzeLocal, focusSegment, EMOTION_LABELS } from "../src/jev/localJev.js";

const top = (r, k = 3) => Object.entries(r.probabilities).filter(([e]) => e !== "neutral").sort((a, b) => b[1] - a[1]).slice(0, k).map(([e]) => e);
const show = (t, r) => console.log(`${JSON.stringify(t).padEnd(34)} → ${EMOTION_LABELS[r.emotion]} ${r.intensity.toFixed(2)} | top: ${top(r).map((e) => `${EMOTION_LABELS[e]} ${r.probabilities[e].toFixed(2)}`).join(", ")}`);

let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); } };

// ── 요구사항 예시 ──
const a = analyzeLocal("고마워");
const b = analyzeLocal("고마워...");
const c = analyzeLocal("고마워. 다시는 연락하지 마.");
show("고마워", a); show("고마워...", b); show("고마워. 다시는 연락하지 마.", c);

test('"고마워" → 기쁨', () => assert.equal(a.emotion, "joy"));
test('"고마워..." → 불안/당황, 기쁨 억제, 미묘한 강도', () => {
  assert.ok(["anxiety", "bewilderment"].includes(b.emotion), b.emotion);
  assert.ok(b.probabilities.joy < b.probabilities.anxiety);
  assert.ok(b.intensity < a.intensity && b.intensity < 0.5, String(b.intensity));
});
test('"고마워. 다시는 연락하지 마." → 놀람·슬픔·당혹이 상위 3개', () => {
  assert.deepEqual(new Set(top(c)), new Set(["surprise", "sadness", "bewilderment"]));
  assert.ok(c.probabilities.joy < 0.1);
});

// ── 한 글자씩 입력(IME 조합 중간 상태 포함) ──
test("조합 중간 문자열에서도 예외 없이 결과를 낸다", () => {
  for (const s of ["ㄱ", "고", "곰", "고마", "고맙", "고마ㅇ", "고마워.", "고마워. ㄷ", "고마워. 다시", "고마워. 다시는 연락하지"]) {
    const r = analyzeLocal(s);
    assert.ok(r.emotion && r.intensity >= 0 && r.intensity <= 1, s);
  }
  assert.equal(analyzeLocal("").emotion, "neutral");
});

// ── 추가 동작 ──
const cases = ["고마워!!!", "안 고마워", "알겠어.", "우리 얘기 좀 해", "헐 대박 합격했어!!", "짜증나 진짜", "ㅋㅋㅋㅋ 너무 웃겨", "미안해 ㅠㅠ", "뭐야 이게??"];
for (const t of cases) show(t, analyzeLocal(t));
test('"고마워!!!"는 "고마워"보다 강하다', () => assert.ok(analyzeLocal("고마워!!!").intensity > a.intensity));
test('"안 고마워"는 기쁨이 아니다', () => assert.notEqual(analyzeLocal("안 고마워").emotion, "joy"));
test('"우리 얘기 좀 해" → 불안', () => assert.equal(analyzeLocal("우리 얘기 좀 해").emotion, "anxiety"));
test('"짜증나 진짜" → 분노', () => assert.equal(analyzeLocal("짜증나 진짜").emotion, "anger"));

// ── 좋았다 나빴다 헷갈리게 하는 문장: "지금 읽는 부분" 반응이 그때그때 뒤집힌다 ──
test("실시간 반응이 긍정↔부정 반전을 따라간다", () => {
  const seq = [
    ["너는 아주 사랑스러", "joy"],
    ["너는 아주 사랑스러....럽지 않은", "sadness"],
    ["너는 아주 사랑스러....럽지 않은 인상이지만 너를 좋아하", "joy"],
    ["너는 아주 사랑스러....럽지 않은 인상이지만 너를 좋아하... 지도 않아..", "sadness"],
  ];
  for (const [s, want] of seq) assert.equal(analyzeLocal(focusSegment(s)).emotion, want, s);
});
test('"고마워 안녕"의 "안"은 부정으로 보지 않는다', () => assert.equal(analyzeLocal("고마워 안녕").emotion, "joy"));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
