// 로컬 Jev 시뮬레이터
// TypeSafe AI Jev API 키가 없을 때 쓰는 오프라인 대체 엔진이다(실제 Jev 모델 아님).
// 같은 질문(수신자가 느낄 감정 choice + 강도 score)에 대해 규칙 기반으로 답하고,
// 판단 근거(cues)를 함께 돌려준다. 브라우저·Node 양쪽에서 동작하는 순수 모듈.

export const EMOTIONS = ["joy", "sadness", "anger", "surprise", "anxiety", "bewilderment", "disgust", "neutral"];
export const EMOTION_LABELS = {
  joy: "기쁨", sadness: "슬픔", anger: "분노", surprise: "놀람",
  anxiety: "불안", bewilderment: "당혹", disgust: "혐오", neutral: "중립",
};
const FEEL = ["joy", "sadness", "anger", "surprise", "anxiety", "bewilderment", "disgust"];
const zero = () => Object.fromEntries(FEEL.map((e) => [e, 0]));

// [정규식, 감정 가중치, 근거 라벨]
const LEXICON = [
  // 관계 단절·거절 — 수신자는 슬픔 + 당혹 + 놀람
  [/다시는|연락\s*(하지|좀\s*하지|말아|마)|연락\s*끊|차단\s*(할|했|한다)|보지\s*말자|헤어지자|그만\s*만나|끝내자|우리\s*끝|잊어\s*줘|상관\s*(하지\s*)?마|신경\s*(꺼|쓰지\s*마)|필요\s*없어|너랑\s*(안|끝)/,
    { sadness: 0.85, bewilderment: 0.4, surprise: 0.25, anger: 0.1 }, "관계 단절·거절"],
  [/고마워|고맙|감사|땡큐|thank/i, { joy: 0.8 }, "감사 표현"],
  [/사랑해|사랑한다|사랑스러|사랑스럽|사랑스런|좋아해|좋아하|보고\s*싶/, { joy: 0.9 }, "애정 표현"],
  [/축하|합격|성공|이겼|우승|승진/, { joy: 0.85, surprise: 0.1 }, "축하·좋은 소식"],
  [/최고|대단|멋지|멋있|잘했|수고|고생\s*했|덕분|응원|힘내|파이팅|화이팅|칭찬/, { joy: 0.65 }, "칭찬·격려"],
  [/좋아|좋다|좋은|행복|기뻐|기쁘|반가|신나|설레|재밌|웃기|예쁘|이쁘|귀엽/, { joy: 0.6 }, "긍정 어휘"],
  [/미안|죄송|잘못했/, { sadness: 0.35, anxiety: 0.2, bewilderment: 0.1 }, "사과"],
  // 약속·만남 거절: "나 안 가", "못 만나", "안 올래"
  [/(^|\s)(안|못)\s*(가|갈|와|올|만나|봐|볼)(\s|$|[.!?~]|래|거|게|요)/, { sadness: 0.6, bewilderment: 0.25, anger: 0.1 }, "거절·불참"],
  [/슬퍼|슬프|우울|외로|서운|섭섭|속상|눈물|울고|울었|그리워|이별|떠나|돌아가셨|장례|포기|힘들|지쳤|아파|아프/, { sadness: 0.75 }, "슬픔 어휘"],
  [/짜증|화나|화났|열받|빡치|어이없|꺼져|닥쳐|미쳤|죽을래|뭐하냐|왜\s*그래|그만\s*해|한심|최악|실망|바보|멍청|ㅅㅂ|씨발|시발|병신/, { anger: 0.8, sadness: 0.1 }, "공격·비난"],
  [/역겨|더러|토나|극혐|징그|혐오|구역질|질려|싫어|싫다/, { disgust: 0.7, anger: 0.2 }, "혐오·거부"],
  [/헐|대박|설마|갑자기|깜짝|놀랐|놀라|믿기지|말도\s*안|웬일|어머|세상에/, { surprise: 0.7 }, "놀람 어휘"],
  [/걱정|불안|무서|두려|큰일|급해|급하|사고|병원|응급|어떡|어쩌지/, { anxiety: 0.75, surprise: 0.1 }, "위기·걱정"],
  [/할\s*말\s*(이\s*)?있|얘기\s*좀|이야기\s*좀|시간\s*(돼|되니|있어)|잠깐\s*통화|전화\s*(좀\s*)?(해|줘)|연락\s*줘|나중에\s*얘기/, { anxiety: 0.6, bewilderment: 0.15 }, "\"할 말 있어\"류 예고"],
  [/뭐지|뭐야|무슨\s*(말|소리)|이해가\s*안|황당|당황|어리둥절|갑분/, { bewilderment: 0.65, surprise: 0.15 }, "혼란 어휘"],
];
const INTENSIFIER = /너무|진짜|정말|완전|엄청|겁나|존나|아주|매우|진심|레알|개(?=[가-힣])/g;
// 긍정 어휘 "뒤"에 오는 부정(말줄임표로 끊겨도 이어서 본다): "사랑스러....럽지 않은", "좋아하... 지도 않아"
const NEG_AFTER = /^[가-힣\s]{0,7}?(않|아니|없|못\s?하|못\s)/;
// 긍정 어휘 "앞"의 부정: "안 고마워", "못 좋아해"
const NEG_BEFORE = /(^|[\s])(안|못)\s*$/;
const CURT = /^(응|ㅇㅇ|ㅇ|그래|그러던가|알겠어|알았어|알겠다|됐어|됐다|ㅇㅋ|네|넵|그렇구나)$/;

const EMOJI = [
  [/[😊😄😁😆😍🥰😘❤♥💕💖👍🎉🥳]|\^\^|\^_\^/u, { joy: 0.6 }, "긍정 이모티콘"],
  [/[😢😭💔🥺]/u, { sadness: 0.6 }, "슬픈 이모티콘"],
  [/[😡🤬👿]/u, { anger: 0.7 }, "화난 이모티콘"],
  [/[😱😨😰]/u, { anxiety: 0.5, surprise: 0.4 }, "놀란 이모티콘"],
  [/[😮😲🤯]/u, { surprise: 0.6 }, "놀람 이모티콘"],
  [/[🤢🤮🙄]/u, { disgust: 0.6 }, "불쾌 이모티콘"],
  [/[🤔😅💦]/u, { bewilderment: 0.45 }, "난처한 이모티콘"],
];

const valence = (v) => v.joy - (v.sadness + v.anger + v.disgust + 0.7 * v.anxiety);
const addInto = (v, w, k = 1) => { for (const [e, x] of Object.entries(w)) v[e] += x * k; };

function analyzeClause(body, punct, cues, isNegatedAt = () => false, offset = 0) {
  const v = zero();
  const lead = body.length - body.trimStart().length;
  const text = body.trim();

  for (const [re, w, label] of LEXICON) {
    const m = re.exec(text);
    if (!m) continue;
    if (w.joy && isNegatedAt(offset + lead + m.index)) {
      // 좋다가 부정으로 뒤집힘 → 기대가 꺾이는 충격: 슬픔 + 놀람 + 당혹
      addInto(v, { sadness: 0.5 * w.joy, surprise: 0.4 * w.joy, bewilderment: 0.35 * w.joy, anger: 0.2 * w.joy, joy: 0.1 * w.joy });
      cues.push({ text: m[0], label: "긍정을 부정으로 뒤집음", emotion: "sadness" });
      continue;
    }
    addInto(v, w);
    cues.push({ text: m[0], label, emotion: topOf(w) });
  }
  for (const [re, w, label] of EMOJI) {
    const m = (text + punct).match(re);
    if (m) { addInto(v, w); cues.push({ text: m[0], label, emotion: topOf(w) }); }
  }

  // 한글 자모 표현
  const laugh = text.match(/[ㅋㅎ]{2,}/);
  if (laugh) { v.joy += Math.min(0.7, 0.2 + laugh[0].length * 0.08); cues.push({ text: laugh[0], label: "웃음", emotion: "joy" }); }
  const cry = text.match(/[ㅠㅜ]{1,}/);
  if (cry) { v.sadness += Math.min(0.8, 0.35 + cry[0].length * 0.1); cues.push({ text: cry[0], label: "울음", emotion: "sadness" }); }
  const sweat = (text + punct).match(/;{2,}/);
  if (sweat) { v.bewilderment += 0.5; cues.push({ text: sweat[0], label: "진땀", emotion: "bewilderment" }); }
  const flat = text.match(/ㅡㅡ|-_-|－－/);
  if (flat) { v.anger += 0.45; v.disgust += 0.2; cues.push({ text: flat[0], label: "언짢은 표정", emotion: "anger" }); }

  // 강조어
  const intens = text.match(INTENSIFIER);
  if (intens) {
    const k = 1 + Math.min(2, intens.length) * 0.25;
    for (const e of FEEL) v[e] *= k;
    cues.push({ text: intens[0], label: "강조", emotion: null });
  }

  // 차가운 단답
  if (CURT.test(text) && (punct.includes(".") || punct === "")) {
    const cold = punct.includes(".");
    v.anxiety += cold ? 0.3 : 0.12;
    v.sadness += cold ? 0.2 : 0.05;
    cues.push({ text: text + punct, label: cold ? "마침표 찍힌 단답" : "단답", emotion: "anxiety" });
  }

  // 문장부호
  const ellipsis = /\.{2,}|…/.test(punct);
  const bangs = (punct.match(/!/g) || []).length;
  const qs = (punct.match(/\?/g) || []).length;
  if (ellipsis) {
    // 말끝을 흐림: 긍정은 불안·당황으로 번지고, 전체 강도는 가라앉는다
    const j = v.joy * 0.75;
    v.joy -= j;
    v.anxiety += j * 0.55 + 0.18;
    v.bewilderment += j * 0.45 + 0.08;
    v.sadness += 0.08;
    for (const e of FEEL) v[e] *= 0.6;
    cues.push({ text: punct.match(/\.{2,}|…/)[0], label: "말줄임(여운·망설임)", emotion: "anxiety" });
  }
  if (bangs) {
    const k = 1 + Math.min(3, bangs) * 0.22;
    for (const e of FEEL) v[e] *= k;
    if (sum(v) < 0.15) v.surprise += 0.25;
    cues.push({ text: "!".repeat(bangs), label: "느낌표(강조)", emotion: null });
  }
  if (qs) {
    v.bewilderment += qs >= 2 ? 0.35 : 0.1;
    v.surprise += qs >= 2 ? 0.25 : 0.05;
    if (qs >= 2) cues.push({ text: "?".repeat(qs), label: "연속 물음표", emotion: "bewilderment" });
  }
  if (/~+$/.test(punct) || /~$/.test(text)) {
    v.joy += 0.12;
    cues.push({ text: "~", label: "부드러운 어미", emotion: "joy" });
  }
  return v;
}

function topOf(w) {
  return Object.entries(w).sort((a, b) => b[1] - a[1])[0][0];
}
const sum = (v) => FEEL.reduce((s, e) => s + v[e], 0);

/**
 * 수신자가 느낄 감정과 강도를 판단한다.
 * @param {string} message
 * @returns {{emotion:string, intensity:number, confidence:number, probabilities:Record<string,number>, cues:Array, source:string}}
 */
export function analyzeLocal(message) {
  const text = (message || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return { emotion: "neutral", intensity: 0, confidence: 1, probabilities: { ...Object.fromEntries(EMOTIONS.map((e) => [e, 0])), neutral: 1 }, cues: [], source: "local" };
  }

  // 문장 단위로 나눈다(문장부호 포함)
  const clauses = [];
  const re = /([^.!?…~\n]+)([.!?…~\n]*)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1].trim() || m[2]) clauses.push({ body: m[1], punct: m[2].replace(/\n/g, ""), offset: m.index });
  }
  if (!clauses.length) clauses.push({ body: "", punct: text, offset: 0 });

  // 부정 범위는 문장 전체에서 찾는다(말줄임표로 단어가 끊겨도 이어서 판단)
  const negated = new Set();
  for (const [lexRe, w] of LEXICON) {
    if (!w.joy) continue;
    const g = new RegExp(lexRe.source, lexRe.flags.includes("g") ? lexRe.flags : lexRe.flags + "g");
    let mm;
    while ((mm = g.exec(text))) {
      const after = text.slice(mm.index + mm[0].length, mm.index + mm[0].length + 16).replace(/[.…~]+/g, "");
      if (NEG_AFTER.test(after) || NEG_BEFORE.test(text.slice(Math.max(0, mm.index - 4), mm.index))) negated.add(mm.index);
    }
  }
  const isNegatedAt = (i) => negated.has(i);

  const cues = [];
  const vecs = clauses.map((c) => analyzeClause(c.body, c.punct, cues, isNegatedAt, c.offset));
  const n = vecs.length;
  const total = zero();
  vecs.forEach((v, i) => addInto(total, v, 0.55 + 0.45 * ((i + 1) / n))); // 최근 문장일수록 무게

  // 앞은 긍정인데 뒤가 부정으로 뒤집히면: 기대가 깨지는 놀람 + 당혹, 앞의 긍정은 무의미해진다
  let bestPos = 0;
  for (let i = 0; i < n; i++) {
    const val = valence(vecs[i]);
    if (val < -0.3 && bestPos > 0.3) {
      const mag = Math.min(bestPos, -val);
      total.surprise += 0.5 * mag;
      total.bewilderment += 0.45 * mag;
      total.joy *= 0.2;
      cues.push({ text: "앞뒤 문장", label: "감정 반전(기대 붕괴)", emotion: "surprise" });
      break;
    }
    bestPos = Math.max(bestPos, val);
  }

  for (const e of FEEL) total[e] = Math.max(0, total[e]);
  const s = sum(total);
  const max = Math.max(...FEEL.map((e) => total[e]));
  const neutralMass = 0.28;
  const probabilities = {};
  for (const e of FEEL) probabilities[e] = total[e] / (s + neutralMass);
  probabilities.neutral = neutralMass / (s + neutralMass);

  const emotion = EMOTIONS.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a), "neutral");
  const intensity = s === 0 ? 0 : Math.min(1, 1 - Math.exp(-1.5 * (max + 0.3 * (s - max))));
  const sorted = Object.values(probabilities).sort((a, b) => b - a);
  const confidence = Math.min(0.99, 0.35 + (sorted[0] - sorted[1]) * 1.2);

  return { emotion, intensity: +intensity.toFixed(3), confidence: +confidence.toFixed(3), probabilities, cues, source: "local" };
}

/**
 * 지금 읽고 있는 "마지막 생각 단위"를 잘라낸다.
 * 경계: 문장 끝(. ! ? — 말줄임표는 경계가 아니라 머뭇거림), 대조 접속(지만/는데/근데/그런데/하지만).
 * 마지막 조각에 아직 글자가 없으면(방금 "지만"까지 쳤을 때) 바로 앞 조각을 쓴다.
 */
export function focusSegment(message) {
  const text = message || "";
  const bounds = [0];
  const re = /(?:(?<![.])[.](?![.])|[!?]+)\s+|(?:지만|는데|근데|그런데|하지만)[,\s]+/g;
  let m;
  while ((m = re.exec(text))) bounds.push(m.index + m[0].length);
  const hasWord = (s) => /[가-힣A-Za-zㄱ-ㅎㅏ-ㅣ0-9]|\p{Extended_Pictographic}/u.test(s);
  for (let k = bounds.length - 1; k >= 0; k--) {
    const piece = text.slice(bounds[k], bounds[k + 1] ?? text.length);
    if (hasWord(piece)) return text.slice(bounds[k]).slice(-60);
  }
  return text.slice(-60);
}
