// 표정 애니메이터: 목표 blendshape로 스프링 보간 + 살아있는 사람처럼 보이게 하는 미세 움직임
//  - 채널별 임계 감쇠 스프링(눈썹은 빠르게, 입·턱은 조금 느리게)
//  - 자연 깜빡임(감정에 따라 빈도 변화, 가끔 두 번 깜빡임, 인지 이벤트 시 깜빡임)
//  - 시선 도약(saccade), 메시지를 읽는 동안 아래를 보며 훑기
//  - 머리 미세 흔들림, 호흡, 판단이 크게 바뀔 때의 짧은 놀람 반응(startle)
import { BLENDSHAPE_NAMES, BS } from "../face/faceRig.js";

const N = BLENDSHAPE_NAMES.length;
const OMEGA = new Float32Array(BLENDSHAPE_NAMES.map((n) =>
  n.startsWith("brow") ? 11 : n.startsWith("eye") ? 13 : n.startsWith("jaw") ? 7.5 : n.startsWith("cheek") ? 7 : n.startsWith("nose") ? 9 : 8.5,
));
const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// 부드러운 1D 노이즈(무리수 주파수 사인 합)
const noise = (t, s = 0) => (Math.sin(t * 1.0 + s) * 0.5 + Math.sin(t * 2.31 + s * 1.7) * 0.3 + Math.sin(t * 4.13 + s * 2.3) * 0.2);

function spring(x, v, target, omega, dt) {
  const a = omega * omega * (target - x) - 2 * omega * v;
  v += a * dt;
  x += v * dt;
  return [x, v];
}

export class FaceAnimator {
  constructor() {
    this.cur = new Float32Array(N);
    this.vel = new Float32Array(N);
    this.target = new Float32Array(N);
    this.out = new Float32Array(N);
    this.pose = { pitch: 0, yaw: 0, roll: 0, ty: 0 };
    this.poseVel = { pitch: 0, yaw: 0, roll: 0, ty: 0 };
    this.poseTarget = { pitch: 0, yaw: 0, roll: 0, ty: 0 };
    this.physio = { flush: 0, pale: 0, color: [1, 1, 1], blinkRate: 1 };
    this.physioTarget = { flush: 0, pale: 0, color: [1, 1, 1], blinkRate: 1 };
    this.intensity = 0;

    this.time = 0;
    this.nextBlink = 1.2;
    this.blinkT = -1;
    this.pendingDouble = false;

    this.gaze = { x: 0, y: 0, vx: 0, vy: 0 };
    this.gazeTarget = { x: 0, y: 0 };
    this.nextSaccade = 0.8;
    this.reading = false;
    this.readScan = 0;
    this.readAmt = 0;

    this.startle = { t0: -10, amount: 0 };
    this.pending = null; // 인지 지연 후 적용할 목표
  }

  /** 새 판단 결과(표정 목표) */
  setTarget(expr, intensity) {
    // 변화량이 크면 짧은 놀람 반응 + 깜빡임
    let diff = 0;
    for (let i = 0; i < N; i++) diff += Math.abs(expr.weights[i] - this.target[i]);
    if (diff > 1.2) {
      this.startle = { t0: this.time + 0.06, amount: Math.min(1, (diff - 1.2) / 3 + 0.35) };
      if (Math.random() < 0.6) this.nextBlink = Math.min(this.nextBlink, this.time + 0.12);
    }
    // 사람의 반응처럼 아주 짧은 인지 지연(80ms) 후 적용
    this.pending = { at: this.time + 0.08, expr, intensity };
  }

  setReading(on) {
    if (on && !this.reading) this.nextSaccade = this.time; // 즉시 입력창 쪽으로 시선
    this.reading = on;
  }

  _applyPending() {
    const p = this.pending;
    if (!p || this.time < p.at) return;
    this.target.set(p.expr.weights);
    Object.assign(this.poseTarget, p.expr.pose);
    this.physioTarget = { ...p.expr.physio };
    this.intensity = p.intensity;
    this.pending = null;
  }

  _blinkValue(dt) {
    const rate = 1 + (this.physio.blinkRate - 1) * Math.min(1, this.intensity * 1.4);
    if (this.blinkT < 0 && this.time >= this.nextBlink) {
      this.blinkT = 0;
    }
    if (this.blinkT < 0) return 0;
    this.blinkT += dt;
    const close = 0.075, hold = 0.035, open = 0.17;
    const t = this.blinkT;
    let v;
    if (t < close) v = t / close;
    else if (t < close + hold) v = 1;
    else if (t < close + hold + open) { const u = (t - close - hold) / open; v = 1 - u * u * (3 - 2 * u); }
    else {
      this.blinkT = -1;
      if (!this.pendingDouble && Math.random() < 0.15) { this.pendingDouble = true; this.nextBlink = this.time + 0.12; }
      else { this.pendingDouble = false; this.nextBlink = this.time + rand(2.2, 5.8) / rate; }
      return 0;
    }
    return v * v * (3 - 2 * v);
  }

  _updateGaze(dt) {
    if (this.time >= this.nextSaccade) {
      if (this.reading) {
        // 입력창(화면 아래)을 좌→우로 훑는다
        this.readScan = (this.readScan + rand(0.15, 0.3)) % 1;
        this.gazeTarget = { x: -0.35 + this.readScan * 0.7, y: -0.62 + rand(-0.04, 0.04) };
        this.nextSaccade = this.time + rand(0.25, 0.5);
      } else {
        const big = Math.random() < 0.12;
        this.gazeTarget = { x: rand(-1, 1) * (big ? 0.35 : 0.1), y: rand(-1, 1) * (big ? 0.2 : 0.06) };
        this.nextSaccade = this.time + rand(0.7, 2.6);
        if (big && Math.random() < 0.3) this.nextBlink = Math.min(this.nextBlink, this.time + 0.05);
      }
    }
    // 도약은 빠르게(ω 35)
    [this.gaze.x, this.gaze.vx] = spring(this.gaze.x, this.gaze.vx, this.gazeTarget.x, 35, dt);
    [this.gaze.y, this.gaze.vy] = spring(this.gaze.y, this.gaze.vy, this.gazeTarget.y, 35, dt);
  }

  /** @returns {{weights: Float32Array, head: object, physio: object}} */
  update(dt) {
    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    const t = this.time;
    this._applyPending();

    for (let i = 0; i < N; i++) {
      [this.cur[i], this.vel[i]] = spring(this.cur[i], this.vel[i], this.target[i], OMEGA[i], dt);
    }
    for (const k of ["pitch", "yaw", "roll", "ty"]) {
      [this.pose[k], this.poseVel[k]] = spring(this.pose[k], this.poseVel[k], this.poseTarget[k], 4.5, dt);
    }
    const a = 1 - Math.exp(-dt * 3);
    this.physio.flush += (this.physioTarget.flush - this.physio.flush) * a;
    this.physio.pale += (this.physioTarget.pale - this.physio.pale) * a;
    this.physio.blinkRate += (this.physioTarget.blinkRate - this.physio.blinkRate) * a;
    for (let c = 0; c < 3; c++) this.physio.color[c] += (this.physioTarget.color[c] - this.physio.color[c]) * a;

    this.readAmt += ((this.reading ? 1 : 0) - this.readAmt) * (1 - Math.exp(-dt * 4));
    const o = this.out;
    o.set(this.cur);

    // 미세 표정 노이즈(정지된 얼굴 방지)
    o[BS.browInnerUp] += 0.035 * (noise(t * 0.37, 1) + 0.5);
    o[BS.browDownLeft] += 0.02 * (noise(t * 0.29, 5) + 0.5);
    o[BS.browDownRight] += 0.02 * (noise(t * 0.31, 7) + 0.5);
    o[BS.mouthPressLeft] += 0.03 * (noise(t * 0.23, 2) + 0.5);
    o[BS.mouthPressRight] += 0.03 * (noise(t * 0.21, 3) + 0.5);
    o[BS.mouthRollLower] += 0.02 * (noise(t * 0.17, 4) + 0.5);
    o[BS.cheekSquintLeft] += 0.02 * (noise(t * 0.19, 8) + 0.5);
    o[BS.noseSneerLeft] += 0.015 * (noise(t * 0.5, 9) + 0.5);
    o[BS.noseSneerRight] += 0.015 * (noise(t * 0.5, 9) + 0.5);
    // 읽는 중이면 약간 집중(미간)
    const r = this.readAmt;
    o[BS.browDownLeft] += 0.08 * r; o[BS.browDownRight] += 0.08 * r; o[BS.eyeSquintLeft] += 0.06 * r; o[BS.eyeSquintRight] += 0.06 * r;

    // 놀람 반응(startle): 빠르게 올라갔다 천천히 풀림
    const st = t - this.startle.t0;
    if (st > 0 && st < 1.2) {
      const env = Math.min(1, st / 0.07) * Math.exp(-st / 0.35) * this.startle.amount;
      o[BS.browInnerUp] += 0.4 * env;
      o[BS.browOuterUpLeft] += 0.35 * env;
      o[BS.browOuterUpRight] += 0.35 * env;
      o[BS.eyeWideLeft] += 0.4 * env;
      o[BS.eyeWideRight] += 0.4 * env;
      o[BS.jawOpen] += 0.06 * env;
    }

    // 시선
    this._updateGaze(dt);
    const gx = this.gaze.x, gy = this.gaze.y;
    const look = (name, v) => { o[BS[name]] = Math.max(o[BS[name]], clamp01(v)); };
    look("eyeLookInRight", gx); look("eyeLookOutLeft", gx);
    look("eyeLookOutRight", -gx); look("eyeLookInLeft", -gx);
    look("eyeLookUpLeft", gy); look("eyeLookUpRight", gy);
    look("eyeLookDownLeft", -gy); look("eyeLookDownRight", -gy);

    // 깜빡임(감정 표정 위에 곱 합성)
    const b = this._blinkValue(dt);
    for (const s of ["Left", "Right"]) {
      const i = BS[`eyeBlink${s}`];
      o[i] = 1 - (1 - clamp01(o[i])) * (1 - b);
      o[BS[`eyeWide${s}`]] *= 1 - b;
    }
    for (let i = 0; i < N; i++) o[i] = clamp01(o[i]);

    // 머리: 감정 자세 + 미세 흔들림 + 읽을 때 살짝 숙임 + 호흡
    const breath = Math.sin((t / 4.4) * Math.PI * 2);
    const head = {
      pitch: this.pose.pitch + 0.012 * noise(t * 0.33, 11) + 0.035 * this.readAmt + 0.004 * breath,
      yaw: this.pose.yaw + 0.02 * noise(t * 0.21, 13) + gx * 0.02,
      roll: this.pose.roll + 0.012 * noise(t * 0.17, 17),
      tx: 0,
      ty: this.pose.ty,
      breath: 1.4 * breath,
    };
    // 사진 기반 2.5D 메시라 큰 회전은 목·머리카락 경계가 늘어난다 → 총 각도 제한
    const lim = (x, m) => Math.max(-m, Math.min(m, x));
    head.pitch = lim(head.pitch, 7 * Math.PI / 180);
    head.yaw = lim(head.yaw, 5 * Math.PI / 180);
    head.roll = lim(head.roll, 5 * Math.PI / 180);
    return { weights: o, head, physio: this.physio };
  }
}
