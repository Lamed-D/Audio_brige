# 폭염 대응 연결 엔진 — PRD v2 + AI/데이터 완전 통합본
## 실질 연결 가능성 계산 기반 폭염 취약계층 쉼터 운영 보조 시스템

**통합 기준**: `폭염_대응_연결_엔진_PRD_v2.docx` + 기존 `기획_AI데이터_완전통합본` + 2026-08-11 기준 최신 공개 데이터/AI-Hub 확인  
**POC 범위**: 서울 1개 자치구 · 가상 취약노인 프로필 · 공개/준공개 운영데이터 · 팀 자체 촬영 영상  
**핵심 산출물**: 실질 연결 지도 · 운영 조정 추천 · CV 현장 관측 데모  
**권장 개발 원칙**: `정적 데이터로 ①~④ → AI로 ⑤ 현장상태 보강 → 연결 엔진 → 지자체/돌봄기관 화면`

---

# 0. 이번 통합본에서 달라진 점

## 기존 방향에서 유지하는 것

다음은 PRD v2에서도 그대로 유지되므로 기존 기획을 살린다.

- **어르신용 앱이 아니라 지자체·돌봄기관용 시스템**
- 생활지원사/돌봄 인력이 **라스트 마일**
- 핵심 문제는 “쉼터가 어디 있나?”보다 **“지금 이 대상자가 실제로 이용할 수 있나?”**
- **시간 → 진입 → 냉방 → 도달 → 수용** 5개 필터
- 서울 1개 자치구 POC
- 실제 개인정보 대신 가상 대상자 사용
- 낙상/쓰러짐은 **Could**
- 실시간 API가 없어도 정적 데이터로 POC가 돌아가야 함

---

## PRD v2에서 명확해진 변화

### 변경 1. 제품 요구사항이 훨씬 구체화됨
PRD v2에서는 다음이 명시됐다.

- 목표/비목표
- 사용자별 핵심 질문
- F-01~F-10 기능 정의
- 인수 기준
- 성공 지표
- UX
- 기술 아키텍처
- 1박2일 구현 순서

→ 따라서 데이터도 **“있으면 좋은 데이터”가 아니라 각 F-ID에 직접 매핑**하는 방식으로 다시 정리한다.

---

### 변경 2. CV Must의 중심이 달라짐

기존 통합본에서는

```text
person
empty_seat
occupied_seat
```

를 핵심 Must처럼 제안했지만,

PRD v2의 F-06 Must는:

```text
사람 수
+
조도
+
활동 유무
→ 현장 상태 신호 / 닫힘 가능성
```

이다.

따라서 새 우선순위:

```text
사람 수 검출/카운팅     → MUST
현장 활동/조도 신호     → MUST
빈 좌석/점유좌석 검출   → SHOULD
낙상/실신               → COULD
```

로 조정한다.

### 이유
1박2일 POC에서는 빈 좌석 detector를 별도 학습하는 것보다 **사람 수 + 운영정보를 엔진에 붙이는 것**이 완성 가능성이 높다.

단, 서울시가 2026-08-10 이후 면적·이용가능인원 제공을 중단했기 때문에, **capacity가 없는 쉼터의 수용여력을 보강하는 차선책으로 빈 좌석 검출은 여전히 가치가 높다.**

---

### 변경 3. `도달`에 실제 도보 네트워크 데이터 추가

기존 데이터 계획에는 SGIS와 거리 중심이었지만 PRD F-05는 **5분 보행권**을 직접 요구한다.

따라서 새로:

> **서울시 자치구별 도보 네트워크 공간정보**

를 추가한다.

서울시가 노드-링크 기반 보행자 도로망을 제공하므로, 단순 반경보다 실제 보행 네트워크 기반 POC가 가능하다.

---

### 변경 4. 진입 필터에 `운영정책/자격 룰 테이블`을 추가

시설유형만으로:

```text
경로당 = 제한
```

이라고 보면 안 된다.

2026년 폭염 대응에서는 일부 연장운영 경로당이 **주말·공휴일 09~21시, 65세 이상 누구나 이용 가능**하도록 운영되고 있다.

따라서:

```text
시설유형
+
현재 폭염 대응정책
+
연장운영 여부
+
연령 조건
```

을 함께 봐야 한다.

즉 **정책 룰 데이터**가 새로 필요하다.

---

### 변경 5. 대용량 AI-Hub 데이터는 전부 받지 않는다

이전 통합본에서는 군중 데이터 등을 MUST급으로 제안했지만,

해커톤 시간이 1박2일로 확정되었으므로:

- pretrained YOLO baseline
- 팀 자체 촬영으로 검증
- 필요 시 AI-Hub subset/sample

순으로 한다.

**AI-Hub 전체 fine-tuning이 프로젝트 성립 조건은 아니다.**

---

# 1. 제품 한 줄 정의

> **폭염 대응 기간에 반복 갱신되는 사람의 상태와 공간의 상태를 결합해, 지금 실제로 연결 가능한 쉼터와 운영 공백을 계산하는 지자체·돌봄기관용 폭염 대응 보조 시스템**

### 핵심 문장

> **폭염 안전확인은 이미 하고 있고, 쉼터 점검도 이미 하고 있습니다.  
> 하지만 사람의 상태와 공간의 상태가 연결되지 않아  
> “이 어르신을 지금 어디로 연결할 수 있는지”는 별도로 계산해야 합니다.**

---

# 2. 문제정의

무더위쉼터가 지도에 존재한다고 해서 실제로 이용 가능한 것은 아니다.

실제 연결을 위해서는:

```text
지금 열려 있는가?
↓
이 사람이 들어갈 수 있는가?
↓
냉방 역량이 있는가?
↓
실제로 도달 가능한가?
↓
현재 수용할 여력이 있는가?
```

가 모두 충족되어야 한다.

## 기존

```text
가장 가까운 쉼터
```

## 제안

```text
지금
+
이 사람에게
+
실제로 연결 가능한 쉼터
```

---

# 3. 제품 목표 / 비목표

## 목표

### 목표 1
명목상 가까운 쉼터와 실제 연결 가능한 쉼터의 차이를 계산한다.

### 목표 2
취약노인 분포 또는 가상 대상자를 기준으로 **연결 불가 인구**를 추정한다.

### 목표 3
운영시간 연장·개방 조정·수용 여력 개선의 정책 의사결정 근거를 제공한다.

### 목표 4
CV를 이용해 공공데이터가 제공하지 못하는 **현장 상태 신호**를 생성한다.

---

## 비목표

- 노인맞춤돌봄서비스 대체 X
- 실제 개인정보 연동 X
- CCTV 원본 상시 저장 X
- 전국 실시간 서비스 X
- 의료적 온열질환 진단 X
- 낙상 예측 시스템을 프로젝트 본체로 만들기 X

---

# 4. 사용자

| 사용자 | 핵심 질문 | 시스템 출력 |
|---|---|---|
| 지자체 폭염 대응 담당자 | 오늘 어디를 더 열거나 연장해야 하나? | 운영 공백 지도·조정 추천 |
| 돌봄기관 관리자 | 이 대상자를 어디로 안내할 수 있나? | 실제 연결 가능 쉼터·불가 사유 |
| 생활지원사 | 안부확인 후 어떤 안내를 해야 하나? | 추천 쉼터 카드·연결 불가 알림 |
| 고위험 어르신 | 지금 갈 수 있는 곳이 있나? | 생활지원사/기관을 통한 간접 안내 |

---

# 5. 핵심 시나리오

## Scenario A — 연결 실패

```text
78세 가상 독거노인
반경 400m 쉼터 3곳
```

하지만:

```text
A: 현재 운영 종료
B: 현재 이용자격 불명확
C: 수용 여력 낮음
```

→ **연결 가능 0곳**

---

## Scenario B — 운영 조정 추천

```text
일요일 야간
+
고령인구 격자
+
현재 연결 가능 쉼터
```

분석 후:

```text
OO경로당을 21시까지 연장
→ 연결 불가 추정 인구 73명 감소

OO복지관 추가 개방
→ 41명 감소
```

처럼 정책 효과를 시뮬레이션.

---

## Scenario C — 현장 관측

공공데이터상 운영 중인 시설에 대해:

```text
사람 수 = 0
활동 신호 = 없음
조도 = 매우 낮음
```

→ **`CLOSED`라고 확정하지 않고 `현장 신뢰도 낮음 / 닫힘 가능성`으로 표시**

→ 다른 쉼터를 우선 제안.

---

## Scenario D — 이상상황 [COULD]

```text
급격한 자세 변화
→ 바닥 방향 하강
→ 누움
→ 무동작 지속
```

→ 관리 화면에서 이상 상황 알림.

---

# 6. 5개 필터

# ① 시간

### 입력
- 운영시작일/종료일
- 평일 운영시간
- 야간개방
- 휴일개방
- 폭염 대응 연장운영 정보

### 출력

```text
OPEN
CLOSED
UNKNOWN
```

### 필요 데이터
- 서울시 무더위쉼터
- 정책 룰/연장운영 정보

---

# ② 진입

### 잘못된 방법

```text
경로당 → 무조건 회원제 → 제외
```

### 권장

```text
시설유형
+
공공/민간
+
당일 개방정책
+
65세 이상 개방 여부
+
회원제 여부
```

### 출력

```text
OPEN_TO_TARGET
RESTRICTED
UNKNOWN
```

### 필요 데이터
- 전국무더위쉼터표준데이터 시설유형
- 중앙/지자체 운영정책 룰

---

# ③ 냉방 역량

### 입력
- 에어컨 보유
- 선풍기 보유
- 점검상태(있다면)

### 출력

```text
SUFFICIENT
LOW
UNKNOWN
```

### 주의

> `에어컨 있음 = 실제로 시원함`

으로 표현하지 않는다.

**냉방 역량**이라고만 표현한다.

---

# ④ 도달

### Baseline
직선거리/반경

### 개선
실제 보행 노드-링크 네트워크 이용.

```text
대상자 위치
→ 가장 가까운 도보 node
→ 쉼터 node
→ network shortest path
→ 보행시간
```

### 기준
선행 연구의 5분 보행권을 기본으로 하되:

```text
일반 기준
+
고령층 보수 기준
```

을 병기한다.

### 필요 데이터
- 서울시 자치구별 도보 네트워크
- 쉼터 좌표
- SGIS 고령인구
- 가상 대상자

---

# ⑤ 수용 — AI 현장 관측

PRD v2에서는 다음 수준을 Must로 잡는다.

```text
사람 수
+
공공데이터 capacity/면적 (있는 경우)
→ 혼잡/수용 신호
```

### capacity가 없을 경우

```text
사람 수 = 15명
```

만으로:

> `정원 초과`

라고 단정하면 안 된다.

따라서:

```text
혼잡 신호만 표시
```

하고 자동 제외하지 않는다.

### 개선 기능 [SHOULD]

```text
빈 좌석 수
점유 좌석 수
```

를 검출하면 capacity가 없더라도 직접 수용여력을 추정할 수 있다.

---

# 7. 기능 요구사항

| ID | 기능 | 우선순위 | 데이터/AI |
|---|---|---|---|
| F-01 | 쉼터 데이터 수집·정제 | MUST | 서울/전국 쉼터 |
| F-02 | 시간 필터 | MUST | 운영시간·요일·정책 |
| F-03 | 진입 필터 | MUST | 시설유형·정책 룰 |
| F-04 | 냉방 역량 필터 | MUST | 에어컨·선풍기 |
| F-05 | 도달 가능성 | MUST | 좌표·SGIS·도보망 |
| F-06 | CV 현장 관측 | MUST | person count·조도·활동 |
| F-07 | 실질 연결 지도 | MUST | ①~⑤ 통합 |
| F-08 | 운영 조정 추천 | SHOULD | 연결 불가 분포·운영시간 |
| F-09 | 대상자 연결 카드 | SHOULD | 가상 프로필·ranking |
| F-10 | 이상상황 감지 | COULD | 낙상·시니어·실신 영상 |

---

# 8. 전체 데이터 우선순위 — 최신판

| 등급 | 데이터 | 역할 | 변경 |
|---|---|---|---|
| 🔥 MUST | 서울시 무더위쉼터 | 시간·좌표 | 유지 |
| 🔥 MUST | 전국무더위쉼터표준데이터 | 시설유형·냉방 | 유지 |
| 🔥 MUST | 기상청 폭염/기상 | Context | 유지 |
| 🔥 MUST | 팀 자체 CV 현장관측 데이터 | F-06 검증 | **강화** |
| 🔥 MUST | 가상 대상자 테이블 | 개인 연결 카드 | 유지 |
| ✅ SHOULD | SGIS 고령/가구 격자 | 연결 불가 추정 | 유지 |
| ✅ SHOULD | **서울시 도보 네트워크** | 실제 5분 도달 | **신규 추가** |
| ✅ SHOULD | 폭염 연장운영/이용정책 룰 | 시간·진입 보정 | **신규 추가** |
| ✅ SHOULD | AI-Hub 실내외 군중 특성 | person count 보강 | **MUST급→SHOULD** |
| ✅ SHOULD | 자체 빈좌석 데이터 | capacity 결측 보완 | **MUST→SHOULD** |
| 🟡 COULD | AI-Hub 낙상사고 | F-10 | 유지 |
| 🟡 COULD | AI-Hub 시니어 이상행동 | F-10 | 유지 |
| 🟡 COULD | AI-Hub 이상행동 CCTV 실신 | F-10 | 유지 |
| ⚪ OPTIONAL | CrowdHuman | person detector 보강 | 우선순위 하향 |
| ⚪ OPTIONAL | AI-Hub 유동인구 CCTV | tracking | 우선순위 하향 |
| ⚪ OPTIONAL | 지하철 이상행동 | 외부 검증 | 유지 |
| ❌ 현재 제외 | UP-Fall / UR Fall | 외부 benchmark | **본체 데이터 목록에서 제거** |
| 🔮 FUTURE | 독거노인 위험감지 | 개인 risk | 유지 |

---

# 9. 공공/운영 데이터 상세

## 9.1 서울시 무더위쉼터 — MUST

**공식**
https://data.seoul.go.kr/dataList/OA-21065/S/1/datasetView.do

### 사용
- 위치
- 주소
- 운영시간
- 시설유형
- 냉방 관련 정보

### 연결
```text
F-01
F-02
F-04
F-05
```

### 매우 중요한 최신 변동

서울 열린데이터광장은:

> **시설면적·이용가능인원·비고 정보를 2026-08-10 이후 제공 중단**

한다고 명시한다.

따라서 새 설계에서는:

```text
서울 capacity/area
```

에 의존하지 않는다.

### 대안

1. 전국무더위쉼터표준데이터에서 해당 값 확보 시 사용
2. 없으면 `UNKNOWN`
3. F-06 person count는 혼잡 신호로만 사용
4. 여유가 있으면 빈좌석 검출로 보강

---

# 9.2 전국무더위쉼터표준데이터 — MUST

**공식**
https://www.data.go.kr/data/15013199/standard.do

### 공식 제공 필드
- 쉼터시설번호
- 년도
- 지역코드
- 시설구분
- 쉼터명칭
- 상세주소
- 면적
- 이용가능인원
- 냉방기보유선풍기
- 냉방기보유에어컨 등

### 연결

```text
F-01 데이터 병합
F-03 시설유형
F-04 냉방 역량
F-06 capacity 보조
```

### 주의

행정안전부 표준에 필드가 존재하더라도:

```text
지자체별 결측
0값 의미
최신성
```

은 실제 데이터 분포로 확인한다.

---

# 9.3 서울시 자치구별 도보 네트워크 — NEW / SHOULD

**공식**
https://data.seoul.go.kr/dataList/OA-21208/S/1/datasetView.do

### 데이터
서울시내 보행자 도로를 **노드-링크 기반**으로 표현.

포함:
- 보행자 도로
- 횡단보도
- 육교
- 버스정류장
- 지하철 출입구 등

### 연결

```text
F-05 도달 가능성
```

### 활용

```text
쉼터 직선거리
vs
실제 도보 네트워크 거리
```

비교.

### 중요 한계
데이터 설명상 도보 네트워크 자체는 **'20년 기준**이므로 최신 도로 변화와 차이가 있을 수 있다.

따라서 POC에서는:

> **“공식 보행 네트워크 기반 추정”**

으로 표현.

---

# 9.4 SGIS — SHOULD

**공식**
https://sgis.mods.go.kr/view/pss/openDataIntrcn

### 현재 확인 가능한 통계
- 인구·가구·주택 격자통계: 2024년까지
- 격자경계: 2025년
- 100m / 500m / 1km 등

### 연결

```text
F-08 운영 조정 추천
연결 불가 추정 인구
```

### 사용

```text
100m 격자 고령인구
×
실질 연결 커버리지
=
연결 불가 추정 고령인구
```

### 주의
인구 통계값 5 미만은 비밀보호상 N/A 처리될 수 있다.

---

# 9.5 기상청 — MUST

### 용도
- 폭염특보
- 기온
- 습도
- 시간대 Context

### 역할
5개 필터 중 직접적인 연결 가능성보다는:

```text
데모 조건 선택
폭염 대응 모드
운영 조정 우선순위
```

에 사용.

### 원칙
특정 API 하나에 전체 서비스가 종속되지 않게 한다.

---

# 9.6 운영정책 룰 테이블 — NEW / MUST에 가까운 SHOULD

F-02/F-03의 정확도를 높이기 위해 필요.

### 예시 schema

```text
policy_id
facility_type
region
effective_from
effective_to
weekday_open
weekend_open
holiday_open
open_time
close_time
age_min
public_access
source_url
```

### 왜 필요한가?

2026년 폭염 대응에서는 전국 **6,363개 연장 운영 경로당**이 지정되어:

```text
평일 + 주말 + 공휴일
09:00~21:00
65세 이상 누구나 이용
```

하도록 운영된다.

따라서:

```text
경로당 = 제한형
```

같은 고정 rule은 피한다.

### POC
기계가 읽을 수 있는 전국 목록을 확보하지 못하면:

- 대상 자치구 공개자료
- 중앙 정책
- 데모용 명시적 policy config

를 사용한다.

---

# 10. CV 데이터 — PRD v2에 맞춘 재정리

# AI #1. 현장 상태 관측 — MUST

## 최종 역할

```text
사람 수
+
활동 신호
+
조도 신호
→ 현장 상태 confidence
```

### 중요

CV가 직접:

```text
OPEN / CLOSED
```

를 결정하지 않는다.

출력은:

```text
person_count
brightness_score
activity_score
field_confidence
possible_closed = True/False
```

형태가 적절하다.

---

# 10.1 팀 자체 현장관측 Dataset — 핵심 MUST

이전보다 더 중요해졌다.

### 이유

F-06 인수기준 자체가:

> 팀 촬영 영상에서 사람 수와 닫힘 가능성 신호가 표시되는 것

이기 때문이다.

### 촬영 조건

#### 운영 중
- 밝음 + 사람 있음
- 밝음 + 사람 없음
- 어두움 + 사람 있음

#### 운영 의심
- 불 꺼짐
- 사람 없음
- 장시간 활동 없음

#### 혼잡
- 1명
- 3명
- 5명
- 10명+
- 서로 가림

### annotation

```text
frame_id
person_count_gt
brightness_gt
activity_gt
scenario
open_ground_truth
```

### 중요한 점

`open_ground_truth`는 **촬영자가 실제 설정한 상태**로만 사용한다.

모델이 사람 수만으로 영업 여부를 추론한 것처럼 발표하지 않는다.

---

# 10.2 AI-Hub 실내외 군중 특성 — SHOULD

**공식**
https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=71368

### 확인된 특징
- 228,195장
- head point + bounding box
- 실내 70.18%
- senior 19%
- sit 17%
- crowd count 데이터

### 우리 모델에서

```text
YOLO pretrained
+
필요 subset
→ crowded/occluded person detection 검증 또는 fine-tuning
```

### 기존과 달라진 필요도

**MUST급 → SHOULD**

### 이유

1박2일에서 이 대규모 데이터를 full training하는 것보다:

```text
YOLO baseline
→ 팀 촬영 테스트
→ 문제가 생기는 경우 subset fine-tune
```

이 현실적이다.

---

# 10.3 자체 빈좌석/점유좌석 데이터 — SHOULD

### 기존
AI #1의 핵심 MUST

### PRD v2
F-06에서 직접 요구하지 않으므로 **SHOULD**

### 언제 구현할 가치가 큰가?

```text
capacity 없음
+
사람 수만으로 혼잡도를 판정하기 어려움
```

인 경우.

### classes

```text
empty_seat
occupied_seat
```

### 출력

```text
free_seat_count
```

### 최종 연결

```text
free_seat_count = 0
→ 수용여력 LOW
```

### 권장
시간이 남을 경우 **가장 먼저 추가할 CV 기능**.

낙상보다 서비스 본체와 더 직접 연결된다.

---

# 10.4 CrowdHuman — OPTIONAL

https://www.crowdhuman.org/

### 역할
심한 사람 occlusion에서 person detector 보강.

### 이번 POC
AI-Hub 군중 + 팀 영상으로 충분하면 받지 않는다.

---

# 10.5 AI-Hub 유동인구 CCTV — OPTIONAL

https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=489

### 활용
tracking으로:

```text
입장
퇴장
현재 인원
```

을 계산하려는 경우.

### 이번 POC
단일 프레임 person count이면 없어도 된다.

---

# 11. Safety Event AI — F-10 COULD

PRD v2에서 F-10은 명확히 **Could**다.

따라서 데이터 다운로드/학습이 F-01~F-07 일정을 방해해서는 안 된다.

---

# 11.1 AI-Hub 낙상사고 위험동작 영상-센서 쌍 — COULD 1순위

https://www.aihub.or.kr/aihubdata/data/view.do?currMenu=115&dataSetSn=71641&topMenu=100

### 확인
- 491.39GB
- 영상 22,672개
- 병원 24.14%
- 집 28.62%
- **노인정/요양병원 46.05%**
- 영상·이미지·센서
- keypoint 활용 가능

### 장점
무더위쉼터와 완전히 같지는 않지만 **노인정/요양병원 domain 비중이 높다.**

### 사용

```text
pose sequence
→ rapid descent
→ lying
→ no motion
```

### POC 원칙
전체 491GB 다운로드 X

```text
샘플
또는
노인정/요양병원 subset
```

만 확인.

---

# 11.2 AI-Hub 시니어 이상행동 — COULD 1순위

https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=167

### 확인
- 250시간
- 2,500 clips
- 250만 이미지
- **4종 낙상**
- 배회
- 일상행동
- timestamp label

### 매우 중요한 역할

낙상 positive보다 오히려:

```text
정상 눕기
정상 앉기
걷기
일상행동
```

을 false positive로 잡지 않게 하는 데이터.

### 추천

Safety를 한다면:

```text
Fall Dataset
+
Senior ADL
```

조합이 우선.

---

# 11.3 AI-Hub 이상행동 CCTV — COULD 2순위

https://www.aihub.or.kr/aihubdata/data/view.do?dataSetSn=171

### 확인
- 12종 이상행동
- 717시간 / 8,436 영상
- **실신(Swoon) 912개, 84시간 이상**

### 역할

온열질환에서는 낙상뿐 아니라:

```text
의식 소실
→ collapse
```

가 중요하므로 실신 class 보강.

### 한계
전체 데이터가 매우 크므로 실신 subset/sample만 사용.

---

# 11.4 지하철 역사 이상행동 — OPTIONAL

https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=174

### 역할
공공 실내 CCTV의 domain robustness 확인.

### 이번 POC
위 3개로 충분하면 제외.

---

# 11.5 주거 및 공용 공간 내 이상행동 영상 — OPTIONAL 신규 후보

https://www.aihub.or.kr/aihubdata/data/view.do?dataSetSn=515

### 장점
- 주거/공용공간 고정 카메라
- 영상 + skeleton 기반 모델 예시
- C3D / CNN-RNN / GRU 등 temporal anomaly 구조 제공

### 하지만
현재 확인된 공식 설명에서 **낙상/실신 자체가 핵심 label로 명확히 확인되지는 않음**.

따라서:

> **낙상 학습데이터가 아니라 temporal anomaly 모델 설계 참고용**

으로만 둔다.

---

# 12. 기존 데이터 중 이번 POC에서 빼도 되는 것

## UR Fall
외부 benchmark로는 좋지만 현재 데모에 불필요.

## UP-Fall
멀티모달이지만:
- 젊은 성인 staged fall
- 이번 제품의 CCTV 중심 구조와 거리 있음

→ 보고서 참고 정도.

## 사람동작 20만 clip
정상 행동 representation은 좋지만 시니어 이상행동 데이터가 더 직접적.

→ 데이터 확보 우선순위에서 제외.

## 독거노인 위험감지
좋은 데이터지만:

```text
댁내 개인 위험도
```

는 현재 PRD 비목표에 가까움.

→ Future.

---

# 13. 모델-데이터 연결 최종표

| 모델/기능 | 입력 데이터 | 모델/로직 | 출력 | 필수 |
|---|---|---|---|---|
| 시간 필터 | 서울 쉼터 + 정책 | Rule | Open/Closed/Unknown | MUST |
| 진입 필터 | 시설유형 + 정책 | Rule | Eligible/Restricted | MUST |
| 냉방 | 전국 표준 | Rule | Cooling capacity | MUST |
| 도달 | 좌표 + 도보망 | Shortest Path | 도보시간 | MUST/SHOULD |
| CV 사람 수 | 팀 영상 + pretrained YOLO | YOLO | person_count | MUST |
| 현장 상태 | person + 조도 + activity | Rule/Score | field confidence | MUST |
| 수용 | person + capacity | Rule | congestion signal | MUST |
| 빈 좌석 | 자체 seat 영상 | YOLO | free seats | SHOULD |
| 운영 조정 | SGIS + 필터 결과 | Geo simulation | 개선 인구 | SHOULD |
| 낙상 | Fall + Senior | Pose/Temporal | fall | COULD |
| 실신 | Swoon | Video/Pose | collapse | COULD |

---

# 14. AI #1 권장 구현

## Baseline

```text
YOLO pretrained
```

사람 class 사용.

### 굳이 처음부터 학습하지 않는 이유
COCO에서 person class가 이미 강함.

우선:

```text
팀 촬영 영상
→ Recall/Count Error 확인
```

한다.

### 성능이 부족하면

```text
AI-Hub 군중 subset
+
자체 촬영
→ fine-tuning
```

---

## 평가 지표

### 사람 수

```text
Count MAE
= 평균 |실제 사람 수 - 예측 사람 수|
```

이 가장 직관적.

추가:
- Precision
- Recall

### 현장 상태

팀이 실제 open/closed 시나리오를 설정한 영상에서:

```text
닫힘 가능성 signal
```

이 논리적으로 동작하는지 confusion matrix 정도를 볼 수 있다.

단, **CV 단독 개폐 판정 정확도**라고 과장하지 않는다.

---

# 15. Safety AI 권장 구현

## 해커톤 버전

복잡한 Video Transformer보다:

```text
YOLO Pose
→ keypoint
→ temporal feature
→ rule / small classifier
```

추천.

### feature

```text
hip y 변화량
body centroid 하강속도
torso angle 변화
bbox aspect ratio
lying duration
motionless duration
```

### 핵심

```text
누워 있음
```

이 아니라:

```text
빠른 전이
+
누움
+
무동작
```

을 본다.

---

# 16. 데이터 파이프라인

```text
[서울 쉼터]
    +
[전국 표준]
    +
[운영 정책]
    +
[기상]
    +
[SGIS]
    +
[도보 네트워크]
        ↓
Data Normalization
        ↓
Standard Shelter Table
        ↓
① 시간
② 진입
③ 냉방
④ 도달
        ↓
Candidate Shelters
        +
[CV 현장상태]
        ↓
⑤ 수용/신뢰도
        ↓
Connection Engine
        ↓
┌─────────────────┬─────────────────┐
│ 돌봄기관         │ 지자체          │
│ 대상자 연결 카드│ 운영 공백 지도  │
└─────────────────┴─────────────────┘
```

---

# 17. 표준 데이터 스키마

## shelter_table

```text
shelter_id
name
facility_type
address
lat
lon

weekday_open
weekend_open
holiday_open
open_time
close_time

eligibility_type
age_min
public_access

aircon_count
fan_count
cooling_status

capacity
area
capacity_source
```

---

## cv_state_table

```text
shelter_id
observed_at

person_count
brightness_score
activity_score

possible_closed
field_confidence

free_seat_count     # optional
safety_event        # optional
```

---

## target_table

```text
target_id
lat
lon

age_group
mobility_profile
simulation_only = True
```

---

## result_table

```text
target_id
shelter_id

time_status
eligibility_status
cooling_status
walking_distance
walking_minutes
capacity_status
field_confidence

connectable
reject_reason
recommendation_score
```

---

# 18. 데이터 병합에서 중요한 것

서울시 데이터와 전국표준은 같은 시설을 다르게 기록할 수 있다.

### 예상 문제
- 쉼터명 표기 다름
- 도로명/지번 차이
- 시설번호 차이
- 동일 경로당 중복

### dedup 우선순위

```text
시설번호
↓
좌표 proximity
↓
정규화 주소
↓
시설명 fuzzy matching
```

### 반드시 남길 것

```text
source
source_updated_at
match_confidence
```

---

# 19. F-05 도달 구현 단계

## Level 1 — 반드시 가능

```text
Haversine 거리
→ 401m/보수 반경
```

## Level 2 — 추천

서울 도보 네트워크로:

```text
NetworkX shortest path
```

### 결과

```text
직선거리: 320m
실제 도보: 510m
```

같은 차이를 보여주면 발표 임팩트가 좋다.

---

# 20. F-08 운영 조정 추천

### 입력
- 연결 불가 격자
- 고령인구
- 현재 닫힌 쉼터
- 운영시간
- 후보별 커버범위

### 시뮬레이션

```text
A 시설 3시간 연장
→ 새로 커버 71명

B 시설 주말 개방
→ 53명

C 시설 야간 개방
→ 29명
```

### ranking

POC에서는 복잡한 ML 필요 없음.

```text
additional_coverage
/
operation_difficulty
```

정도로 우선순위를 만든다.

### 비용
실제 정확한 비용 데이터가 없으면 숫자를 만들지 않는다.

```text
LOW
MID
HIGH
```

같은 정책 난이도 memo로 제한.

---

# 21. 성공 지표

## Product

### 실질 커버리지 낙차

```text
명목 쉼터 수
vs
5개 필터 통과 쉼터 수
```

### 연결 불가 추정 인구

```text
SGIS 고령인구
×
실질 미커버 격자
```

### 운영 조정 효과

```text
운영 연장 전
vs
운영 연장 후
```

---

## CV

### Must

```text
Person Count MAE
```

### Should

```text
Free-seat Count MAE
```

### Could Safety

```text
Fall Recall
False Alarm / hour
```

---

# 22. 구현 우선순위 — 최종판

## BEFORE HACKATHON

### 데이터 담당
- [ ] 서울 쉼터 API/CSV 실제 조회
- [ ] 전국 표준 데이터 실제 조회
- [ ] 컬럼 mapping
- [ ] 서울 도보망 확보
- [ ] SGIS 대상지역 확보

### CV 담당
- [ ] YOLO baseline 실행
- [ ] 팀 촬영 5~10개 영상
- [ ] 사람 count ground truth 제작
- [ ] AI-Hub 군중 sample 확보

### Safety 담당
- [ ] Fall sample 신청
- [ ] Senior sample 신청
- [ ] Swoon sample 확인

---

# Day 1 오전

```text
Data normalization
+
F-01~F-05
```

완성.

### 목표
지도 없이도:

```text
명목 N
→ 시간 N1
→ 진입 N2
→ 냉방 N3
→ 도달 N4
```

수치 출력.

---

# Day 1 오후

- 연결 지도
- 대상자 카드
- 필터 토글

---

# Day 1 밤

### CV

```text
영상
→ YOLO
→ person_count
→ 현장 상태
→ 엔진 input
```

F-06/F-07 연결.

---

# Day 2 오전

- F-08 운영 조정
- 발표용 숫자 고정
- ablation / CV metric

---

# Day 2 여유

우선순위:

```text
1. 빈좌석
2. 낙상/실신
3. 모델 비교
```

**낙상보다 빈좌석이 제품 본체에 더 직접적이므로 먼저 한다.**

---

# 23. 데이터 다운로드 최종 순서

## 바로

### 1
서울시 무더위쉼터  
https://data.seoul.go.kr/dataList/OA-21065/S/1/datasetView.do

### 2
전국무더위쉼터표준데이터  
https://www.data.go.kr/data/15013199/standard.do

### 3
서울 자치구별 도보 네트워크  
https://data.seoul.go.kr/dataList/OA-21208/S/1/datasetView.do

### 4
SGIS  
https://sgis.mods.go.kr/view/pss/openDataIntrcn

### 5
기상청  
https://data.kma.go.kr/

---

## CV

### 6
AI-Hub 실내외 군중 특성  
https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=71368

### 7
자체 팀 촬영 영상

---

## Safety — 시간 남을 때

### 8
낙상사고 위험동작 영상-센서 쌍  
https://www.aihub.or.kr/aihubdata/data/view.do?currMenu=115&dataSetSn=71641&topMenu=100

### 9
시니어 이상행동  
https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=167

### 10
이상행동 CCTV / 실신  
https://www.aihub.or.kr/aihubdata/data/view.do?dataSetSn=171

---

# 24. 이번 통합본에서 제거/하향한 데이터

| 데이터 | 기존 | 현재 |
|---|---|---|
| 자체 empty/occupied seat | MUST | **SHOULD** |
| AI-Hub 실내외 군중 전체 | MUST급 | **SHOULD/subset** |
| CrowdHuman | SHOULD | OPTIONAL |
| 유동인구 CCTV | SHOULD | OPTIONAL |
| UR Fall | Optional | 본문 제거/참고 |
| UP-Fall | Optional | 본문 제거/참고 |
| 사람동작 | Optional | 데이터 확보 대상에서 제외 |
| 독거노인 위험감지 | Future | Future 유지 |

---

# 25. 이번 통합본에서 추가한 데이터

| 신규 데이터 | 이유 |
|---|---|
| **서울시 도보 네트워크** | F-05 실제 보행거리 구현 |
| **운영정책 룰 테이블** | 경로당/공공시설의 시간·자격이 동적으로 변함 |
| **현장 상태 자체 dataset schema** | F-06 인수기준에 직접 대응 |
| source/match confidence | 서울/전국 데이터 병합 신뢰도 관리 |

---

# 26. 오픈 이슈

## 데이터
- [ ] 서울시 API의 실제 운영시간/요일 컬럼 확인
- [ ] 서울시 area/capacity 빈값/삭제 상태 확인
- [ ] 전국표준 0값과 결측 분리
- [ ] 동일 쉼터 중복 매칭 방식 확정
- [ ] 대상 자치구 SGIS 100m data 확보
- [ ] 도보망 최신성 한계 표시

## 정책
- [ ] 대상 자치구 연장운영 경로당 목록 확인
- [ ] 자원연계가 실제로 쉼터 안내까지 포함하는지 확인
- [ ] 시설별 실제 이용자격 데이터 확보 가능 여부

## CV
- [ ] `possible_closed`의 threshold 정의
- [ ] person_count MAE 목표
- [ ] capacity가 없을 때 자동 제외 여부 금지
- [ ] 빈좌석 detector 구현 여부

---

# 27. 표현 원칙

| 피할 표현 | 권장 |
|---|---|
| 쉼터가 닫혀 있다 | **닫힘 가능성/현장 신뢰도 낮음** |
| CV가 개방 여부를 안다 | **운영정보에 현장 관측 신호를 보강한다** |
| 실제로 시원하다 | **냉방 역량이 있다** |
| 수용 가능하다 | **수용 여력이 있다고 추정한다** |
| 실시간 연결 | **실질 연결 가능성 계산** |
| 개인 위험을 정확히 안다 | **가상 프로필 기반 POC** |
| AI가 낙상을 진단한다 | **낙상/실신 의심 상황을 감지한다** |

---

# 28. 최종 아키텍처

```text
                ┌─────────────────────┐
                │ 서울/전국 쉼터 DB   │
                └─────────┬───────────┘
                          │
             ┌────────────┼─────────────┐
             │            │             │
        운영시간      시설/냉방       좌표
             │            │             │
             ▼            ▼             ▼
           시간          진입/냉방     도달
                                      ▲
                                      │
                              서울 도보 네트워크
                                      │
                          ┌───────────┘
                          │
                   Candidate Shelter
                          │
                          ▼
              ┌───────────────────────┐
              │  CV Field Observer    │
              │ YOLO + activity/light│
              └───────────┬───────────┘
                          │
                 person_count
                 field_confidence
                 free_seat(optional)
                          │
                          ▼
                ⑤ 수용/현장 신뢰도
                          │
                          ▼
                 CONNECTION ENGINE
                          │
             ┌────────────┴────────────┐
             │                         │
             ▼                         ▼
      대상자 연결 카드           지자체 운영 공백
      돌봄기관/생활지원사          운영 연장 추천

             [Safety Event AI]
                ↑ OPTIONAL
       Fall + Senior ADL + Swoon
```

---

# 29. 핵심 결론

## 프로젝트 본체

> **지도에 있는 가장 가까운 쉼터가 아니라, 지금 이 대상자가 실제로 이용 가능한 쉼터를 계산한다.**

## AI의 핵심 역할

> **공공데이터가 알려주지 못하는 ‘현재 현장 상태’를 사람 검출과 활동 관측으로 보완한다.**

## PRD v2에 맞는 AI 우선순위

```text
1. 사람 수
2. 현장 활동/조도
3. 빈좌석
4. 낙상/실신
```

## 가장 중요한 데이터 변화

> **서울시가 면적·이용가능인원을 2026-08-10 이후 제공하지 않기 때문에, capacity에 의존하는 설계는 약해졌다.**

따라서:

```text
전국표준 capacity
+
CV 사람수
+
(선택) 빈좌석
```

의 다중 fallback이 가장 안전하다.

---

# 30. 출처 링크

## PRD 근거
- 사용자 제공: `폭염_대응_연결_엔진_PRD_v2.docx`

## 무더위쉼터
- 서울시 무더위쉼터: https://data.seoul.go.kr/dataList/OA-21065/S/1/datasetView.do
- 전국무더위쉼터표준데이터: https://www.data.go.kr/data/15013199/standard.do
- 행정안전부 무더위쉼터 관리 보도자료: https://www.mois.go.kr/frt/bbs/type010/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000008&nttId=126779

## 보행/인구
- 서울시 자치구별 도보 네트워크: https://data.seoul.go.kr/dataList/OA-21208/S/1/datasetView.do
- SGIS: https://sgis.mods.go.kr/view/pss/openDataIntrcn

## 운영정책
- 보건복지부 폭염 비상대책: https://www.mohw.go.kr/board.es?act=view&bid=0027&list_no=1491554&mid=a10503010100

## AI-Hub Occupancy
- 실내외 군중 특성: https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=71368

## AI-Hub Safety
- 낙상사고 위험동작: https://www.aihub.or.kr/aihubdata/data/view.do?currMenu=115&dataSetSn=71641&topMenu=100
- 시니어 이상행동: https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=167
- 이상행동 CCTV: https://www.aihub.or.kr/aihubdata/data/view.do?dataSetSn=171
- 주거 및 공용 공간 이상행동: https://www.aihub.or.kr/aihubdata/data/view.do?dataSetSn=515

---

# 31. 팀 공유용 5줄 요약

1. **기획의 본체는 기존과 동일**: 사람의 상태와 쉼터의 실제 상태를 연결하는 엔진.
2. PRD v2에서는 **사람 수 + 조도/활동 관측이 CV Must**, 낙상은 Could로 구체화됨.
3. 그래서 **빈좌석 학습은 Must → Should**, 대규모 군중 데이터 전체 학습도 Should로 내림.
4. 대신 **서울 도보 네트워크와 폭염 연장운영/이용자격 정책 룰**을 새로 추가하는 것이 필요.
5. 서울시 수용인원 데이터 제공 중단에 대비해 **전국표준 capacity → CV 사람수 → 빈좌석(optional)** 순의 fallback 구조로 설계.
