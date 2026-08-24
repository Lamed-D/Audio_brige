# VOICE BRIDGE 프론트엔드 인수인계

## 현재 기준

- 패키지 버전: `0.2.6`
- Chrome 최소 버전: `116`
- 지원 플랫폼: YouTube
- 백엔드 기본 주소: `http://localhost:8000`
- manifest 계약: `1.1`
- 작업 상태 계약: `1.2`

## 구현 완료

- YouTube 영상 식별과 SPA 이동 감지
- 영상 재생, 정지, 탐색, 배속, 음량 이벤트 표준화
- 화면해설 Scheduler와 지연/탐색 구간 skip
- overlay 더킹과 사용자 음량 복구
- extended 영상 자동 정지, 해설 재생, 안전 재개
- Offscreen Document 기반 WAV 재생
- Side Panel 설정과 작업 진행률/ETA UI
- `Alt+Shift+V` 패널 실행, `Alt+Shift+S` 생성 요청·현재 상태 확인
- `Alt+Shift+J` 영상 재생·남은 시간 안내, `Alt+Shift+H` 화면해설 토글
- `chrome.tts` 기반 단축키 결과와 패널 열림·닫힘 한국어 음성 안내
- NVDA용 polite/assertive 실시간 알림 분리와 반복 상태 낭독 억제
- Tab 초점, 토글, 슬라이더, 완료·오류별 조작 알림음과 음량·끄기 설정
- 키보드 탐색, 200% 확대, 고대비 모드 대응
- 작업 생성/상태 조회 API 클라이언트와 상태 복원
- manifest/작업 상태 런타임 검증 및 테스트

## 백엔드와 지금 확인 가능한 것

1. `GET /v1/manifests/{provider}/{video_id}`의 `404`, `202`, `200` 처리
2. `POST /v1/jobs`의 작업 생성과 중복 작업 응답
3. `GET /v1/jobs/{job_id}`의 진행률, ETA, 완료, 실패 처리
4. 패널을 닫은 동안의 폴링 상태 복원
5. 완료/실패 배지와 Chrome 알림
6. 반환 manifest의 `schema_version`, ID, 구간 길이 검증

## 아직 남은 FE 연동 작업

현재 Content Scheduler는 `fixtures/manifest-v1.1.valid.json`의 데모 manifest만 메모리에 적재합니다. Service Worker의 API 클라이언트는 백엔드 manifest를 검증하지만, 검증된 manifest를 Content Script로 전달해 Scheduler에 적재하는 메시지 경로는 아직 구현되지 않았습니다.

실제 백엔드 화면해설 재생을 위해 필요한 다음 작업은 아래와 같습니다.

1. `MANIFEST_GET` 런타임 메시지 계약 추가
2. Service Worker가 검증한 manifest를 Content Script에 반환
3. Scheduler Runtime에 `loadManifest`와 영상 변경 시 폐기 처리 추가
4. 작업 상태가 `ready`가 되면 현재 탭에 manifest 재조회 요청
5. 실제 `/v1/audio/*` WAV 재생과 실패 복구 통합 테스트

## 데모 fixture 주의사항

`youtube:dQw4w9WgXcQ:r1` manifest의 `seg-001.wav`, `seg-002.wav`는 확장프로그램에 포함된 데모 WAV로 치환됩니다. 다른 manifest ID의 오디오 경로는 백엔드로 요청됩니다.

## 설정 변경 위치

- API 주소: `src/shared/config/constants.ts`
- Chrome API 접근 권한: `extension/manifest.json`
- 색상 토큰: `extension/styles/tokens.css`
- manifest 계약: `contracts/manifest-v1.1.schema.json`
- 작업 상태 계약: `contracts/job-status-v1.2.schema.json`
- NVDA 수동 검증: `docs/NVDA_테스트_체크리스트.md`
