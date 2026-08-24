# VOICE BRIDGE 협업 규칙

## 기본 브랜치

- `main`: 시연 가능한 상태만 유지합니다.
- 기능 브랜치: `feat/<topic>`
- 수정 브랜치: `fix/<topic>`
- 문서 브랜치: `docs/<topic>`

## 작업 전 확인

```powershell
npm ci
npm run check
```

PR을 열기 전에도 `npm run check`를 통과해야 합니다.

## FE/BE 계약 변경

API 응답이나 manifest 구조를 변경할 때 다음 파일을 한 PR에서 함께 수정합니다.

1. `contracts/*.schema.json`
2. `fixtures/*.json`
3. `src/shared/contracts/*.ts`
4. 관련 `*.test.ts`
5. `docs/BACKEND_INTEGRATION.md`

FE와 BE가 합의하기 전에는 `schema_version`, 상태명, stage명, 필수 필드 이름을 단독으로 변경하지 않습니다. 호환되지 않는 변경은 기존 버전을 덮어쓰지 않고 새 계약 버전으로 추가합니다.

## 커밋 권장 형식

```text
feat: load backend manifest into scheduler
fix: restore player volume after audio failure
docs: clarify job progress contract
test: add extended segment timing case
```

## PR 설명에 포함할 내용

- 변경 이유와 사용자 영향
- 변경된 계약 및 백엔드 영향
- 테스트 명령과 결과
- Chrome 수동 확인 내용
- 남은 위험 또는 후속 작업
