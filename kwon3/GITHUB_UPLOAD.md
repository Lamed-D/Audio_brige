# 공유 GitHub 업로드

## 저장소가 프론트엔드 전용일 때

압축을 푼 폴더에서 실행합니다.

```powershell
git init
git add .
git commit -m "feat: add VOICE BRIDGE frontend POC"
git branch -M main
git remote add origin <공유 GitHub 저장소 URL>
git push -u origin main
```

원격 저장소에 README나 다른 커밋이 이미 있다면 위 방식으로 강제 push하지 않습니다. 아래 팀 저장소 방식을 사용합니다.

## 백엔드와 함께 쓰는 팀 저장소일 때

공유 저장소를 먼저 clone한 뒤 이 패키지의 내용물을 `frontend/voice-bridge-extension` 아래에 넣는 방식을 권장합니다.

```text
team-repository/
  backend/
  frontend/
    voice-bridge-extension/
      src/
      extension/
      contracts/
      docs/
      package.json
```

```powershell
git clone <공유 GitHub 저장소 URL>
cd <저장소 폴더>
git checkout -b feat/voice-bridge-frontend
git add frontend/voice-bridge-extension
git commit -m "feat: add VOICE BRIDGE Chrome extension"
git push -u origin feat/voice-bridge-frontend
```

이후 GitHub에서 PR을 열고 백엔드 담당자를 reviewer로 지정합니다.

## 업로드하면 안 되는 파일

- `node_modules/`
- `extension/*.js.map`
- `output/`
- `.env`와 API 키
- 로컬 테스트 캡처와 개인 경로가 포함된 임시 파일

위 항목은 `.gitignore`에 반영되어 있습니다. `extension/*.js`는 Chrome이 실행하는 운영 번들이므로 반드시 저장소에 포함합니다. `extension/manifest.json`, HTML, CSS, 아이콘, 데모 WAV도 함께 포함해야 합니다.

업로드 직전에 다음 명령으로 운영 번들과 필수 파일을 확인합니다.

```powershell
npm ci
npm run prepare:extension
```

## 업로드 후 팀원이 실행하는 명령

빌드된 `extension/*.js`가 저장소에 포함되어 있으므로 팀원은 clone 또는 GitHub ZIP 압축 해제 직후 `extension` 폴더를 Chrome에서 로드할 수 있습니다.

소스를 수정하는 팀원은 `npm ci`와 `npm run check`를 실행하고 Chrome 확장프로그램 관리 화면에서 다시 로드합니다. 백엔드 연결 규칙은 `docs/BACKEND_INTEGRATION.md`를 기준으로 확인합니다.
