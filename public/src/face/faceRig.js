// 얼굴 리그: 사진 + MediaPipe 랜드마크(478점)로부터 표정 가능한 2.5D 얼굴 메시와
// ARKit 규격 52개 blendshape(모프 타깃 델타)를 만든다.
//
// 구성
//  - 스킨 메시: MediaPipe 캐노니컬 테셀레이션(얼굴) + 얼굴 윤곽 바깥(머리카락·목·옷)의 Delaunay 격자.
//    눈과 입 안쪽 삼각형은 제거해 "구멍"으로 만든다.
//  - 눈 내부 메시: 원본 눈(흰자·홍채) 픽셀을 담은 별도 레이어. 표정 델타가 없어서
//    눈꺼풀(스킨)이 그 위로 미끄러져 내려오며 깜빡임이 된다.
//  - 입 내부 메시: 안쪽 입술 루프를 채우는 부채꼴. 입이 벌어지면 구강(치아·혀)이 보인다.
//
// 좌표: 이미지 픽셀(x 오른쪽, y 아래쪽, z 카메라 쪽 +). 델타는 U(두 홍채 사이 거리) 단위로 설계한다.
// "Left/Right"는 ARKit과 동일하게 인물 기준이다. 정면 사진에서 인물의 오른쪽 = 이미지 왼쪽.
import Delaunator from "https://cdn.jsdelivr.net/npm/delaunator@5.0.1/+esm";

export const BLENDSHAPE_NAMES = [
  "eyeBlinkLeft", "eyeLookDownLeft", "eyeLookInLeft", "eyeLookOutLeft", "eyeLookUpLeft", "eyeSquintLeft", "eyeWideLeft",
  "eyeBlinkRight", "eyeLookDownRight", "eyeLookInRight", "eyeLookOutRight", "eyeLookUpRight", "eyeSquintRight", "eyeWideRight",
  "jawForward", "jawLeft", "jawRight", "jawOpen",
  "mouthClose", "mouthFunnel", "mouthPucker", "mouthLeft", "mouthRight",
  "mouthSmileLeft", "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight",
  "mouthDimpleLeft", "mouthDimpleRight", "mouthStretchLeft", "mouthStretchRight",
  "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper",
  "mouthPressLeft", "mouthPressRight", "mouthLowerDownLeft", "mouthLowerDownRight",
  "mouthUpperUpLeft", "mouthUpperUpRight",
  "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
  "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
  "noseSneerLeft", "noseSneerRight",
  "tongueOut",
];
export const BS = Object.fromEntries(BLENDSHAPE_NAMES.map((n, i) => [n, i]));

// MediaPipe Face Mesh 인덱스
const IDX = {
  oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  eye: {
    // 인물 오른눈(이미지 왼쪽)
    Right: {
      upper: [33, 246, 161, 160, 159, 158, 157, 173, 133],
      lower: [33, 7, 163, 144, 145, 153, 154, 155, 133],
      iris: 468, browCenter: 105, browInner: 107, browOuter: 70,
    },
    // 인물 왼눈(이미지 오른쪽)
    Left: {
      upper: [263, 466, 388, 387, 386, 385, 384, 398, 362],
      lower: [263, 249, 390, 373, 374, 380, 381, 382, 362],
      iris: 473, browCenter: 334, browInner: 336, browOuter: 300,
    },
  },
  lipUpperInner: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308],
  lipLowerInner: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308],
  mouthCorner: { Right: 61, Left: 291 },
  alar: { Right: 64, Left: 294 },
  cheek: { Right: 205, Left: 425 },
  chin: 152, earR: 234, earL: 454,
};
const SIDES = ["Left", "Right"];

// ── 수학 유틸 ──────────────────────────────────────────────
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const gauss = (dx, dy, rx, ry) => Math.exp(-((dx / rx) ** 2 + (dy / ry) ** 2));

function polylineByX(P, idxs) {
  return idxs.map((i) => [P[i][0], P[i][1]]).sort((a, b) => a[0] - b[0]);
}
function interpY(pl, x) {
  if (x <= pl[0][0]) return pl[0][1];
  for (let k = 1; k < pl.length; k++) {
    if (x <= pl[k][0]) {
      const [x0, y0] = pl[k - 1], [x1, y1] = pl[k];
      return y0 + ((y1 - y0) * (x - x0)) / Math.max(1e-6, x1 - x0);
    }
  }
  return pl[pl.length - 1][1];
}
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToPoly(x, y, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const vx = bx - ax, vy = by - ay;
    const t = clamp(((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1), 0, 1);
    best = Math.min(best, Math.hypot(x - (ax + t * vx), y - (ay + t * vy)));
  }
  return best;
}

/**
 * @param {{width:number,height:number,points:number[][]}} model  bake된 랜드마크
 * @param {number[][]} tesselation MediaPipe 캐노니컬 삼각형(0-based)
 */
export function buildFaceRig(model, tesselation) {
  const { width: W, height: H } = model;
  const P = model.points;
  const U = Math.hypot(P[468][0] - P[473][0], P[468][1] - P[473][1]);

  // ── 앵커 ────────────────────────────────────────────────
  const eyes = {};
  for (const s of SIDES) {
    const e = IDX.eye[s];
    const upper = polylineByX(P, e.upper), lower = polylineByX(P, e.lower);
    const xMin = upper[0][0], xMax = upper[upper.length - 1][0];
    let gapMax = 0;
    for (let k = 0; k <= 20; k++) {
      const x = xMin + ((xMax - xMin) * k) / 20;
      gapMax = Math.max(gapMax, interpY(lower, x) - interpY(upper, x));
    }
    eyes[s] = {
      ...e, upperPL: upper, lowerPL: lower, xMin, xMax, gapMax,
      upperSet: new Set(e.upper), lowerSet: new Set(e.lower),
      c: P[e.iris],
    };
  }
  const upperInnerSet = new Set(IDX.lipUpperInner), lowerInnerSet = new Set(IDX.lipLowerInner);
  const mc = [(P[13][0] + P[14][0]) / 2, (P[13][1] + P[14][1]) / 2];
  const corner = { Right: P[IDX.mouthCorner.Right], Left: P[IDX.mouthCorner.Left] };
  const hw = Math.abs(corner.Left[0] - corner.Right[0]) / 2;
  const seamPL = polylineByX(P, IDX.lipUpperInner);
  const chinY = P[IDX.chin][1];
  const pivotY = (P[IDX.earR][1] + P[IDX.earL][1]) / 2;
  const oval = IDX.oval.map((i) => [P[i][0], P[i][1]]);
  const faceCx = P[168][0];
  // 사진마다 얼굴 크기가 다르므로 픽셀 상수는 눈 사이 거리(U)에 비례시킨다(기준: 첫 모델 U≈151px)
  const k = U / 151.4;
  const headCy = P[10][1] + 0.92 * U; // 머리(머리카락 포함) 중심 높이

  // ── 정점 ────────────────────────────────────────────────
  const verts = []; // {x,y,z,u,v,head,lm}
  const headWeightAt = (x, y) => {
    const d = Math.hypot((x - faceCx) / (280 * k), (y - headCy) / (340 * k));
    return (1 - smoothstep(0.9, 1.15, d)) * (1 - smoothstep(chinY + 15 * k, chinY + 130 * k, y));
  };
  const outerZ = (x, y, head) => {
    const e = 1 - ((x - faceCx) / (300 * k)) ** 2 - ((y - headCy) / (360 * k)) ** 2;
    const zEll = (-170 + 200 * Math.sqrt(Math.max(0, e))) * k;
    return -220 * k + (zEll + 220 * k) * head;
  };
  const pushVert = (x, y, z, head, extra = {}) => {
    verts.push({ x, y, z, u: x / W, v: 1 - y / H, head, ...extra });
    return verts.length - 1;
  };

  for (let i = 0; i < P.length; i++) pushVert(P[i][0], P[i][1], P[i][2], headWeightAt(P[i][0], P[i][1]) || 1, { lm: i });
  for (const i of IDX.oval) verts[i].head = headWeightAt(P[i][0], P[i][1]);

  // 얼굴 바깥 격자: 머리 주변은 촘촘히, 나머지는 성기게
  const gridPts = [];
  const addGrid = (x, y) => {
    if (pointInPoly(x, y, oval) || distToPoly(x, y, oval) < 12 * k) return;
    if (gridPts.some(([gx, gy]) => Math.abs(gx - x) < 8 * k && Math.abs(gy - y) < 8 * k)) return;
    gridPts.push([x, y]);
  };
  const dense = { x0: faceCx - 360 * k, x1: faceCx + 360 * k, y0: 0, y1: Math.min(H, chinY + 220 * k) };
  const fine = 34 * k, coarse = 85 * k;
  for (let y = dense.y0; y <= dense.y1; y += fine) for (let x = dense.x0; x <= dense.x1; x += fine) addGrid(x, y);
  for (let y = 0; y <= H; y += coarse) for (let x = 0; x <= W; x += coarse) {
    if (x > dense.x0 && x < dense.x1 && y < dense.y1) continue;
    addGrid(x, y);
  }
  for (let x = 0; x <= W; x += coarse) { addGrid(x, H); }
  for (let y = 0; y <= H; y += coarse) { addGrid(W, y); addGrid(0, y); }
  addGrid(W, H); addGrid(W, 0); addGrid(0, H);

  const gridBase = verts.length;
  for (const [x, y] of gridPts) {
    const head = headWeightAt(x, y);
    pushVert(x, y, outerZ(x, y, head), head);
  }

  // ── 스킨 삼각형 ─────────────────────────────────────────
  const holeSets = [new Set([...upperInnerSet, ...lowerInnerSet]),
    new Set([...eyes.Right.upperSet, ...eyes.Right.lowerSet]), new Set([...eyes.Left.upperSet, ...eyes.Left.lowerSet])];
  const skin = [];
  for (const t of tesselation) {
    if (holeSets.some((s) => t.every((v) => s.has(v)))) continue; // 눈·입 안쪽은 구멍
    skin.push(...t);
  }
  // 윤곽 + 격자 Delaunay, 얼굴 안쪽(테셀레이션이 덮는 영역)은 제외
  const outerIds = [...IDX.oval, ...gridPts.map((_, k) => gridBase + k)];
  const coords = outerIds.flatMap((id) => [verts[id].x, verts[id].y]);
  const del = new Delaunator(coords);
  for (let k = 0; k < del.triangles.length; k += 3) {
    const a = outerIds[del.triangles[k]], b = outerIds[del.triangles[k + 1]], c = outerIds[del.triangles[k + 2]];
    const cx = (verts[a].x + verts[b].x + verts[c].x) / 3, cy = (verts[a].y + verts[b].y + verts[c].y) / 3;
    if (pointInPoly(cx, cy, oval)) continue;
    skin.push(a, b, c);
  }

  // ── 눈 내부 레이어 ───────────────────────────────────────
  // 윤곽 링(uv = 원래 위치) + 바깥 확장 링(uv는 안쪽으로 접어서 눈꺼풀이 올라가도 흰자 톤이 보이게)
  const eyeTris = [];
  const eyeInfo = {};
  for (const s of SIDES) {
    const e = eyes[s];
    const loop = [...e.upper, ...e.lower.slice(1, -1).reverse()];
    const [cx, cy] = [(e.xMin + e.xMax) / 2, (interpY(e.upperPL, (e.xMin + e.xMax) / 2) + interpY(e.lowerPL, (e.xMin + e.xMax) / 2)) / 2];
    const zc = Math.min(...loop.map((i) => P[i][2])) - 4;
    const center = pushVert(cx, cy, zc, 1, { eye: s });
    const ring = loop.map((i) => pushVert(P[i][0], P[i][1], zc, 1, { eye: s }));
    const outer = loop.map((i) => {
      const dx = P[i][0] - cx, dy = P[i][1] - cy;
      const id = pushVert(cx + dx * 1.35, cy + dy * 2.6, zc, 1, { eye: s });
      verts[id].u = (cx + dx * 0.85) / W;
      verts[id].v = 1 - (cy + dy * 0.55) / H;
      return id;
    });
    for (let k = 0; k < loop.length; k++) {
      const n = (k + 1) % loop.length;
      eyeTris.push(center, ring[k], ring[n]);
      eyeTris.push(ring[k], outer[k], outer[n], ring[k], outer[n], ring[n]);
    }
    eyeInfo[s] = { irisUV: [P[e.iris][0] / W, 1 - P[e.iris][1] / H], irisRadiusPx: Math.hypot(P[e.iris + 1][0] - P[e.iris + 3][0], P[e.iris + 1][1] - P[e.iris + 3][1]) / 2 };
  }

  // ── 입 내부(구강) ────────────────────────────────────────
  const mouthLoop = [...IDX.lipUpperInner, ...IDX.lipLowerInner.slice(1, -1).reverse()];
  const mouthCenter = pushVert(mc[0], mc[1], (P[13][2] + P[14][2]) / 2 - 6, 1);
  const mouthTris = [];
  for (let k = 0; k < mouthLoop.length; k++) mouthTris.push(mouthCenter, mouthLoop[k], mouthLoop[(k + 1) % mouthLoop.length]);

  const n = verts.length;
  // 입 좌표(가로 -1..1, 윗입술 0 → 아랫입술 1): 구강 셰이더용
  const aMouth = new Float32Array(n * 2);
  for (const i of IDX.lipUpperInner) { aMouth[i * 2] = (P[i][0] - mc[0]) / hw; aMouth[i * 2 + 1] = 0; }
  for (const i of IDX.lipLowerInner) { aMouth[i * 2] = (P[i][0] - mc[0]) / hw; aMouth[i * 2 + 1] = 1; }
  for (const i of [78, 308]) aMouth[i * 2 + 1] = 0.5;
  aMouth[mouthCenter * 2 + 1] = 0.5;

  // 볼 홍조 마스크
  const aCheek = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    if (v.eye) continue;
    aCheek[i] = Math.max(
      gauss(v.x - P[IDX.cheek.Right][0] + 0.05 * U, v.y - P[IDX.cheek.Right][1] + 0.25 * U, 0.42 * U, 0.34 * U),
      gauss(v.x - P[IDX.cheek.Left][0] - 0.05 * U, v.y - P[IDX.cheek.Left][1] + 0.25 * U, 0.42 * U, 0.34 * U),
      0.45 * gauss(v.x - P[1][0], v.y - P[1][1], 0.2 * U, 0.3 * U),
    );
  }

  // ── Blendshape 델타 ─────────────────────────────────────
  const deltas = BLENDSHAPE_NAMES.map(() => new Float32Array(n * 3));
  const add = (name, i, dx, dy, dz = 0) => {
    const d = deltas[BS[name]];
    d[i * 3] += dx; d[i * 3 + 1] += dy; d[i * 3 + 2] += dz;
  };

  for (let i = 0; i < n; i++) {
    const v = verts[i];
    if (v.eye || i === mouthCenter) continue; // 눈 내부 레이어는 표정으로 변형하지 않는다
    if (i >= 468 && i < 478) continue; // 홍채 점은 스킨에 쓰지 않음
    const { x, y } = v;
    const lm = v.lm ?? -1;
    const inOval = pointInPoly(x, y, oval);
    const dOval = inOval ? 0 : distToPoly(x, y, oval);

    // ── 눈 / 눈꺼풀 ──
    for (const s of SIDES) {
      const e = eyes[s];
      const upY = interpY(e.upperPL, x), loY = interpY(e.lowerPL, x);
      const gap = x > e.xMin && x < e.xMax ? Math.max(0, loY - upY) : 0;
      const onUpper = e.upperSet.has(lm), onLower = e.lowerSet.has(lm);
      const above = !onUpper && !onLower && y < upY ? upY - y : -1;
      const below = !onUpper && !onLower && y > loY ? y - loY : -1;
      const fUp = (sigma) => (onUpper ? 1 : above >= 0 ? 0.85 * Math.exp(-((above / (sigma * U)) ** 2)) : 0);
      const fLo = (sigma) => (onLower ? 1 : below >= 0 ? 0.85 * Math.exp(-((below / (sigma * U)) ** 2)) : 0);

      // 깜빡임: 윗눈꺼풀이 아랫눈꺼풀까지 내려온다
      add(`eyeBlink${s}`, i, 0, 0.93 * gap * fUp(0.075) - 0.07 * gap * fLo(0.06));
      // 크게 뜨기
      add(`eyeWide${s}`, i, 0, -0.42 * gap * fUp(0.11) + 0.08 * gap * fLo(0.08));
      // 찡그리기: 아랫눈꺼풀이 올라오고 윗눈꺼풀이 살짝 내려온다
      add(`eyeSquint${s}`, i, 0, 0.12 * gap * fUp(0.07) - 0.34 * gap * fLo(0.12));
      // 시선에 따른 눈꺼풀 추종 (홍채 자체는 셰이더에서 이동)
      add(`eyeLookUp${s}`, i, 0, -0.18 * gap * fUp(0.1) - 0.06 * gap * fLo(0.08));
      add(`eyeLookDown${s}`, i, 0, 0.32 * gap * fUp(0.08) + 0.06 * gap * fLo(0.08));

      // ── 눈썹 ──
      const sgnIn = s === "Right" ? 1 : -1; // 얼굴 중심 방향
      const bc = P[e.browCenter], bi = P[e.browInner], bo = P[e.browOuter];
      const vGate = (by) => (y <= by ? 1 : Math.exp(-(((y - by) / (0.13 * U)) ** 2)));
      const wBrow = gauss(x - bc[0], 0, 0.5 * U, 1) * (y <= bc[1] ? Math.exp(-(((bc[1] - y) / (0.4 * U)) ** 2)) : 1) * vGate(bc[1]);
      const wInner = gauss(x - bi[0], 0, 0.22 * U, 1) * (y <= bi[1] ? Math.exp(-(((bi[1] - y) / (0.45 * U)) ** 2)) : 1) * vGate(bi[1]);
      add(`browDown${s}`, i, sgnIn * 0.045 * U * wInner, 0.08 * U * wBrow + 0.02 * U * wInner);
      add("browInnerUp", i, -sgnIn * 0.01 * U * wInner, -0.12 * U * wInner);
      const wOuter = gauss(x - bo[0], 0, 0.28 * U, 1) * (y <= bo[1] ? Math.exp(-(((bo[1] - y) / (0.4 * U)) ** 2)) : 1) * vGate(bo[1]);
      add(`browOuterUp${s}`, i, 0, -0.1 * U * wOuter);
      if (onUpper || above >= 0) {
        // 눈썹을 올리면 윗눈꺼풀 피부도 조금 따라 올라간다
        const lidFollow = fUp(0.12);
        add("browInnerUp", i, 0, -0.08 * gap * lidFollow * gauss(x - bi[0], 0, 0.35 * U, 1));
        add(`browDown${s}`, i, 0, 0.12 * gap * lidFollow);
      }

      // ── 볼 올리기(cheekSquint): 광대 + 아랫눈꺼풀 ──
      const cheekC = [e.c[0] - sgnIn * 0.12 * U, loY + 0.32 * U];
      const eyeMidLo = interpY(e.lowerPL, e.c[0]);
      const wCheek = gauss(x - cheekC[0], y - (eyeMidLo + 0.32 * U), 0.45 * U, 0.3 * U) * (onUpper || above >= 0 ? 0.15 : 1);
      add(`cheekSquint${s}`, i, 0, -0.065 * U * wCheek - 0.22 * gap * fLo(0.14));
    }

    // ── 입 / 턱 ──
    const sgnX = x >= mc[0] ? 1 : -1;
    const seamY = interpY(seamPL, clamp(x, seamPL[0][0], seamPL[seamPL.length - 1][0]));
    const dyS = (y - seamY) / U;
    const ex = Math.max(0, Math.abs(x - mc[0]) - hw) / U;
    let lower;
    if (lm === 78 || lm === 308) lower = 0.5;
    else if (lowerInnerSet.has(lm)) lower = 1;
    else if (upperInnerSet.has(lm)) lower = 0;
    else { const sw = 0.02 + 0.8 * ex; lower = smoothstep(-sw, sw, dyS); }
    const upper = 1 - lower;
    const jawF = clamp((y - pivotY) / (chinY - pivotY), 0, 1.1);
    const jawFade = inOval ? 1 : Math.exp(-((dOval / (0.3 * U)) ** 2));
    const J = lower * jawF * jawFade;
    const hMask = Math.abs(x - mc[0]) <= hw ? 1 : Math.exp(-(((Math.abs(x - mc[0]) - hw) / (0.16 * U)) ** 2));
    const mouthRegion = gauss(x - mc[0], y - mc[1], hw * 1.25, 0.3 * U);

    // 입술 근처에서는 가운데가 더 많이 벌어져 타원형 입 모양이 되게 한다(턱 아래는 강체처럼 균일)
    const mxn = clamp(Math.abs(x - mc[0]) / hw, 0, 1.4);
    const oval01 = 1 - 0.55 * Math.min(1, mxn * mxn) * Math.exp(-((dyS / 0.2) ** 2));
    add("jawOpen", i, 0, 0.4 * U * J * oval01);
    for (const s of SIDES) {
      const c = corner[s];
      add("jawOpen", i, (s === "Left" ? -1 : 1) * 0.05 * U * gauss(x - c[0], y - c[1], 0.25 * U, 0.3 * U), 0);
    }
    add("jawForward", i, 0, 0.03 * U * J, 0.1 * U * J);
    add("jawLeft", i, 0.08 * U * J, 0);
    add("jawRight", i, -0.08 * U * J, 0);
    add("mouthClose", i, 0, -0.2 * U * lower * gauss(x - mc[0], y - mc[1], hw * 1.3, 0.22 * U) + 0.02 * U * upper * mouthRegion);

    // 입술 압축(press / roll): 입술선 쪽으로 모인다 (윗입술은 아래로, 아랫입술은 위로)
    const compress = (frac, tUp, tLo) => {
      if (dyS < 0) return dyS >= -tUp ? -frac * dyS * U : frac * tUp * U * Math.exp(-(((dyS + tUp) / 0.08) ** 2));
      return dyS <= tLo ? -frac * dyS * U : -frac * tLo * U * Math.exp(-(((dyS - tLo) / 0.08) ** 2));
    };
    const comp = compress(1, 0.11, 0.15);
    add("mouthRollUpper", i, 0, dyS < 0 ? 0.6 * comp * hMask : 0);
    add("mouthRollLower", i, 0, dyS >= 0 ? 0.6 * comp * hMask : 0);

    // 윗입술 올리기 / 턱·아랫입술 올리기
    add("mouthShrugUpper", i, 0, -0.045 * U * upper * gauss(x - mc[0], y - (mc[1] - 0.08 * U), hw * 1.2, 0.18 * U));
    add("mouthShrugLower", i, 0, -0.05 * U * gauss(x - mc[0], y - (mc[1] + 0.2 * U), hw * 1.15, 0.36 * U), 0.02 * U * mouthRegion);

    // 오므리기 / 깔때기
    for (const s of SIDES) {
      const c = corner[s], sOut = s === "Left" ? 1 : -1;
      const wc = gauss(x - c[0], y - c[1], 0.32 * U, 0.3 * U);
      add("mouthPucker", i, -sOut * 0.12 * U * wc, 0);
      add("mouthFunnel", i, -sOut * 0.07 * U * wc, 0);
    }
    add("mouthPucker", i, 0, 0, 0.12 * U * mouthRegion);
    add("mouthFunnel", i, 0, (-0.035 * upper + 0.06 * lower) * U * gauss(x - mc[0], y - mc[1], hw * 0.9, 0.22 * U), 0.1 * U * mouthRegion);
    add("mouthLeft", i, 0.1 * U * gauss(x - mc[0], y - mc[1], hw * 1.6, 0.32 * U), 0);
    add("mouthRight", i, -0.1 * U * gauss(x - mc[0], y - mc[1], hw * 1.6, 0.32 * U), 0);
    add("tongueOut", i, 0, 0.035 * U * lower * gauss(x - mc[0], y - mc[1], hw, 0.25 * U));

    for (const s of SIDES) {
      const c = corner[s], sOut = s === "Left" ? 1 : -1;
      const sideMask = smoothstep(-0.35, 0.35, ((x - mc[0]) / hw) * sOut);
      const wc = gauss(x - c[0], y - c[1], 0.3 * U, 0.28 * U);
      // 입술선 곡선 프로파일: 입꼬리만 갈고리처럼 당기지 않고 입술 전체가 부드러운 U/∩ 곡선으로 휘게 한다.
      //  u: 입 중앙 0 → 이쪽 입꼬리 1 → 볼 쪽으로 감쇠, v: 입술선(윗·아랫입술 경계)에서의 세로 거리
      const u = ((x - mc[0]) / hw) * sOut;
      const beyond = u > 1 ? Math.exp(-((((u - 1) * hw) / (0.28 * U)) ** 2)) : 1;
      const hCurve = u <= 0 ? 0 : Math.min(u, 1) ** 2 * beyond; // 가운데는 거의 그대로, 입꼬리로 갈수록 크게
      const hLin = u <= 0 ? 0 : Math.min(u, 1) * beyond; // 가로로 늘어나는 양
      const vy = (y - seamY) / U;
      const vBand = (up, down) => Math.exp(-((vy / (vy < 0 ? up : down)) ** 2));
      // 미소: 입술선이 위로 휘고 입이 옆으로 살짝 늘어난다 + 볼 올라감
      const ch = P[IDX.cheek[s]];
      const wch = gauss(x - ch[0], y - (ch[1] - 0.1 * U), 0.42 * U, 0.34 * U);
      const vs = vBand(0.42, 0.24);
      add(`mouthSmile${s}`, i, sOut * (0.09 * hLin * vs + 0.02 * wch) * U, -(0.15 * hCurve * vs + 0.07 * wch) * U);
      // 찡그림: 입술선이 아래로 휨(아래쪽 턱 근육까지 끌려 내려감)
      const vf = vBand(0.26, 0.42);
      add(`mouthFrown${s}`, i, sOut * 0.015 * U * hLin * vf, 0.1 * U * hCurve * vf);
      // 보조개: 입꼬리를 뒤로(바깥) 당김
      add(`mouthDimple${s}`, i, sOut * 0.06 * U * hCurve * vBand(0.25, 0.25), -0.01 * U * hCurve * vs);
      // 옆으로 당기기: 입이 넓어지며 입꼬리가 약간 내려감
      const lowSide = lower * gauss(x - (mc[0] + sOut * 0.5 * hw), y - mc[1], 0.4 * U, 0.25 * U);
      const vt = vBand(0.3, 0.34);
      add(`mouthStretch${s}`, i, sOut * 0.1 * U * hLin * vt, (0.04 * hCurve * vt + 0.03 * lowSide) * U);
      // 입술 누르기
      add(`mouthPress${s}`, i, 0, 0.45 * comp * hMask * sideMask);
      // 윗입술 올림 / 아랫입술 내림 (치아가 드러난다)
      add(`mouthUpperUp${s}`, i, 0, -0.07 * U * upper * gauss(x - (mc[0] + sOut * 0.45 * hw), y - (mc[1] - 0.1 * U), 0.36 * U, 0.2 * U));
      add(`mouthLowerDown${s}`, i, 0, 0.07 * U * lower * gauss(x - (mc[0] + sOut * 0.45 * hw), y - (mc[1] + 0.1 * U), 0.36 * U, 0.26 * U));
      // 볼 부풀리기
      const puffC = [c[0] + sOut * 0.28 * U, c[1] - 0.12 * U];
      const wp = gauss(x - puffC[0], y - puffC[1], 0.36 * U, 0.36 * U);
      add("cheekPuff", i, sOut * 0.07 * U * wp, 0, 0.05 * U * wp);
      // 코 찡그림: 콧방울과 윗입술 옆이 올라간다
      const al = P[IDX.alar[s]];
      const wn = gauss(x - al[0], y - (al[1] - 0.06 * U), 0.2 * U, 0.26 * U);
      const wnl = upper * gauss(x - (mc[0] + sOut * 0.3 * hw), y - (mc[1] - 0.12 * U), 0.3 * U, 0.2 * U);
      add(`noseSneer${s}`, i, -sOut * 0.01 * U * wn, -(0.06 * wn + 0.025 * wnl) * U);
    }
    add("cheekPuff", i, 0, 0.2 * comp * hMask * 0.5);
  }

  // 감정 표현용 채널의 움직임 폭 배율(깜빡임·시선은 정확히 닫혀야 하므로 1 유지)
  const AMP = {
    browDown: 1.8, browInnerUp: 2.0, browOuterUp: 1.6,
    mouthSmile: 1.1, mouthFrown: 1.75, mouthStretch: 1.35, mouthDimple: 1.3,
    mouthUpperUp: 1.35, mouthLowerDown: 1.3, mouthPress: 1.4,
    cheekSquint: 1.2, noseSneer: 1.7, eyeWide: 1.3, eyeSquint: 1.35,
    jawOpen: 1.15, mouthShrugLower: 1.5, mouthLeft: 1.3, mouthRight: 1.3,
  };
  BLENDSHAPE_NAMES.forEach((name, k) => {
    const key = Object.keys(AMP).find((a) => name === a || name === `${a}Left` || name === `${a}Right`);
    if (!key) return;
    const d = deltas[k];
    for (let j = 0; j < d.length; j++) d[j] *= AMP[key];
  });

  // 입 중심 정점은 13/14의 평균 델타
  for (const d of deltas) for (let c = 0; c < 3; c++) d[mouthCenter * 3 + c] = (d[13 * 3 + c] + d[14 * 3 + c]) / 2;

  return {
    W, H, U, verts, n,
    skinIndex: skin, eyeIndex: eyeTris, mouthIndex: mouthTris,
    deltas, aMouth, aCheek, eyeInfo,
    pivot: [faceCx, chinY + 60 * k, -60 * k],
    // 기본 화면 구도(머리~가슴)
    frame: { cx: faceCx, top: Math.max(0, P[10][1] - 1.5 * U), bottom: Math.min(H, chinY + 2.2 * U), halfW: 2.65 * U },
    anchors: { mouthCenter: mc, faceCx, eyes: { Left: P[473], Right: P[468] } },
  };
}
