# 들리는 화면 (Voice Bridge)

이 디렉터리는 사전 처리된 화면해설 manifest와 WAV 클립을 백엔드가 제공하고, Chrome 확장프로그램이 YouTube 영상 시간에 맞춰 재생하는 POC입니다.

> 구현 기준은 `../VOICE_BRIDGE_개발분담_연동규격_v1.2.docx`입니다. 신규 연동은 `/v1` API를 사용합니다. 기존 `/session/*` API는 초기 실시간 캡처 데모와의 호환을 위해 남겨 둔 경로이며, 최종 구조의 기본 경로가 아닙니다.
>
> 실제 크롬 확장프로그램 구현은 저장소 루트의 `../../VOICE_BRIDGE_FE_GITHUB_UPLOAD_v0.1.0/`이며, 이 백엔드의 API/manifest/JobStatus 응답은 그 저장소의 `contracts/*.schema.json`을 기준으로 검증합니다(`docs/BACKEND_INTEGRATION.md` 참고). `sound/extension/`은 더 단순한 초기 버전입니다.

## 최종 구조

```text
로컬 mp4 (또는 pipeline/fetch_youtube.py 로 유튜브에서 받은 mp4)
  -> pipeline/build_manifest.py  (M1~M5: 전사 -> 무음 구간 -> OCR/서술 -> TTS)
  -> manifest JSON + 길이 검증된 WAV 클립
  -> backend/data 에 원자적으로 게시
  -> Flask /v1 API (manifest, job 상태, immutable audio)
  -> Chrome Service Worker (조회·검증·캐시)
  -> Offscreen Audio Engine (클립 재생)
  -> Content Script (YouTube 시간 동기화·더킹)
  -> Side Panel (켜기/끄기·상태·오류)
```

핵심 원칙은 다음과 같습니다.

- 브라우저는 영상 프레임이나 원본 오디오를 서버에 계속 업로드하지 않습니다.
- 백엔드는 브라우저가 추가 편집 없이 재생할 수 있는 manifest와 실제 WAV 클립을 준비합니다.
- 공개 API의 시간은 모두 정수 밀리초(`*_ms`)입니다.
- WAV 파일명과 URL에는 파일 내용의 SHA-256을 사용합니다. 한 번 공개한 클립은 immutable입니다.
- 확장프로그램은 현재 영상의 `provider`, `video_id`, `duration_ms`, manifest `revision`을 확인하고 지난 장면의 늦은 해설은 재생하지 않습니다.
- `/v1`은 사전 등록된 영상만 조회합니다. 임의 URL을 요청 시점에 대신 수집하지 않습니다 — 다운로드와 생성은 아래 3장의 사전 처리 단계에서만 일어납니다.

## 디렉터리

```text
sound/
  backend/
    app.py
    config.py
    pyproject.toml / uv.lock
    .env.example
    api/
      v1.py            # 공개 API: manifest, jobs, audio (읽기 전용)
      dev.py            # 로컬 전용: URL 하나로 등록+처리 (/dev/process)
    core/
      contracts.py      # manifest 스키마 검증
      storage.py        # catalog/manifest/audio/job 파일 저장소
      silence.py, session.py, audio_stream.py, narrator.py   # 구형 /session 실시간 캡처용
    pipeline/           # M1~M5 사전 처리 오케스트레이터 (BE-02~BE-06)
      gaps.py           # M2: 배치 무음 구간 산출
      media.py          # M1: 오디오 추출 + gap 프레임 캡처
      narrate.py        # M3+M4: OCR 우선, VLM 보조 서술 결정
      tts.py            # M5: 고정 음성 합성 + 포맷 강제 변환
      fetch_youtube.py  # 유튜브 -> 로컬 mp4 다운로드
      subtitle.py        # 검수용 SRT 내보내기
      build_manifest.py  # 위 전부를 묶는 CLI 진입점
    adapters/
      base.py            # transcribe/read_text/describe/speak 인터페이스
      openai_adapter.py  # OpenAI 참조 구현
    data/
      catalog.json
      manifests/
        youtube/
          abc123.json
      audio/
        <64자리-sha256>.wav
      jobs/                    # 서버가 런타임에 생성·갱신
    runs/                # 파이프라인 실행마다 남는 중간 산출물 + 로그 (data/ 와 분리, /v1 이 조회 안 함)
      youtube/
        abc123/
          r1/
            audio.wav, frames/, segments.json, ocr.json, script.json, pipeline.log
    static/
      test.html          # /v1·/dev API 수동 테스트 페이지
    tests/               # pytest — contracts, storage, v1 API, pipeline
  extension/
    manifest.json
    background.js
    content.js
    offscreen.html
    offscreen.js
    sidepanel.html
    sidepanel.js
```

`VOICE_BRIDGE_DATA_DIR`를 설정하지 않으면 `backend/data`가 기본 데이터 디렉터리입니다. `VOICE_BRIDGE_RUNS_DIR`를
설정하지 않으면 `backend/runs`가 기본 위치입니다(3.2의 "중간 산출물과 로그" 참고).

## 0. 요구 사항

- Python 3.11 이상(권장: 3.11 또는 3.12; 이 저장소의 `.venv`는 3.14로 검증되어 있습니다)
- [uv](https://docs.astral.sh/uv/) (권장 — 아래 모든 명령이 uv 기준입니다). 없으면 `pip install uv`.
- ffmpeg — 별도 설치가 필요 없습니다. `imageio-ffmpeg` 패키지가 바이너리를 내려받아 `pipeline/`, `pipeline/fetch_youtube.py`(유튜브 다운로드 병합)가 그대로 사용합니다.
- Chrome 114 이상 (확장프로그램용)
- OpenAI API 키 — `/v1`이 이미 게시된 manifest/audio만 조회하는 것은 키 없이도 됩니다. **사전 처리 파이프라인(`pipeline/`), `/dev/process`, 구형 `/session` 데모는 키가 필요**합니다.

## 1. Backend 설치

```powershell
cd C:\Users\Lamed\Documents\GitHub\Audio_brige\dev\sound\backend

uv sync                # .venv 생성 + 의존성 설치
uv sync --group dev    # pytest 까지 포함해서 테스트도 돌리려면
```

`uv run <command>` 는 이 `.venv` 를 자동으로 쓰므로 따로 activate 하지 않아도 됩니다. pip를 직접 쓰고 싶다면 `python -m venv .venv` 후 `pip install -e .`로 대체할 수 있습니다.

## 2. 환경변수

`.env.example`을 `.env`로 복사한 뒤 필요한 값만 설정합니다.

```powershell
Copy-Item .env.example .env
```

```dotenv
# 정적 /v1 데이터. 비워 두면 backend/data
VOICE_BRIDGE_DATA_DIR=./data
# 파이프라인 실행마다 남는 중간 산출물+로그. 비워 두면 backend/runs
VOICE_BRIDGE_RUNS_DIR=./runs
VOICE_BRIDGE_RETRY_AFTER_MS=1500
VOICE_BRIDGE_MAX_REQUEST_BYTES=16777216
VOICE_BRIDGE_ENABLE_LEGACY_SESSION_API=false

# /dev/process (URL 하나로 등록+처리)를 켤지 여부. 로컬 개발 기본값은 true.
# 127.0.0.1 밖으로 서버를 노출한다면 반드시 false로.
VOICE_BRIDGE_ENABLE_DEV_PIPELINE_API=true

# 쉼표로 구분한 허용 Origin. 실제 확장 ID를 사용
VOICE_BRIDGE_CORS_ORIGINS=chrome-extension://<extension-id>

# 공개 manifest voice 메타데이터 (voice.voice_id 필드에 그대로 들어간다)
VOICE_BRIDGE_VOICE_ID=ko-KR-poc

# 사전 처리 파이프라인, /dev/process, 구형 /session 호환 기능에서만 필요
OPENAI_API_KEY=
OPENAI_TRANSCRIBE_MODEL=whisper-1
OPENAI_VISION_MODEL=gpt-4o-mini
OPENAI_TTS_MODEL=tts-1
OPENAI_TTS_VOICE=onyx
NARRATION_MODE_DEFAULT=tts
```

- 사전 생성한 manifest와 audio를 조회하는 `/v1` 정적 제공 기능은 OpenAI 키 없이도 사용할 수 있습니다.
- `VOICE_BRIDGE_DATA_DIR`에는 절대 또는 상대 경로를 사용할 수 있습니다. 실행 위치 차이로 인한 혼동을 피하려면 배포 환경에서는 절대 경로를 권장합니다.
- 확장 ID는 `chrome://extensions`에서 확인합니다. 확장을 다시 로드해 ID가 바뀌면 CORS 값도 갱신합니다.
- **`.env` 자체는 절대 커밋하지 마세요.** 실제 키를 저장소나 문서에 넣지 마세요 — `.env.example`은 항상 빈 값이어야 합니다.

## 3. 사전 처리: manifest + audio 만들기

`/v1`은 읽기 전용입니다. manifest와 clip은 아래 방법 중 하나로 먼저 만들어 게시해야 `/v1/manifests`, `/v1/jobs`가 실제 결과를 돌려줍니다.

### 3.1 가장 빠른 방법 — URL 하나로 (`/dev/process`, 로컬 전용)

`backend/static/test.html`의 "URL로 자동 등록 + 처리" 칸에 유튜브 URL이나 video_id를 붙여넣거나, 직접 호출합니다.

```powershell
curl.exe -i -X POST http://127.0.0.1:8000/dev/process `
  -H "Content-Type: application/json" `
  --data-raw "{`"provider`":`"youtube`",`"video_id`":`"abc123`"}"
```

이 한 번의 요청이 다음을 전부 처리합니다: 유튜브에서 mp4 다운로드 -> 실제 길이 측정 -> `catalog.json`에 자동 등록/갱신 -> M1~M5 파이프라인 실행 -> manifest/audio 게시. 완료되면 즉시 `/v1/manifests/{provider}/{video_id}`가 200을 돌려줍니다.

주의할 점:

- **`/v1`이 아닙니다.** 공개 API는 임의 URL을 절대 대신 수집하지 않는다는 원칙을 지키기 위해, 이 엔드포인트는 `api/v1.py`가 아니라 별도의 `api/dev.py`에 있고 `/dev/*` 경로를 씁니다.
- 실제 다운로드와 과금 API(전사·OCR/서술·TTS)를 호출하므로 영상 길이에 따라 수십 초~수 분이 걸립니다.
- `VOICE_BRIDGE_ENABLE_DEV_PIPELINE_API=false`로 끌 수 있고, 이 서버를 `127.0.0.1` 밖에 노출할 계획이면 반드시 꺼야 합니다.
- 이 도구를 실행하는 사람이 해당 영상을 처리할 권리가 있는지 스스로 확인해야 합니다 — POC 원칙(권리 확인된 영상만 처리)은 여전히 유효하고, 이 엔드포인트가 그 판단을 대신해 주지 않습니다.
- 유튜브가 403/포맷 오류를 준다면 대개 yt-dlp가 오래됐거나 해당 영상이 로그인을 요구하는 경우입니다. `uv sync -U`로 yt-dlp를 올려보세요.
- **이미 처리된 영상은 자동으로 재처리를 건너뜁니다.** 같은 `provider`+`video_id`에 게시된 manifest가 이미 있으면 다운로드도, 어댑터 호출(과금 API)도 하지 않고 그 자리에서 `{"skipped_reprocessing": true, ...}`를 바로 돌려줍니다 — manifest 파일 자체가 "이미 처리됨" 기록이라 별도 DB가 필요 없습니다. 새 revision을 강제로 만들려면 요청 본문에 `"force": true`를 추가합니다.

### 3.2 CLI로 직접 실행 (`pipeline/build_manifest.py`)

로컬 mp4가 이미 있다면:

```powershell
uv run python -m pipeline.build_manifest `
  --provider youtube --video-id abc123 --video .\input.mp4 `
  --srt-out .\check.srt
```

`--video`를 생략하고 `--provider youtube`만 주면 `video_id`로 자동 다운로드합니다:

```powershell
uv run python -m pipeline.build_manifest --provider youtube --video-id abc123
```

장애인이든 비장애인이든 영상을 미리 목록에 올려 두고 보는 게 아니라 한 편씩 봅니다 — 그래서 이 CLI도
`/dev/process`처럼 처음 보는 `video_id`는 실측 길이로 그 자리에서 자동 등록하고 바로 처리합니다.
`data/catalog.json`을 미리 손으로 채워 둘 필요가 없습니다. 이미 등록된 영상을 다시 처리할 때는(예: 새
revision을 만들 때) 실측 길이가 등록값과 1,000ms 넘게 다르면 실패합니다 — 등록값 자체가 잘못됐다는
뜻이므로 catalog.json을 고치거나 `duration_ms`를 다시 확인하세요.

`--srt-out`은 원본 대사와 새로 만든 화면해설을 시간순으로 합친 검수용 SRT를 저장합니다(공개 API로 서비스되지 않는 로컬 QA 파일입니다).

성공하면 `revision`을 하나 올려 manifest를 새로 게시합니다. 실패한 gap은 조용히 skip되며(대사 침범 위험이 있는 것보다 안전), 요약에 `gap 몇 개 중 몇 개 게시·몇 개 skip`으로 표시됩니다.

#### 중간 산출물과 로그 (`runs/`)

`/dev/process`와 CLI 둘 다, 실행할 때마다 `PIPELINE_RUNS_DIR`(기본 `backend/runs/`, `VOICE_BRIDGE_RUNS_DIR`로 변경 가능) 아래에
`{provider}/{video_id}/r{revision}/` 작업 디렉터리를 남깁니다. manifest의 `revision`과 폴더 이름이 그대로 대응합니다.

```text
runs/youtube/abc123/r1/
  audio.wav        M1: 추출한 전체 오디오
  frames/*.jpg       M1: gap 프레임 (초당 시작·중간·끝)
  segments.json        M2: 전사 결과 + 확정된 무음 구간
  ocr.json               M3: 프레임마다 시도한 OCR 결과 전부 (채택 여부와 무관하게)
  script.json               M4: gap별 최종 판단 — 게시됐으면 어떤 텍스트/출처로, skip됐으면 왜(`skip_reason`)
  pipeline.log               이 실행의 로그 (콘솔에 찍히는 것과 같은 내용)
```

무음 구간만 계산하고 결과가 안 보이던 문제(로그가 안 남고, 실제로 무엇을 보고 왜 그렇게 판단했는지 알 수 없던 것)를
해결하려고 만든 디렉터리입니다 — `script.json`을 보면 매 gap이 왜 게시됐는지/왜 skip됐는지(`no_frames`, `no_candidate`,
`duplicate`, `tts_overflow_ocr`, `tts_overflow_unshrinkable`) 바로 알 수 있습니다. `data/`와 분리되어 있어 `/v1`이
절대 조회하지 않으므로 원본 프레임·오디오가 공개될 위험이 없고, 원본 영상마다 계속 쌓이므로 디스크 정리는 운영자가
직접 해야 합니다(오래된 revision의 run은 지워도 이미 게시된 manifest/clip에는 영향이 없습니다).

#### Vision API 호출 시 이미지 축소 (비용 절감)

`runs/.../frames/*.jpg`에는 캡처한 원본 화질 그대로 저장하지만, M3(OCR)·M4(서술) 단계에서 OpenAI
비전 모델(`OPENAI_VISION_MODEL`)을 호출할 때는 `adapters/openai_adapter.py`의 `_encode_image()`가
매번 이미지를 메모리에서만 축소·재압축해서 보냅니다 — 디스크의 원본 파일은 건드리지 않습니다.

- `config.VISION_MAX_DIMENSION_PX`(기본 1280px): 긴 변이 이보다 크면 비율 유지한 채 줄입니다. 이보다 작은 프레임은 확대하지 않습니다.
- `config.VISION_JPEG_QUALITY`(기본 82): JPEG 재압축 품질.

비전 모델은 해상도에 비례해 타일 단위로 과금하므로, 인식 정확도에 지장 없는 선까지만 화질을 낮추면
입력 토큰 비용이 줄어듭니다. 두 값 모두 환경변수가 아니라 `config.py`의 상수이므로 바꾸려면 코드를
직접 수정합니다.

#### 유사 프레임 스킵 (API 호출 횟수 절감)

위 항목이 프레임 1장당 페이로드를 줄이는 것이라면, 이건 애초에 보내는 프레임 수 자체를 줄입니다.
`capture_gap_frames`가 gap 안에서 초당 3장씩 찍다 보니 화면이 안 바뀌는 구간(정지 화면, 멈춘 장면)은
사실상 같은 그림을 여러 장 중복으로 캡처합니다. `pipeline/narrate.py`의 `decide()`는 OCR/서술 후보를
고르기 전에 `_dedupe_similar_frames()`로 시간순으로 훑으며, 직전에 채택한 프레임과 그레이스케일
평균 밝기 차이(`config.FRAME_SIMILARITY_DIFF_THRESHOLD`, 기본 0.02 = 2%)가 이 값 미만인 프레임을
API 호출 대상에서 제외합니다. 실제 화면 변화가 있는 프레임은 값이 threshold를 넘으므로 그대로
남습니다 — 정지 구간만 골라서 줄이는 방식입니다.

### 3.3 수동으로 직접 만들기 (파이프라인 없이)

다른 파이프라인이나 사람이 직접 클립을 만드는 경우를 위한 정확한 스키마 참고용입니다.

#### Catalog

`backend/data/catalog.json`은 서버가 처리하거나 제공할 수 있는 영상의 허용 목록입니다. 원본 URL을 넣지 않고 `provider + video_id`를 사용합니다.

```json
{
  "schema_version": "1.1",
  "videos": [
    {
      "provider": "youtube",
      "video_id": "abc123",
      "duration_ms": 512400,
      "enabled": true
    }
  ]
}
```

- `video_id`는 YouTube URL의 `v` 값과 정확히 같아야 합니다.
- `duration_ms`는 실제 영상 길이와 1,000ms보다 많이 차이 나면 안 됩니다.
- `enabled: false`인 영상은 제공·생성 대상에서 제외합니다.
- Manifest 경로는 catalog에 쓰지 않습니다. 서버가 `manifests/{provider}/{video_id}.json` 규칙으로 찾습니다.

#### WAV 클립

공개 클립은 WAV PCM 16-bit, mono, 24kHz **여야 합니다** (`pipeline/tts.py`가 이 포맷을 강제로 재인코딩합니다; 직접 만든다면 같은 포맷을 맞춰야 `core.storage`의 실측 검증을 통과합니다). 각 클립의 실제 길이는 아래 재생 모드별 상한(`deadline_ms - trigger_ms` 또는 `max_extended_duration_ms`) 이하여야 합니다.

```powershell
$clipHash = (Get-FileHash -Algorithm SHA256 .\prepared\seg-001.wav).Hash.ToLowerInvariant()
Copy-Item .\prepared\seg-001.wav ".\data\audio\$clipHash.wav"
```

#### Public manifest — schema v1.1 (연동규격 v1.2)

Manifest는 `backend/data/manifests/youtube/abc123.json`에 둡니다. **v1.0에서 v1.1로 스키마가 바뀌었습니다** — segment가 `start_ms/end_ms`(항상 영상을 계속 재생) 대신 `mode`(`overlay`|`extended`) + `trigger_ms` + (overlay만) `deadline_ms`를 씁니다. `overlay`는 자연스러운 공백에 원본을 계속 재생하며 더킹하고, `extended`는 정보가 중요한데 공백이 부족할 때 영상을 잠시 멈추고 해설합니다.

```json
{
  "schema_version": "1.1",
  "manifest_id": "youtube:abc123:r1",
  "revision": 1,
  "video": { "provider": "youtube", "video_id": "abc123", "duration_ms": 512400 },
  "voice": { "voice_id": "ko-KR-poc", "format": "audio/wav", "sample_rate_hz": 24000 },
  "playback": {
    "duck_factor": 0.35,
    "preload_count": 3,
    "lookahead_ms": 500,
    "late_tolerance_ms": 250,
    "auto_pause_default": true,
    "max_extended_duration_ms": 8000,
    "min_extended_interval_ms": 15000
  },
  "segments": [
    {
      "id": "seg-001",
      "mode": "overlay",
      "trigger_ms": 12400,
      "deadline_ms": 16200,
      "text": "화면에 표, 3분기 매출 3억",
      "importance": "normal",
      "source": "ocr",
      "confidence": "high",
      "audio": {
        "path": "/v1/audio/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.wav",
        "duration_ms": 3110,
        "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      }
    },
    {
      "id": "seg-002",
      "mode": "extended",
      "trigger_ms": 32800,
      "text": "강사가 표의 붉은 막대를 가리킨다",
      "importance": "high",
      "source": "vlm",
      "confidence": "high",
      "audio": {
        "path": "/v1/audio/a174c8a174c8a174c8a174c8a174c8a174c8a174c8a174c8a174c8a174c8a1.wav",
        "duration_ms": 4380,
        "sha256": "a174c8a174c8a174c8a174c8a174c8a174c8a174c8a174c8a174c8a174c8a1"
      }
    }
  ]
}
```

체크리스트:

- `manifest_id`는 `{provider}:{video_id}:r{revision}` 형식입니다.
- Segment는 `trigger_ms` 오름차순이며, 이전 세그먼트의 점유 구간(overlay는 `deadline_ms`, extended는 `trigger_ms + audio.duration_ms`)과 겹치면 안 됩니다.
- `mode`가 `overlay`면 `deadline_ms`가 **필수**이고 `audio.duration_ms <= deadline_ms - trigger_ms`여야 합니다. `mode`가 `extended`면 `deadline_ms`를 아예 넣지 않고, `importance`는 반드시 `high`이며, `audio.duration_ms <= playback.max_extended_duration_ms`, 그리고 이전 extended 세그먼트와 `trigger_ms` 간격이 `playback.min_extended_interval_ms` 이상이어야 합니다.
- `importance`는 `normal` 또는 `high`입니다.
- 공개 segment의 `source`는 `ocr` 또는 `vlm`, `confidence`는 `high`입니다. `skip` 항목은 공개 manifest에 넣지 않습니다.
- `audio.path`는 `/v1/audio/{audio.sha256}.wav`와 정확히 같아야 합니다.
- `audio.sha256`은 64자리 소문자 SHA-256이고 실제 파일 내용과 일치해야 합니다.
- 같은 영상을 다시 생성하면 기존 결과를 덮어쓴 것으로 숨기지 말고 `revision`을 올립니다.
- 파일을 직접 놓는 대신, `core.storage.FileRepository.publish_manifest()` / `publish_audio()`를 코드에서 호출하면 이 검증을 전부 대신 해 주고 원자적으로 씁니다 — `pipeline/build_manifest.py`가 실제로 이렇게 합니다.

**스키마가 breaking change라 v1.0으로 게시된 기존 manifest는 더 이상 유효하지 않습니다.** `backend/data/manifests/`에 이미 있는 결과가 있다면 3.1/3.2의 방법으로 다시 처리해서 v1.1로 재게시해야 `/v1/manifests`가 다시 200을 돌려줍니다.

#### M5: overlay/extended/skip 판정 (연동규격 4.2)

`pipeline/build_manifest.py`가 gap마다 다음 순서로 재생 모드를 정합니다:

1. **overlay**: 합성된 해설 음성 길이가 `gap 길이(natural_window_ms) - config.MODE_SAFETY_MARGIN_MS`(기본 300ms) 이내면 자연 공백에 넣습니다. 영상은 멈추지 않고 원본 볼륨만 낮춥니다.
2. **extended**: overlay 조건을 못 채웠고, `importance == "high"`이며, 길이가 `config.MAX_EXTENDED_DURATION_MS`(8,000ms) 이하이고, 직전 extended 세그먼트와의 간격이 `config.MIN_EXTENDED_INTERVAL_MS`(15,000ms) 이상이면 영상을 잠시 멈추고 해설합니다.
3. 소스가 `vlm`이면 M4 축약(`_shrink_and_resynthesize`)으로 한 번 더 짧게 다시 만들어 1·2를 재시도합니다. OCR 원문은 요약하지 않으므로(6.4) 바로 3번으로 못 갑니다.
4. 그래도 안 되면 skip합니다 (`tts_overflow_ocr` 또는 `tts_overflow_unshrinkable`로 `script.json`에 기록).

`importance`는 연동규격 6.1 예시와 동일한 POC 휴리스틱을 씁니다: **VLM 서술(화면을 보고 새로 생성한 설명, 대사가 다루지 않는 정보)은 `high`, OCR 원문(화면 텍스트를 그대로 읽은 것, 보조 정보)은 `normal`**입니다. 장면·문장 경계 판정(`pause_eligible`)은 별도로 만들지 않았습니다 — gap 자체가 이미 확정된 무음 구간(발화와 발화 사이)이라 구조적으로 안전한 pause 지점이라고 보고, 모든 gap을 pause 가능한 것으로 취급합니다.

## 4. Backend 실행

```powershell
cd C:\Users\Lamed\Documents\GitHub\Audio_brige\dev\sound\backend
uv run python app.py
```

기본 주소는 `http://127.0.0.1:8000`입니다. 개발 서버가 외부 인터페이스에 공개되지 않도록 기본 host를 그대로 사용하세요.

테스트를 돌리려면:

```powershell
uv run pytest
```

## 5. curl smoke checks

PowerShell의 `curl` 별칭과 혼동하지 않도록 `curl.exe`를 사용합니다.

```powershell
# 1) 서버와 data 디렉터리 상태
curl.exe -i http://127.0.0.1:8000/v1/health

# 2) 준비된 manifest
curl.exe -i http://127.0.0.1:8000/v1/manifests/youtube/abc123

# 3) 등록 영상의 생성/준비 작업 요청 (manifest 가 이미 있으면 즉시 ready)
curl.exe -i -X POST http://127.0.0.1:8000/v1/jobs `
  -H "Content-Type: application/json" `
  --data-raw "{`"provider`":`"youtube`",`"video_id`":`"abc123`",`"duration_ms`":512400}"

# 4) 위 응답의 job_id로 상태 확인
curl.exe -i http://127.0.0.1:8000/v1/jobs/<job_id>

# 5) manifest에 기록한 실제 SHA-256으로 WAV 확인
curl.exe -i -o NUL http://127.0.0.1:8000/v1/audio/<64자리-sha256>.wav
```

기대 결과:

- Health: HTTP `200`, `schema_version: "1.1"`
- 준비된 manifest: HTTP `200`과 schema `1.1` JSON
- `POST /v1/jobs` 응답은 연동규격 6.2 그대로 상황별로 다릅니다: 신규 생성이면 `202`, manifest가 이미 있으면(즉시 준비) `200`, **같은 영상에 이미 진행 중인 job이 있으면 `409`**입니다. 세 경우 모두 같은 JobStatus 본문(`job_id`, `status`, `video_key`, 진행 중이면 `stage`/`progress_percent`/`eta_seconds`/`eta_confidence`/`retry_after_ms`, ready면 `manifest_path`/`manifest_id`/`revision`)을 돌려줍니다.
- 등록됐지만 manifest와 활성 job이 아직 없는 영상: manifest 조회 HTTP `404` (`POST /v1/jobs` 후에는 `202`, 실제로 manifest를 만들려면 3장의 파이프라인을 돌려야 합니다)
- 미등록·비활성 영상: HTTP `404`
- Manifest가 이미 배치된 영상에 대한 job 요청: `ready` 상태와 `manifest_path`, `progress_percent: 100`
- 준비된 audio: HTTP `200`, `Content-Type: audio/wav`, immutable cache 헤더

Manifest가 `200`이어도 확장프로그램은 현재 YouTube 영상의 ID와 길이를 다시 확인합니다. 길이가 1,000ms보다 많이 다르거나 manifest가 잘못된 경우 안전상 전체 화면해설을 재생하지 않습니다.

#### 작업 진행률 실시간 확인 (연동규격 6.3)

`/dev/process`로 **이미 catalog에 등록된** video_id를 처리하면, 파이프라인이 실행되는 동안 실시간으로 갱신되는 job이 함께 만들어집니다. 같은 서버에 다른 요청으로 `GET /v1/jobs/{job_id}`를 폴링하면 `stage`(`media_preparation` → `audio_analysis` → `visual_analysis`/`description_generation`/`speech_synthesis` 반복 → `validation`)와 `progress_percent`(0~99, 감소하지 않음), 대략적인 `eta_seconds`/`eta_confidence`가 진행 중에 실제로 바뀌는 것을 볼 수 있습니다. **처음 보는 video_id**(아직 catalog에 없음)는 이 진행률 연결이 없습니다 — duration_ms를 실측해야 등록할 수 있어서 처리 전에는 job을 만들 근거가 없기 때문입니다.

`POST /v1/jobs`는 여전히 이 실행을 직접 트리거하지 않습니다 — manifest가 실제로 생기는지 그때그때 확인하는 수동적인 상태 조회 엔드포인트입니다(연동규격의 "임의 URL 수집 금지" POC 원칙과 동일하게, 실제 다운로드·과금 API 호출은 `/dev/process`나 CLI에서만 일어납니다). `POST /v1/jobs`로 먼저 job_id를 받아 두고, 별도로 `/dev/process`나 CLI를 실행해 실제 처리를 시작하면 그 job_id로 진행 상황을 볼 수 있습니다.

## 6. 테스트 페이지 (`backend/static/test.html`)

Backend를 띄운 뒤 `http://127.0.0.1:8000/static/test.html`을 열면 확장프로그램 없이 백엔드를 점검할 수 있습니다.

- **0. 백엔드 상태** — `/v1/health`.
- **0.5 URL로 자동 등록 + 처리** — 3.1의 `/dev/process`를 붙여넣기 UI로. 완료되면 아래 입력칸을 자동으로 채웁니다.
- **1. 작업 요청 · 상태 확인** — `POST /v1/jobs` 후 `retry_after_ms` 간격으로 `GET /v1/jobs/{id}`를 자동 재조회합니다.
- **2. Manifest 조회** — `GET /v1/manifests/{provider}/{video_id}`, segment 표와 클립별 재생 버튼을 보여줍니다.
- **3. 재생 시뮬레이션** — 로컬 영상 파일을 골라 재생하면서, `timeupdate` 기준으로 manifest segment 구간에 들어설 때마다 클립을 재생하고 `duck_factor`만큼 원본 볼륨을 낮춥니다(seek 시 지난 세그먼트 재생 방지 포함). 익스텐션의 Scheduler/Ducking Controller를 단순화한 버전이며, preload·lookahead 예약은 하지 않습니다 — 실제 동기화 정밀도 확인은 익스텐션으로 해야 합니다.

같은 provider/video_id, 비슷한 길이의 로컬 파일을 골라야 재생 시뮬레이션의 시간이 실제로 맞습니다.

## 7. Chrome 확장프로그램 로드

1. Backend를 `http://127.0.0.1:8000`에서 실행합니다.
2. Chrome에서 `chrome://extensions`를 엽니다.
3. 오른쪽 위 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 누릅니다.
5. `C:\Users\Lamed\Documents\GitHub\Audio_brige\dev\sound\extension`을 선택합니다.
6. 표시된 확장 ID를 `.env`의 `VOICE_BRIDGE_CORS_ORIGINS`에 반영하고 Backend를 재시작합니다.
7. Catalog와 manifest에 등록한 `https://www.youtube.com/watch?v=<video_id>` 영상을 엽니다.
8. Chrome 도구 모음의 **들리는 화면** 아이콘을 눌러 Side Panel을 엽니다.
9. Side Panel에서 화면해설을 켜고 `준비됨`, `처리 중`, `오류` 상태를 확인합니다.
10. 영상의 재생·일시정지·탐색·배속·볼륨을 조작해 동기화와 원본 볼륨 복구를 확인합니다.

확장 코드나 manifest를 바꾼 뒤에는 `chrome://extensions`에서 **새로고침**하고 YouTube 탭도 다시 로드합니다.

### Side Panel 동작 기준

- 현재 영상과 manifest가 일치할 때만 재생합니다.
- 다음 3개 클립을 preload하고, 시작 500ms 전부터 예약할 수 있습니다.
- 시작 시점에서 250ms보다 늦어진 해설은 재생하지 않습니다.
- pause/seek/페이지 이동/video 변경/오류/기능 끄기 시 현재 클립을 중단하고 원본 볼륨을 복구합니다.
- 원본 영상이 muted이면 POC에서는 화면해설도 재생하지 않습니다.
- API나 clip에 문제가 생겨도 원본 YouTube 재생은 계속되고, 화면해설만 건너뜁니다.

## 8. 기존 `/session` 호환 경로

이 경로는 보안과 API 과금 위험 때문에 **기본 비활성화**되어 있습니다. 로컬에서
초기 캡처 실험을 재현할 때만 `.env`의
`VOICE_BRIDGE_ENABLE_LEGACY_SESSION_API=true`로 설정하고 Backend를 재시작하세요.

```text
POST /session/start
POST /session/{session_id}/frame
POST /session/{session_id}/audio
GET  /session/{session_id}/narrations
GET  /session/{session_id}/clip/{filename}
POST /session/{session_id}/stop
```

이 경로는 탭 캡처, frame/audio multipart 업로드, polling을 사용합니다. 신규 Chrome 확장 연동이나 데모 데이터 준비에는 `/v1/manifests`, `/v1/jobs`, `/v1/audio`(또는 이를 채워 주는 `pipeline/`·`/dev/process`)를 사용하세요. `/session` 응답을 새 manifest 형식으로 간주하면 안 됩니다.

## 문제 해결

### Python 또는 가상환경 오류

- `uv run python --version`이 3.11+인지 확인합니다.
- `uv sync`가 실패하면 `.venv`를 지우고(`Remove-Item -Recurse -Force .venv`) 다시 `uv sync`를 시도합니다.

### Manifest 404/202

- `catalog.json`의 `provider`, `video_id`, `enabled`를 확인합니다.
- Manifest 파일 경로가 `data/manifests/{provider}/{video_id}.json`인지 확인합니다.
- `VOICE_BRIDGE_DATA_DIR`가 다른 디렉터리를 가리키지 않는지 확인합니다.
- `202`이면 응답의 `retry_after_ms` 이후 `/v1/jobs/{job_id}`를 조회합니다.
- 등록만 되어 있고 manifest가 없다면(`202`도 아니고 `404`), 3장의 방법으로 실제로 처리를 실행해야 합니다 — job을 만드는 것과 manifest를 생성하는 것은 별개입니다.

### Manifest invalid

- 모든 시간이 정수 ms인지 확인합니다.
- `manifest_id`, revision, 영상 길이, segment 정렬·겹침을 확인합니다.
- WAV 길이와 `audio.duration_ms`, 실제 SHA-256, `audio.path`를 확인합니다.
- 공개 manifest에서 `skip`, `low` confidence 항목을 제거합니다.
- 직접 파일을 놓지 말고 `FileRepository.publish_manifest()`(또는 `pipeline/build_manifest.py`)를 쓰면 이 검증을 자동으로 통과한 것만 게시됩니다.

### `/dev/process` 실패

- `DOWNLOAD_FAILED` + `HTTP Error 403`: 대개 yt-dlp가 오래됐거나(`uv sync -U`) 로그인이 필요한 영상입니다.
- `DOWNLOAD_FAILED` + ffmpeg 관련 메시지: `pipeline/fetch_youtube.py`가 `imageio_ffmpeg` 바이너리를 자동으로 넘겨주므로 보통 안 나야 정상입니다 — 나온다면 `uv sync`로 `imageio-ffmpeg`가 실제로 설치됐는지 확인하세요.
- `ADAPTER_UNAVAILABLE`: `.env`의 `OPENAI_API_KEY`를 확인하고 Backend를 재시작합니다.
- `PIPELINE_FAILED`: 응답 메시지에 원인이 그대로 들어 있습니다(길이 불일치, 스키마 위반 등). 어느 gap이 왜
  실패/skip됐는지는 `runs/{provider}/{video_id}/r{revision}/script.json`과 `pipeline.log`에서 바로 확인할 수
  있습니다 — 실패해도 그 실행의 run 디렉터리는 지워지지 않습니다.

### Side Panel에서 Backend 연결 실패

- `/v1/health`가 먼저 성공하는지 확인합니다.
- 확장 설정의 API origin이 `http://127.0.0.1:8000`인지 확인합니다.
- `.env`의 `VOICE_BRIDGE_CORS_ORIGINS`에 현재 확장 ID가 있는지 확인합니다.
- `manifest.json`의 host permission과 확장을 다시 로드했는지 확인합니다.

## 비밀정보와 데이터 안전

- `.env`, API 키, 인증 토큰을 Git에 커밋하지 않습니다.
- Content Script나 Side Panel에 API 키를 넣지 않습니다.
- 원본 영상·원본 오디오·원본 프레임을 public data 디렉터리에서 제공하지 않습니다 — `pipeline/`이 남기는 `audio.wav`/`frames/`는 `data/`가 아니라 별도의 `runs/`에 저장되고, `/v1`은 `runs/`를 절대 조회하지 않습니다. `.gitignore`도 `runs/`를 제외해 커밋되지 않습니다.
- `runs/`는 디버깅·검수용이라 자동으로 정리되지 않습니다. 오래된 revision의 run(원본 프레임·오디오 포함)은 필요 없어지면 직접 지우세요 — 지워도 이미 게시된 manifest/clip에는 영향이 없습니다.
- `/dev/process`는 로컬 개발 전용입니다. `127.0.0.1` 밖으로 노출하지 말고, 필요 없으면 `VOICE_BRIDGE_ENABLE_DEV_PIPELINE_API=false`로 꺼 두세요.
- v1 API 자체의 로그에는 `request_id`, `video_key`, `revision`, `segment_id`만 남기고 토큰이나 원본 미디어를 남기지 않습니다. `runs/*/pipeline.log`는 성격이 달라서 서술 텍스트 자체를 남깁니다 — 디버깅 목적이므로 이 파일을 공개 위치에 두지 마세요.
