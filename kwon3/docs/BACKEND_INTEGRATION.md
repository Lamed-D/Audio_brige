# VOICE BRIDGE 백엔드 연동 가이드

이 문서는 백엔드 담당자가 프론트엔드 크롬 확장프로그램과 API를 연결할 때 필요한 최소 계약을 정리합니다. 상세 기준 문서는 `docs/reference/VOICE_BRIDGE_개발분담_연동규격_v1.2.docx`입니다.

## 1. 로컬 실행 조건

프론트엔드는 기본적으로 아래 주소만 호출합니다.

```text
http://127.0.0.1:5000
```

현재 통합 백엔드는 `../kwon2/backend`입니다. 다른 주소나 포트를 사용하려면 다음 두 파일을 함께 변경합니다.

- `src/shared/config/constants.ts`
- `extension/manifest.json`의 `host_permissions`

## 2. 연결 순서

1. `GET /v1/manifests/youtube/{video_id}`에서 `404` 응답
2. `POST /v1/jobs`에서 `queued` 또는 `processing` 응답
3. `GET /v1/jobs/{job_id}`에서 진행률 증가
4. 완료 시 `ready` 응답
5. `GET /v1/manifests/youtube/{video_id}`에서 manifest v1.1 반환
6. `GET /v1/audio/{audio_id}`에서 WAV 반환

이 1~6단계는 현재 모두 구현되어 있으며, 화면해설을 켜면 기존 manifest를 우선 재사용합니다.

### FE 분석 트리거

분석 요청은 다음 두 경로가 동일한 `POST /v1/jobs`를 호출합니다.

- Side Panel의 `화면해설 켜기` 버튼 또는 `화면해설 만들기` 버튼
- YouTube 영상에서 `Alt+Shift+S`

`Alt+Shift+S`는 먼저 현재 영상과 기존 작업 상태를 확인합니다. manifest가 없거나 재시도 가능한 실패 상태면 `POST /v1/jobs`를 호출하고, 이미 처리 중이거나 완료된 영상이면 새 작업을 만들지 않고 현재 상태를 안내합니다.

FE는 브라우저에서 영상 파일, 프레임 또는 오디오를 추출해 업로드하지 않습니다. 요청 본문에는 `provider`, `video_id`, `duration_ms`만 포함됩니다. BE는 이 식별자를 기준으로 M1에서 영상을 확보하고 이후 오디오·프레임 분석을 수행해야 합니다.

## 3. 엔드포인트

### `POST /v1/jobs`

요청 본문:

```json
{
  "provider": "youtube",
  "video_id": "dQw4w9WgXcQ",
  "duration_ms": 213061
}
```

허용 응답:

- `202`: 새 작업 생성 또는 처리 중
- `200`: 이미 완료된 작업
- `409`: 같은 영상의 기존 작업 반환

세 상태 모두 응답 본문은 `contracts/job-status-v1.2.schema.json`을 따라야 합니다.

### `GET /v1/jobs/{job_id}`

- `200`: `queued`, `processing`, `ready`, `failed` 중 하나
- `404`: 저장된 작업 없음

`job_id`는 `^[A-Za-z0-9._:-]+$`를 만족해야 합니다.

### `GET /v1/manifests/{provider}/{video_id}`

- `200`: `contracts/manifest-v1.1.schema.json` 형식의 manifest
- `202`: 현재 작업 상태
- `404`: 아직 생성 요청이 없는 영상

### `GET /v1/audio/{audio_id}`

- 성공 시 `200`
- `Content-Type: audio/wav` 권장
- manifest의 `audio.duration_ms`와 실제 음성 길이가 일치해야 함
- POC에서는 인증 없는 동일 백엔드 origin 경로를 사용

## 4. 작업 상태 예시

처리 중 응답:

```json
{
  "status": "processing",
  "job_id": "job-20260818-001",
  "video_key": "youtube:dQw4w9WgXcQ",
  "stage": "visual_analysis",
  "progress_percent": 47,
  "eta_seconds": 82,
  "eta_confidence": "medium",
  "retry_after_ms": 3000,
  "updated_at": "2026-08-18T08:30:00Z"
}
```

완료 응답:

```json
{
  "status": "ready",
  "job_id": "job-20260818-001",
  "video_key": "youtube:dQw4w9WgXcQ",
  "progress_percent": 100,
  "manifest_id": "youtube:dQw4w9WgXcQ:r1",
  "revision": 1,
  "updated_at": "2026-08-18T08:32:15Z"
}
```

실패 응답:

```json
{
  "status": "failed",
  "job_id": "job-20260818-001",
  "video_key": "youtube:dQw4w9WgXcQ",
  "progress_percent": 47,
  "error": {
    "code": "VISUAL_ANALYSIS_FAILED",
    "retryable": true
  },
  "updated_at": "2026-08-18T08:31:05Z"
}
```

## 5. 반드시 지킬 규칙

- `video_key`는 `youtube:{video_id}` 형식입니다.
- 같은 작업의 `progress_percent`는 감소하지 않습니다.
- 처리 중 진행률은 `0~99`, 완료는 반드시 `100`입니다.
- `retry_after_ms`는 `1000~30000` 범위입니다.
- ETA를 신뢰할 수 없으면 임의 숫자 대신 `null`을 반환합니다.
- 날짜는 UTC ISO 8601 형식으로 반환합니다.
- manifest의 `manifest_id`는 `{provider}:{video_id}:r{revision}`과 일치해야 합니다.
- overlay는 `deadline_ms`가 필수이며 음성 길이가 구간을 넘으면 안 됩니다.
- extended는 `importance: high`이며 `deadline_ms`를 포함하지 않습니다.
- 오디오 경로는 `/v1/audio/`로 시작해야 합니다.
- 계약에 없는 필드를 임의로 추가하지 않습니다.

## 6. 계약 및 fixture

- `contracts/job-status-v1.2.schema.json`
- `contracts/manifest-v1.1.schema.json`
- `fixtures/manifest-v1.1.valid.json`
- `fixtures/manifest-v1.1.invalid.json`
- `src/shared/contracts/job-status.ts`
- `src/shared/contracts/manifest.ts`

JSON Schema는 BE 구현 검증 기준이고 TypeScript 파서는 FE의 최종 방어선입니다. 둘 중 하나만 통과하는 응답은 정상 응답으로 보지 않습니다.

## 7. 현재 연동 경계

작업 생성, 상태 조회, 진행률, ETA, 완료/실패 UI는 백엔드와 즉시 연결할 수 있습니다. 다만 백엔드에서 받은 manifest를 Content Scheduler에 동적으로 적재하는 FE 메시지 경로는 아직 구현 전입니다. 따라서 첫 합동 테스트는 작업 상태 API까지 진행하고, 실제 음성 재생은 `docs/FRONTEND_STATUS.md`의 남은 작업을 완료한 뒤 붙입니다.

## 8. 합동 테스트 체크리스트

- [ ] 미생성 영상에서 `404` 후 만들기 버튼 표시
- [ ] 미생성 영상에서 `Alt+Shift+S` 입력 시 `POST /v1/jobs` 호출
- [ ] `POST /v1/jobs` 요청에 영상 바이너리 없이 `provider`, `video_id`, `duration_ms`만 포함
- [ ] 처리 중 영상에서 `Alt+Shift+S`를 다시 눌러도 중복 작업이 생성되지 않음
- [ ] 작업 생성 후 `queued` 또는 `processing` 표시
- [ ] 진행률이 이전 값보다 감소하지 않음
- [ ] `retry_after_ms`에 맞춰 폴링
- [ ] ETA `null` 응답에서도 UI 오류 없음
- [ ] 패널을 닫았다 열어도 `job_id` 추적 복원
- [ ] 완료 후 manifest ID와 revision 일치
- [ ] 잘못된 manifest가 `invalid_response`로 거부됨
- [ ] WAV 실패 시 원본 볼륨과 영상 상태 복구
