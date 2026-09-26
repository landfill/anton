// 얼굴 렌더러: 리그의 52개 blendshape 델타를 매 프레임 CPU에서 합성하고
// 머리 회전(목 피벗 기준, head weight로 어깨는 고정)을 적용해 Three.js로 그린다.
import * as THREE from "three";
import { BLENDSHAPE_NAMES, BS } from "./faceRig.js";

const skinVert = /* glsl */ `
attribute float aCheek;
varying vec2 vUv;
varying float vCheek;
void main() {
  vUv = uv;
  vCheek = aCheek;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const skinFrag = /* glsl */ `
uniform sampler2D map;
uniform vec3 uFlushColor;
uniform float uFlush;
uniform float uPale;
varying vec2 vUv;
varying float vCheek;
void main() {
  vec4 c = texture2D(map, vUv);
  if (c.a < 0.01) discard;
  vec3 col = c.rgb;
  col = mix(col, col * uFlushColor, clamp(uFlush * vCheek, 0.0, 1.0));
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l) * 1.04, clamp(uPale * 0.4 * vCheek, 0.0, 1.0));
  gl_FragColor = vec4(col, c.a);
}`;

const eyeVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
// 홍채 주변 픽셀만 시선 방향으로 옮겨 그린다(흰자는 거의 고정).
const eyeFrag = /* glsl */ `
uniform sampler2D map;
uniform vec2 uTexSize;
uniform vec2 uIrisL, uIrisR;   // uv
uniform vec2 uGazeL, uGazeR;   // 텍스처 픽셀(uv 방향, y 위)
uniform float uIrisRadius;
uniform float uLidShade;
varying vec2 vUv;
void main() {
  vec2 px = vUv * uTexSize;
  vec2 cL = uIrisL * uTexSize, cR = uIrisR * uTexSize;
  bool useL = distance(px, cL) < distance(px, cR);
  vec2 c = useL ? cL : cR;
  vec2 g = useL ? uGazeL : uGazeR;
  float d = distance(px - g, c);
  float w = 1.0 - smoothstep(uIrisRadius * 1.05, uIrisRadius * 2.1, d);
  vec2 src = px - g * w;
  vec4 col = texture2D(map, src / uTexSize);
  // 윗부분은 눈꺼풀 그림자
  float top = smoothstep(-uIrisRadius * 0.2, uIrisRadius * 1.0, px.y - c.y);
  col.rgb *= 1.0 - uLidShade * top;
  gl_FragColor = vec4(col.rgb, 1.0);
}`;

const mouthVert = /* glsl */ `
attribute vec2 aMouth;
varying vec2 vMouth;
void main() {
  vMouth = aMouth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const mouthFrag = /* glsl */ `
uniform float uTongue;
varying vec2 vMouth;
void main() {
  float x = vMouth.x, y = vMouth.y;
  vec3 col = vec3(0.08, 0.025, 0.025);
  float side = 1.0 - smoothstep(0.3, 0.75, abs(x));
  float teethU = (1.0 - smoothstep(0.1, 0.22, y)) * smoothstep(0.0, 0.05, y) * side * 0.85;
  float teethL = smoothstep(0.88, 0.97, y) * 0.4 * side;
  vec3 teeth = vec3(0.68, 0.63, 0.56) * (1.0 - 0.5 * abs(x));
  float tongue = smoothstep(0.55, 0.9, y) * (1.0 - smoothstep(0.25, 0.8, abs(x))) * (0.3 + 0.7 * uTongue);
  col = mix(col, vec3(0.5, 0.2, 0.2), clamp(tongue, 0.0, 1.0));
  col = mix(col, teeth, clamp(max(teethU, teethL), 0.0, 1.0));
  col *= 1.0 - 0.55 * smoothstep(0.55, 1.0, abs(x));
  gl_FragColor = vec4(col, 1.0);
}`;

export class FaceView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {ReturnType<import('./faceRig.js').buildFaceRig>} rig
   * @param {THREE.Texture} texture
   */
  constructor(canvas, rig, texture) {
    this.rig = rig;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -3000, 3000);
    this.camera.position.z = 1000;

    const { n, verts, W, H } = rig;
    this.cx = W / 2;
    this.cy = H / 2;
    // 월드 좌표(y 위)로 변환한 기본 위치와 델타
    this.rest = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    this.headW = new Float32Array(n);
    verts.forEach((v, i) => {
      this.rest[i * 3] = v.x - this.cx;
      this.rest[i * 3 + 1] = this.cy - v.y;
      this.rest[i * 3 + 2] = v.z;
      uv[i * 2] = v.u;
      uv[i * 2 + 1] = v.v;
      this.headW[i] = v.head;
    });
    this.deltas = rig.deltas.map((d) => {
      const w = new Float32Array(d.length);
      for (let i = 0; i < d.length; i += 3) { w[i] = d[i]; w[i + 1] = -d[i + 1]; w[i + 2] = d[i + 2]; }
      return w;
    });
    this.pivot = [rig.pivot[0] - this.cx, this.cy - rig.pivot[1], rig.pivot[2]];

    this.position = new THREE.BufferAttribute(new Float32Array(this.rest), 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    const uvAttr = new THREE.BufferAttribute(uv, 2);
    const makeGeom = (index) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", this.position);
      g.setAttribute("uv", uvAttr);
      g.setAttribute("aMouth", new THREE.BufferAttribute(rig.aMouth, 2));
      g.setAttribute("aCheek", new THREE.BufferAttribute(rig.aCheek, 1));
      g.setIndex(index);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
      return g;
    };

    texture.colorSpace = THREE.NoColorSpace;
    texture.anisotropy = 4;
    this.skinMat = new THREE.ShaderMaterial({
      vertexShader: skinVert, fragmentShader: skinFrag, side: THREE.DoubleSide, transparent: true, depthTest: true, depthWrite: true,
      uniforms: { map: { value: texture }, uFlush: { value: 0 }, uFlushColor: { value: new THREE.Color(1.08, 0.88, 0.86) }, uPale: { value: 0 } },
    });
    const irisPx = Math.max(rig.eyeInfo.Left.irisRadiusPx, rig.eyeInfo.Right.irisRadiusPx);
    this.eyeMat = new THREE.ShaderMaterial({
      vertexShader: eyeVert, fragmentShader: eyeFrag, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      uniforms: {
        map: { value: texture }, uTexSize: { value: new THREE.Vector2(W, H) },
        uIrisL: { value: new THREE.Vector2(...rig.eyeInfo.Left.irisUV) }, uIrisR: { value: new THREE.Vector2(...rig.eyeInfo.Right.irisUV) },
        uGazeL: { value: new THREE.Vector2() }, uGazeR: { value: new THREE.Vector2() },
        uIrisRadius: { value: irisPx }, uLidShade: { value: 0 },
      },
    });
    this.irisPx = irisPx;
    this.mouthMat = new THREE.ShaderMaterial({
      vertexShader: mouthVert, fragmentShader: mouthFrag, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      uniforms: { uTongue: { value: 0 } },
    });

    const mouth = new THREE.Mesh(makeGeom(rig.mouthIndex), this.mouthMat);
    const eyes = new THREE.Mesh(makeGeom(rig.eyeIndex), this.eyeMat);
    const skin = new THREE.Mesh(makeGeom(rig.skinIndex), this.skinMat);
    mouth.renderOrder = 0;
    eyes.renderOrder = 0;
    skin.renderOrder = 1;
    for (const m of [mouth, eyes, skin]) { m.frustumCulled = false; this.scene.add(m); }

    // 화면 구도: 머리~가슴 (이미지 좌표)
    this.frame = { cx: rig.anchors.faceCx, top: 0, bottom: Math.min(H, 880), halfW: 400 };
    this.weights = new Float32Array(BLENDSHAPE_NAMES.length);
    this._rot = new THREE.Matrix4();
    this._euler = new THREE.Euler();
  }

  resize(width, height) {
    this.renderer.setSize(width, height, false);
    const { cx, top, bottom, halfW } = this.frame;
    const aspect = width / height;
    let h = bottom - top, w = h * aspect;
    if (w < halfW * 2) { w = halfW * 2; h = w / aspect; }
    // 아래쪽(옷 끝)을 화면 하단에 맞춘다
    const left = cx - w / 2 - this.cx, right = cx + w / 2 - this.cx;
    const bottomW = this.cy - bottom, topW = bottomW + h;
    Object.assign(this.camera, { left, right, top: topW, bottom: bottomW });
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param {Float32Array} weights 52개 blendshape (0..1)
   * @param {{yaw:number,pitch:number,roll:number,tx:number,ty:number,breath:number}} head 라디안/픽셀
   */
  update(weights, head, extras = {}) {
    const pos = this.position.array;
    pos.set(this.rest);
    const N = pos.length;
    for (let k = 0; k < weights.length; k++) {
      const w = weights[k];
      if (Math.abs(w) < 1e-4) continue;
      const d = this.deltas[k];
      for (let j = 0; j < N; j++) pos[j] += w * d[j];
    }
    // 머리 회전: pitch>0 = 고개 숙임, yaw>0 = 인물 왼쪽(화면 오른쪽)을 봄, roll>0 = 화면 기준 시계 방향 기울임
    this._euler.set(head.pitch, head.yaw, -head.roll, "YXZ");
    this._rot.makeRotationFromEuler(this._euler);
    const e = this._rot.elements;
    const [px, py, pz] = this.pivot;
    const hw = this.headW;
    const breathY = head.breath || 0;
    for (let i = 0, j = 0; i < hw.length; i++, j += 3) {
      const x = pos[j] - px, y = pos[j + 1] - py, z = pos[j + 2] - pz;
      const h = hw[i];
      // 호흡: 어깨/몸통까지 아주 약하게 오르내림
      pos[j + 1] += breathY * (0.35 + 0.65 * h);
      if (h <= 0) continue;
      const rx = e[0] * x + e[4] * y + e[8] * z + px + head.tx;
      const ry = e[1] * x + e[5] * y + e[9] * z + py + head.ty;
      const rz = e[2] * x + e[6] * y + e[10] * z + pz;
      pos[j] += (rx - pos[j]) * h;
      pos[j + 1] += (ry - (py + y)) * h;
      pos[j + 2] += (rz - pos[j + 2]) * h;
    }
    this.position.needsUpdate = true;

    // 시선: eyeLook* 값 → 홍채 이동(텍스처 픽셀, uv 방향 y 위)
    const gx = this.irisPx * 0.55, gy = this.irisPx * 0.35;
    const W = (n) => weights[BS[n]];
    this.eyeMat.uniforms.uGazeR.value.set(
      (W("eyeLookInRight") - W("eyeLookOutRight")) * gx,
      (W("eyeLookUpRight") - W("eyeLookDownRight")) * gy,
    );
    this.eyeMat.uniforms.uGazeL.value.set(
      (W("eyeLookOutLeft") - W("eyeLookInLeft")) * gx,
      (W("eyeLookUpLeft") - W("eyeLookDownLeft")) * gy,
    );
    this.eyeMat.uniforms.uLidShade.value = 0.12 + 0.25 * Math.max(W("eyeBlinkLeft"), W("eyeBlinkRight"));
    this.mouthMat.uniforms.uTongue.value = W("tongueOut");
    this.skinMat.uniforms.uFlush.value = extras.flush ?? 0;
    if (extras.flushColor) this.skinMat.uniforms.uFlushColor.value.setRGB(...extras.flushColor);
    this.skinMat.uniforms.uPale.value = extras.pale ?? 0;

    this.renderer.render(this.scene, this.camera);
  }
}
