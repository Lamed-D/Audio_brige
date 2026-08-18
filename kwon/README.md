# 들리는 화면 MVP

유튜브 등 공개 영상 URL이나 로컬 영상 파일을 입력하면, 사람의 말이 없는 구간에서 중요한 화면 정보를 찾아 한국어 화면해설과 TTS를 생성하는 Streamlit 앱입니다.

## 새 처리 방식

```text
영상 입력 또는 URL 다운로드
  → 압축 오디오 추출
  → 2분 단위 OpenAI STT 병렬 처리
  → 무발화 구간 계산
  → 구간당 후보 프레임 7장 캡처
  → 장면 변화 기반 핵심 프레임 3~4장 선택
  → 최대 3개 Vision 요청 병렬 처리
  → 불확실한 결과만 정밀 모델로 재분석
  → OCR 교차 확인·환각 차단·중복 해설 제거
  → TTS 병렬 생성·길이 맞춤
  → SRT와 접근성 MP4 생성
```

중요한 원칙은 모든 빈 구간을 억지로 채우지 않는 것입니다. 화면 글자가 두 프레임 이상에서 확인되지 않거나 장면 설명이 불확실하면 자동으로 건너뜁니다.

## 빠른 실행

```powershell
cd C:\Users\lw105\OneDrive\문서\GitHub\Audio_brige\kwon
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
.\run_web.ps1
```

브라우저가 열리지 않으면 `http://localhost:8501`에 접속합니다.

자세한 설치와 사용법은 [사용설명서.md](사용설명서.md)를 확인하세요.

## 주요 설정

- 음성 인식: 기본 `OpenAI API (빠름)`, 필요할 때 로컬 Whisper 사용
- 빠른 Vision: 기본 `gpt-4o-mini`
- 정밀 Vision: 기본 `gpt-4o`, 어려운 구간에만 사용
- TTS: 기본 `gpt-4o-mini-tts`
- 핵심 프레임: 기본 구간당 최대 4장
- 병렬 분석: Vision 3개, TTS 3개
- 캐시: URL 다운로드와 음성 전사 결과 자동 재사용

## 결과 파일

```text
data/output/<job_id>/
├─ source.*
├─ speech_audio.mp3
├─ speech.srt
├─ accessible.srt
├─ segments.json
├─ frames/
├─ tts/
├─ script.json
├─ accessible_audio.m4a
├─ accessible_video.mp4
└─ result.json
```

`data/cache/`에는 다운로드 파일과 음성 전사 결과가 저장되며 Git에는 포함되지 않습니다.

## 테스트

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

## 제한 사항

- DRM, 비공개, 로그인 필요 영상은 URL로 처리할 수 없습니다.
- 유튜브 정책 또는 네트워크 상태에 따라 다운로드가 실패할 수 있습니다.
- 음악의 보컬이나 겹치는 말은 음성으로 탐지될 수 있습니다.
- 자동 검증을 통과하지 못한 장면은 안전을 위해 해설하지 않습니다.
- 배포 서비스가 아닌 로컬 MVP이며, 사용 권한이 있는 영상만 처리해야 합니다.
