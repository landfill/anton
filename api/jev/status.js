// Vercel 함수: GET /api/jev/status → 키 설정 여부·모델·요청 제한
import { handleStatus } from "../../lib/jevProxy.mjs";

export function GET() {
  return handleStatus();
}
