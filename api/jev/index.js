// Vercel 함수: POST /api/jev → TypeSafe AI Jev 프록시(요청 제한·출처 확인 포함)
import { handleJev } from "../../lib/jevProxy.mjs";

export function POST(request) {
  return handleJev(request);
}
