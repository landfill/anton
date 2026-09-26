// 표정 변환 엔진: Jev의 (감정 분포 + 강도) → ARKit 52 blendshape 목표값 + 머리 자세 + 안색
// 프리셋은 FACS 액션 유닛을 ARKit 채널로 옮긴 것이다.
import { BLENDSHAPE_NAMES, BS } from "../face/faceRig.js";

const sym = (base, v) => ({ [`${base}Left`]: v, [`${base}Right`]: v });

export const PRESETS = {
  // AU6 + AU12: 광대 올라감 + 입꼬리
  joy: {
    ...sym("mouthSmile", 0.85), ...sym("cheekSquint", 0.6), ...sym("eyeSquint", 0.15),
    ...sym("mouthDimple", 0.3), ...sym("mouthUpperUp", 0.12), browInnerUp: 0.08, jawOpen: 0.05,
  },
  // AU1 + AU4 + AU15 + AU17: 안쪽 눈썹 올림, 입꼬리 내림, 턱 주름
  sadness: {
    browInnerUp: 1.0, ...sym("browDown", 0.3), ...sym("mouthFrown", 1.0), mouthShrugLower: 0.7,
    ...sym("eyeLookDown", 0.4), ...sym("eyeBlink", 0.22), ...sym("mouthPress", 0.25), mouthPucker: 0.12,
    ...sym("mouthStretch", 0.15), mouthRollUpper: 0.1,
  },
  // AU4 + AU5 + AU7 + AU23/24: 눈썹 내림, 노려봄, 입술 압박
  anger: {
    ...sym("browDown", 1.0), ...sym("eyeSquint", 0.55), ...sym("eyeWide", 0.25), ...sym("noseSneer", 0.65),
    ...sym("mouthPress", 0.85), ...sym("mouthFrown", 0.45), ...sym("mouthUpperUp", 0.12), mouthRollLower: 0.3,
    jawForward: 0.35, ...sym("cheekSquint", 0.2),
  },
  // AU1 + AU2 + AU5 + AU26
  surprise: {
    browInnerUp: 0.95, ...sym("browOuterUp", 0.9), ...sym("eyeWide", 0.85), jawOpen: 0.42, mouthFunnel: 0.18,
  },
  // AU1 + AU2 + AU4 + AU5 + AU20: 걱정 — 눈썹 모임 + 올림, 입술 옆으로 당김
  anxiety: {
    browInnerUp: 0.75, ...sym("browOuterUp", 0.2), ...sym("browDown", 0.25), ...sym("eyeWide", 0.35),
    ...sym("mouthStretch", 0.4), ...sym("mouthPress", 0.3), mouthRollLower: 0.12, jawOpen: 0.03,
  },
  // 당혹: 비대칭 눈썹 + 입을 한쪽으로 다묾
  bewilderment: {
    browInnerUp: 0.5, browDownLeft: 0.35, browOuterUpRight: 0.55, eyeSquintLeft: 0.2, eyeWideRight: 0.2,
    mouthLeft: 0.3, ...sym("mouthPress", 0.35), mouthRollLower: 0.2, mouthFrownLeft: 0.2, jawLeft: 0.1,
  },
  // AU9 + AU10: 코 찡그림, 윗입술 올림
  disgust: {
    ...sym("noseSneer", 0.85), ...sym("mouthUpperUp", 0.5), ...sym("browDown", 0.55), ...sym("eyeSquint", 0.5),
    ...sym("cheekSquint", 0.35), ...sym("mouthFrown", 0.35), mouthShrugLower: 0.3,
  },
  neutral: {},
};

// 머리 자세(라디안): pitch>0 숙임, yaw>0 화면 오른쪽, roll>0 시계 방향
const DEG = Math.PI / 180;
export const POSES = {
  joy: { pitch: -1.5 * DEG, yaw: 0, roll: 2 * DEG, ty: 2 },
  sadness: { pitch: 6 * DEG, yaw: -1.5 * DEG, roll: -2 * DEG, ty: -4 },
  anger: { pitch: 4 * DEG, yaw: 0, roll: 0, ty: 2 },
  surprise: { pitch: -3 * DEG, yaw: 0, roll: 0, ty: 4 },
  anxiety: { pitch: 1.5 * DEG, yaw: 1 * DEG, roll: -1 * DEG, ty: -1 },
  bewilderment: { pitch: -0.5 * DEG, yaw: 2.5 * DEG, roll: 4 * DEG, ty: 0 },
  disgust: { pitch: -2 * DEG, yaw: -3.5 * DEG, roll: -1.5 * DEG, ty: 1 },
  neutral: { pitch: 0, yaw: 0, roll: 0, ty: 0 },
};

// 안색: 홍조(곱해지는 색) / 창백함, 깜빡임 빈도 배수
export const PHYSIO = {
  joy: { flush: 0.35, color: [1.07, 0.9, 0.88], pale: 0, blinkRate: 1.0 },
  sadness: { flush: 0.4, color: [1.06, 0.9, 0.9], pale: 0.15, blinkRate: 0.8 },
  anger: { flush: 1.0, color: [1.16, 0.82, 0.78], pale: 0, blinkRate: 0.5 },
  surprise: { flush: 0, color: [1, 1, 1], pale: 0.2, blinkRate: 0.5 },
  anxiety: { flush: 0.05, color: [1, 1, 1], pale: 0.45, blinkRate: 1.9 },
  bewilderment: { flush: 0.5, color: [1.08, 0.88, 0.87], pale: 0, blinkRate: 1.5 },
  disgust: { flush: 0.15, color: [1.02, 0.97, 0.9], pale: 0.2, blinkRate: 1.1 },
  neutral: { flush: 0, color: [1, 1, 1], pale: 0, blinkRate: 1.0 },
};

// 강도 곡선: 약한 감정도 분명히 보이도록 앞부분을 크게 끌어올린다
const curve = (x) => Math.pow(Math.max(0, Math.min(1, x)), 0.55);

export const DEFAULT_EXPRESSIVENESS = 1.5;

/**
 * @param {{probabilities:Record<string,number>, intensity:number}} analysis
 * @param {number} [gain] 표현 강도 배율(1 = 기본 FACS 프리셋 크기)
 * @returns {{weights: Float32Array, pose:{pitch:number,yaw:number,roll:number,ty:number}, physio:{flush:number,color:number[],pale:number,blinkRate:number}}}
 */
export function expressionFromAnalysis(analysis, gain = DEFAULT_EXPRESSIVENESS) {
  const weights = new Float32Array(BLENDSHAPE_NAMES.length);
  const pose = { pitch: 0, yaw: 0, roll: 0, ty: 0 };
  const physio = { flush: 0, color: [0, 0, 0], pale: 0, blinkRate: 0 };
  const probs = analysis?.probabilities || { neutral: 1 };
  const k = curve(analysis?.intensity ?? 0) * gain;

  // 감정 분포 중 의미 있는 성분만 섞는다(중립은 표정을 비우는 쪽)
  const feel = Object.entries(probs).filter(([e, p]) => e !== "neutral" && p > 0.04);
  const pMax = Math.max(0, ...feel.map(([, p]) => p)) || 1;
  // 주 감정은 온전히, 보조 감정은 주 감정 대비 비율로 → 섞여도 표정이 묽어지지 않는다
  const shares = feel.map(([e, p]) => [e, p === pMax ? 1 : 0.85 * Math.pow(p / pMax, 1.5)]);
  const shareSum = shares.reduce((s, [, x]) => s + x, 0) || 1;
  const colorW = { sum: 0 };
  for (const [e, share] of shares) {
    const w = share * k;
    for (const [name, v] of Object.entries(PRESETS[e] || {})) weights[BS[name]] += v * w;
    // 자세·안색은 비중 평균(여러 감정이 겹쳐도 과회전하지 않게)
    const wp = (share / shareSum) * k;
    const ps = POSES[e];
    pose.pitch += ps.pitch * wp; pose.yaw += ps.yaw * wp; pose.roll += ps.roll * wp; pose.ty += ps.ty * wp;
    const ph = PHYSIO[e];
    physio.flush += ph.flush * wp;
    physio.pale += ph.pale * wp;
    for (let c = 0; c < 3; c++) physio.color[c] += ph.color[c] * ph.flush * wp;
    colorW.sum += ph.flush * wp;
    physio.blinkRate += ph.blinkRate * (share / shareSum);
  }
  for (let i = 0; i < weights.length; i++) weights[i] = Math.min(1, weights[i]);
  physio.color = colorW.sum > 0 ? physio.color.map((c) => c / colorW.sum) : [1, 1, 1];
  if (!feel.length) physio.blinkRate = 1;
  physio.flush = Math.min(1, physio.flush);
  physio.pale = Math.min(1, physio.pale);
  return { weights, pose, physio };
}
