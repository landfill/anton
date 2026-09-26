# Jev Face Lab

메시지를 입력하거나 고칠 때마다 **TypeSafe AI Jev**가 “이 메시지를 받은 사람이 느낄 감정 + 강도”를 판단하고,
사진으로 만든 얼굴 모델이 ARKit 52 blendshape 표정으로 즉시 반응하는 테스트 앱입니다.

```
텍스트 → Jev(System One) → 감정 분포 + 강도 → 표정 변환 엔진(FACS 프리셋) → 52 Blendshape → 사진 기반 얼굴 → 실시간 표정
```

## 실행

```bash
npm start            # http://localhost:5173
npm test             # 로컬 판단기·Jev 요청/응답 테스트
```

Jev API를 쓰려면 `.env.example`을 `.env`로 복사해 `TYPESAFE_API_KEY`를 넣고 서버를 다시 시작하세요.
키는 서버(`server.mjs`)에만 머물고 브라우저는 `/api/jev` 프록시만 호출합니다.
키가 없으면 규칙 기반 **로컬 시뮬레이터**가 같은 형식(감정 choice + 강도 score)으로 답합니다(실제 Jev 모델 아님).

## 구조

| 경로 | 역할 |
| --- | --- |
| `assets/face.webp`, `assets/face-landmarks.json` | 원본 사진과 bake된 MediaPipe 3D 랜드마크 478점 |
| `tools/bake.html` | 사진 → 랜드마크 재추출(`?src=` 로 다른 사진 지정) |
| `tools/rig-lab.html` | 52개 blendshape 슬라이더로 리그 점검 |
| `src/face/faceRig.js` | 얼굴 메시(눈·입 구멍, 눈 내부/구강 레이어) + ARKit 52 모프 델타 생성 |
| `src/face/faceView.js` | Three.js 렌더러: 델타 합성, 머리 회전, 시선(홍채) 셰이더, 홍조 |
| `src/jev/jevClient.js` | Jev `POST /v1/systemone` 요청/응답 정규화, 로컬 대체 |
| `src/jev/localJev.js` | 오프라인 판단기(말줄임표·반전·단답·강조 등 규칙) |
| `src/expression/emotionMap.js` | 감정 → blendshape·머리 자세·안색 매핑 |
| `src/expression/animator.js` | 스프링 보간, 깜빡임, 시선 도약, 읽기 동작, 호흡, 놀람 반응 |
