# VOICE BRIDGE Chrome Extension

`VOICE BRIDGE` POC의 프론트엔드 크롬 확장프로그램입니다. 4단계 실시간 재생 엔진과 백엔드에 독립적인 8단계 접근성 UI를 제공합니다.

## 팀 공유용 빠른 시작

요구 환경은 Node.js 20 이상과 Chrome 116 이상입니다.

```powershell
npm ci
npm run check
```

`npm run check`는 타입 검사, 계약/스케줄러 테스트, 개발 빌드를 순서대로 실행합니다. 빌드가 끝나면 Chrome의 `압축해제된 확장 프로그램을 로드합니다`에서 `extension` 폴더를 선택합니다.

백엔드는 기본적으로 `http://localhost:8000`에서 실행한다고 가정합니다. 다른 주소나 포트를 사용할 때는 `src/shared/config/constants.ts`의 `API_BASE_URL`과 `extension/manifest.json`의 `host_permissions`를 함께 수정해야 합니다.

- [백엔드 연동 가이드](docs/BACKEND_INTEGRATION.md)
- [현재 FE 구현 상태와 인수인계](docs/FRONTEND_STATUS.md)
- [협업 및 PR 규칙](CONTRIBUTING.md)
- [공유 GitHub 업로드 방법](GITHUB_UPLOAD.md)

## 현재 범위

- TypeScript 멀티 엔트리 빌드
- Content Script, Service Worker, Offscreen Document, Side Panel 골격
- YouTube 영상 ID 정규화와 `youtube:video_id` 키 생성
- 현재 `<video>` 탐색 및 교체 감지
- 재생·정지·탐색·배속·볼륨·재생 위치 이벤트 표준화
- YouTube SPA 영상 변경 감지와 이전 상태 폐기
- Side Panel 최상단에 화면해설 설정과 현재 해설 표시
- 현재 YouTube 영상 제목·재생 상태 표시
- 버전·영상 ID·manifest 상태는 기본적으로 접힌 진단 정보에 분리
- 더미 manifest와 현재 영상의 `video_key` 매칭
- 50ms 주기의 화면해설 시점 Scheduler
- 지연 구간과 앞으로 탐색한 구간 skip, 뒤로 탐색할 때 중복 재생 방지
- Side Panel 해설 일정·진행률·최근 Scheduler 결과 표시
- Service Worker가 Offscreen Document 생성과 오디오 경로 검증 담당
- Offscreen Document에서 화면해설 WAV 재생·중단·타임아웃 처리
- overlay 모드에서 원본 볼륨 더킹 후 사용자 볼륨 복구
- extended 모드에서 영상 자동 정지 후 해설 종료 시 안전 재개
- 탐색·페이지 이동·사용자 정지 시 해설 취소와 상태 복구
- Side Panel 화면해설 켜기·끄기 및 음성 엔진 상태 표시
- 화면해설 음량, 해설 중 원본 음량, 긴 해설 자동 정지 설정
- `chrome.storage.local`을 이용한 사용자 설정 유지
- 활성 영상이 없어도 설정을 조작하고 저장할 수 있는 독립 설정 UI
- 재생 중인 해설 문장 표시와 오류만 제한적으로 알리는 `aria-live` 정책
- 키보드 조작, Windows 고대비 모드, 200% 확대 재배치 대응
- `Alt+Shift+V`로 Side Panel을 여는 기본 키보드 단축키
- `Alt+Shift+S` 또는 버튼으로 현재 생성 단계·진행률·예상시간을 즉시 안내
- 신규 영상의 화면해설 작업 생성과 `job_id` 기반 진행 상태 복원
- 패널을 닫아도 작업을 추적하고 아이콘 퍼센트 배지와 완료·실패 알림 제공
- `schema_version: 1.1` manifest 타입과 런타임 검증
- 정상·오류 fixture 및 계약 테스트

현재 데모 manifest의 두 음성은 `extension/demo-audio`의 한국어 WAV fixture로 재생됩니다. 이 치환은 데모 manifest ID인 `youtube:dQw4w9WgXcQ:r1`에만 적용됩니다. 다른 manifest의 `/v1/audio/*` 경로는 `http://localhost:8000`의 백엔드 API로 요청합니다.

작업 생성/진행률 API 연결은 구현되어 있지만, 백엔드가 반환한 manifest를 Content Scheduler에 동적으로 주입하는 단계는 아직 남아 있습니다. 현재 실제 재생 Scheduler는 `fixtures/manifest-v1.1.valid.json`을 사용합니다. 연동 순서는 [백엔드 연동 가이드](docs/BACKEND_INTEGRATION.md)를 기준으로 맞춥니다.

## 명령어

```powershell
npm install
npm run check
```

개발 중 자동 빌드는 다음 명령을 사용합니다.

```powershell
npm run watch
```

## Chrome에 로드

1. `chrome://extensions`에서 개발자 모드를 켭니다.
2. `압축해제된 확장 프로그램을 로드합니다`를 선택합니다.
3. 이 프로젝트의 `extension` 폴더를 선택합니다.
4. `Alt+Shift+V`를 누르거나 툴바의 `VOICE BRIDGE` 아이콘을 누르면 Side Panel이 열립니다.

현재 영상의 화면해설 생성 상태는 `Alt+Shift+S`로 확인합니다. 이 단축키는 Side Panel을 열고 현재 단계, 진행률, 예상시간을 한 번 음성으로 안내합니다. 같은 기능의 `현재 진행 상태 확인` 버튼도 유지합니다.

단축키가 다른 프로그램이나 확장프로그램과 충돌하면 `chrome://extensions/shortcuts`에서 변경합니다. Side Panel 안에서는 `Tab`과 `Shift+Tab`으로 항목을 이동하고, `Space`로 체크박스와 진단 정보를 조작하며, 방향키로 음량 슬라이더를 조절합니다.

## 계약 파일

- `contracts/manifest-v1.1.schema.json`: BE와 공유할 JSON Schema
- `contracts/job-status-v1.2.schema.json`: 작업 생성·진행률·ETA·완료 상태 JSON Schema
- `fixtures/manifest-v1.1.valid.json`: 정상 fixture이자 Stage 3 Scheduler 데모 manifest
- `fixtures/manifest-v1.1.invalid.json`: overlay 길이 위반 fixture
- `src/shared/contracts/manifest.ts`: FE 런타임 파서와 TypeScript 타입

## 재생 정책

- `overlay`: 원본 영상은 계속 재생하고 `userVolume × duck_factor`로 낮춥니다.
- `extended`: 원본 영상을 일시정지하고 해설 종료 후 이전에 재생 중이던 경우만 재개합니다.
- 사용자가 탐색하거나 직접 재생을 재개하면 현재 해설을 취소하고 사용자의 조작을 우선합니다.
- 기능을 끄는 동안 extended 해설로 정지된 영상은 즉시 재개합니다.
- 긴 해설 자동 정지를 끄면 extended 해설은 원본 음성과 겹치지 않고 건너뜁니다.
- 해설 파일 로딩 실패와 타임아웃이 발생해도 볼륨과 영상 상태를 복구합니다.

UI 구조와 접근성 선택의 근거는 [`docs/VOICE_BRIDGE_UI_설계근거.md`](docs/VOICE_BRIDGE_UI_설계근거.md)에 정리되어 있습니다.

계약 변경 시 위 계약 파일들과 계약 테스트를 함께 수정합니다. FE는 `schema_version: 1.1` 이외의 manifest를 거부합니다.

## 작업 상태 API

- `POST /v1/jobs`: 신규 분석 요청. `200`, `202`, `409` 응답 본문은 작업 상태 계약을 따릅니다.
- `GET /v1/jobs/{job_id}`: 저장된 작업 조회. 존재하지 않으면 `404`를 반환합니다.
- `GET /v1/manifests/{provider}/{video_id}`: 준비 완료 시 manifest `200`, 생성 중이면 작업 상태 `202`, 미생성 영상은 `404`를 반환합니다.
- BE는 같은 작업의 `progress_percent`를 감소시키지 않고, 예측이 불안정한 ETA는 임의 숫자 대신 `null`로 반환합니다.
- FE는 `retry_after_ms`에 맞춰 폴링하고 새 진행률마다 말하지 않습니다. 시작, 단계 변경, 25·50·75%, 완료, 실패 시에만 자동 안내하며 수동 확인은 항상 현재 상태를 읽습니다.

## 디자인 토큰

색상은 `extension/styles/tokens.css`를 단일 기준으로 사용합니다. 컴포넌트 CSS에 임의 HEX 값을 추가하지 않습니다.

| 역할 | 토큰 | 값 |
| --- | --- | --- |
| 기본 배경 | `--color-canvas` | `#F7F8FA` |
| 콘텐츠 표면 | `--color-surface` | `#FFFFFF` |
| 기본 글자 | `--color-text` | `#111827` |
| 보조 글자 | `--color-text-muted` | `#475569` |
| 주요 동작 | `--color-primary` | `#075985` |
| 주요 동작 Hover | `--color-primary-hover` | `#0C4A6E` |
| 화면해설 강조 | `--color-accent` | `#F2C14E` |
| 테두리 | `--color-border` | `#CBD5E1` |
| 성공 | `--color-success` | `#13795B` |
| 오류 | `--color-danger` | `#B42318` |
| 키보드 포커스 | `--color-focus` | `#005FCC` |

주요 버튼은 흰색 글자와 `--color-primary`를, 강조 버튼은 어두운 글자와 `--color-accent`를 조합합니다. 성공·오류·재생 상태는 색상만으로 전달하지 않고 아이콘과 텍스트를 함께 제공합니다.
