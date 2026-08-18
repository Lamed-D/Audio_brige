# 폭염 대응 연결 엔진 — 통합 기획안 + AI 데이터 계획

## 1. 프로젝트 한 줄 정의
폭염 취약계층의 상태와 무더위쉼터의 실제 이용 가능 상태를 결합해, **“지금 이 대상자를 실제로 어디에 연결할 수 있는가”**를 계산하는 지자체·돌봄기관용 폭염 대응 보조 시스템.

### 핵심 메시지
> 폭염 안전확인은 이미 하고 있고, 쉼터 점검도 이미 하고 있다.  
> 하지만 사람의 상태와 공간의 상태가 연결되지 않아 **“이 어르신을 지금 어디로 연결할 수 있는가”**는 별도로 판단해야 한다.

어르신에게 새로운 앱을 쓰게 하지 않고, 기존 생활지원사·돌봄 인력이 마지막 연결을 담당한다.

---

## 2. 문제 정의
지도에 쉼터가 존재한다고 해서 실제 이용 가능한 것은 아니다.

실제 연결 가능성은 최소 다음을 함께 봐야 한다.

1. **시간** — 지금 운영 중인가?
2. **진입** — 이 대상자가 실제 이용 가능한 시설인가?
3. **냉방 역량** — 냉방 설비가 있는가?
4. **도달** — 현실적으로 이동 가능한 거리·경로인가?
5. **수용** — 지금 실제로 들어가 쉴 여유가 있는가?

따라서 기존의 **가장 가까운 쉼터 추천**이 아니라  
**“지금 + 이 사람에게 + 실제 연결 가능한 쉼터”**를 계산한다.

---

## 3. 서비스 포지셔닝
### 사용자
- 지자체 폭염 대응 담당자
- 노인맞춤돌봄 수행기관
- 전담사회복지사
- 생활지원사
- 향후 재난도우미 등

### 현재 제도와의 관계
기존에도 생활지원사의 안전확인과 인근 무더위쉼터 안내는 존재한다.  
따라서 **“현재는 연결이 없다”**고 주장하지 않는다.

대신:
> **인근 쉼터 안내는 하지만, 운영시간·이용조건·도달성·현재 수용여력까지 결합한 ‘실질 가용성 계산’을 보완한다.**

---

## 4. 연결 엔진 구조

```text
전체 쉼터
   ↓
① 시간 — 지금 운영 중?
   ↓
② 진입 — 이 대상자가 이용 가능?
   ↓
③ 냉방 — 냉방 역량 충분?
   ↓
④ 도달 — 실제 이동 가능?
   ↓
⑤ 수용 — 지금 들어가 쉴 자리 있음?
   ↓
현재 연결 가능한 쉼터
```

### ① 시간
운영시간·요일·폭염특보 시 연장운영 정보를 사용한다.  
CV만 보고 개방/폐쇄를 단정하지 않는다.

### ② 진입
경로당 등은 시설유형만으로 회원제라고 단정하지 않고, 당일 개방정책·연령조건 등을 함께 본다.

### ③ 냉방 역량
에어컨·선풍기 보유정보를 사용한다.  
**“실제로 시원하다”가 아니라 “냉방 역량이 있다”**로 표현한다.

### ④ 도달
쉼터 좌표, 보행거리, 경사 등을 활용한다.  
POC에서는 실제 건강정보 대신 가상 대상자 프로필을 사용한다.

### ⑤ 수용 — 핵심 AI
정적 데이터만으로 알기 어려운 **현재 사람 수, 빈 좌석 수, 혼잡 수준**을 CV로 추정한다.

---

# 5. AI 구성

## AI #1. Shelter Occupancy AI — MUST
### 목표
쉼터의 **현재 이용 여력**을 추정한다.

### 입력
고정 CCTV 또는 자체 촬영 CCTV-like 영상

### 출력
```text
person_count
empty_seat_count
occupied_seat_count
availability = HIGH / MID / LOW
```

### 추천 모델
- 1차: YOLO 계열
- 비교 실험 여유 시: RT-DETR

### 추천 클래스
```text
person
empty_seat
occupied_seat
```

핵심 기여:
> **공공데이터가 알려주지 못하는 ‘현재 쉼터 이용 여력’을 AI가 생성한다.**

---

## AI #2. Safety Event AI — COULD
연결 엔진을 먼저 완성한 뒤 시간이 남으면 구현한다.

### 목표
쉼터 내부에서:
- 정상행동
- near-fall
- fall
- collapse / swoon

을 구분한다.

### 권장 방식
한 프레임 자세가 아니라 **시간적 전이**를 본다.

```text
사람 검출/추적
→ pose keypoint
→ 시간축 keypoint sequence
→ 급격한 중심 높이 감소 / 몸통 각도 변화
→ lying posture
→ 일정 시간 무동작
→ Fall / Collapse Alert
```

정상 눕기:
```text
천천히 자세 변화 → 누움
```

낙상/실신:
```text
급격한 자세 변화 → 하강 → 누움 → 무동작 지속
```

---

# 6. AI 학습 데이터 전체 매핑

| 필요도 | 데이터 | 연결 모듈 | 사용 목적 |
|---|---|---|---|
| 🔥 MUST | 자체 Shelter Occupancy Dataset | AI #1 | person / 빈 좌석 / 점유 좌석 |
| 🔥 MUST급 | AI-Hub 실내외 군중 특성 | AI #1 | 실내 군중·가림 상황 person detection |
| SHOULD | CrowdHuman | AI #1 | occlusion 보강 |
| SHOULD | AI-Hub 유동 인구 CCTV | AI #1 | tracking / counting |
| Safety 구현 시 MUST | AI-Hub 낙상사고 위험동작 | AI #2 | fall / non-fall / keypoint |
| Safety 구현 시 MUST | AI-Hub 시니어 이상행동 | AI #2 | 고령자 낙상 + 일상행동 + 배회 |
| Safety 구현 시 SHOULD | AI-Hub 이상행동 CCTV | AI #2 | 실신(collapse/swoon) |
| COULD | AI-Hub 지하철 역사 CCTV 이상행동 | AI #2 | 공공 실내 CCTV 실신·전도 |
| OPTIONAL | AI-Hub 사람동작 영상 | AI #2 | 정상 action/pose 보강 |
| OPTIONAL | UR Fall | AI #2 | 외부 benchmark |
| OPTIONAL | UP-Fall | AI #2 | 멀티모달 benchmark |
| FUTURE | AI-Hub 독거노인 위험감지 | 개인 Risk AI | 댁내 위험도 확장 |

---

# 7. Occupancy AI용 데이터

## 7.1 AI-Hub 실내외 군중 특성 데이터
**링크:**  
https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=71368

### 확인된 특징
- 실내 데이터 약 70%
- 대규모 사람 객체 annotation
- senior 속성 포함
- sit / stand 정보 포함
- counting / object detection 활용 가능

### 우리 모델에서
```text
CCTV → person detection → 이용자 수 → 수용여력
```

### 필요도
**MUST급**

단, 최종 쉼터 환경과 domain gap이 있으므로 자체 데이터 fine-tuning이 더 중요하다.

---

## 7.2 자체 Shelter Occupancy Dataset
**필요도: 최우선 MUST**

공개 데이터에서 `무더위쉼터 CCTV + 사람 + 빈 좌석`까지 맞는 데이터는 찾기 어렵기 때문에 직접 제작한다.

### 촬영
회의실/강의실을 쉼터처럼 구성해 CCTV와 유사한 상단 사선 각도로 촬영.

### 시나리오
- 인원: 0 / 1 / 2 / 5 / 8 / 10+
- 좌석: 대부분 빈 상태 / 절반 / 80% / 만석
- 행동: 앉기 / 서기 / 출입 / 사람끼리 겹침
- 환경: 밝음 / 어두움 / 역광

### Annotation
```text
person
empty_seat
occupied_seat
```

### 최종 Ground Truth
```text
frame_id
person_count
empty_seat_count
occupied_seat_count
availability
```

---

## 7.3 CrowdHuman
**링크:**  
https://www.crowdhuman.org/

### 특징
- Train 15,000장
- Validation 4,370장
- Test 5,000장
- Train+Val 약 47만 human instance
- 심한 occlusion 포함

### 사용
사람이 겹쳐 보이는 상황에서 detector recall 보강.

### 필요도
**SHOULD**

---

## 7.4 AI-Hub 유동 인구 분석 CCTV
**링크:**  
https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=489

### 사용
- person tracking
- 출입 count
- 현재 인원 추정

### 필요도
**SHOULD**

---

# 8. 낙상·실신 데이터

## 8.1 AI-Hub 낙상사고 위험동작 영상-센서 쌍 데이터
**링크:**  
https://www.aihub.or.kr/aihubdata/data/view.do?currMenu=115&dataSetSn=71641&topMenu=100

### 확인된 규모
- 영상 22,672 clips
- 이미지 226,720장
- 영상 keypoint
- 이미지 BBOX
- MP4 / CSV / JPG / JSON

### 장소 분포
- 병원 24.14%
- 집 28.62%
- **노인정 또는 요양병원 46.05%**
- 길거리 1.20%

### 우리 모델에서
```text
Pose / Keypoint sequence
→ temporal fall classifier
→ Fall Event
```

### 필요도
프로젝트 전체에서는 **COULD**  
Safety Event AI를 구현한다면 **MUST**

### 권장
전체가 크므로 해커톤에서는 샘플 또는 노인정/요양병원 subset부터 확보.

---

## 8.2 AI-Hub 시니어 이상행동 영상
**링크:**  
https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=167

### 확인된 특징
- 약 250시간
- 2,500 clips
- 250만 이미지
- 4종 낙상
- 배회
- 일상행동
- timestamp annotation

### 왜 중요한가
낙상 positive만 넣으면 정상적인
- 천천히 앉기
- 눕기
- 일어서기
- 휴식
- 배회

를 사고로 오인할 수 있다.

### 역할
**고령자 정상행동 negative class** 보강.

### 필요도
Safety Event AI 구현 시 **MUST급**

---

## 8.3 AI-Hub 이상행동 CCTV 영상
**링크:**  
https://www.aihub.or.kr/aihubdata/data/view.do?dataSetSn=171

### 확인된 특징
- 약 700시간 규모
- 12종 이상행동
- **실신(swoon)** 포함
- 배회 포함
- CCTV 영상

### 우리 모델에서
```text
Fall Dataset + Swoon Dataset
→ Normal / Fall / Collapse
```

온열질환 상황에서는 미끄러짐뿐 아니라 갑작스러운 실신도 중요하므로 보조 데이터로 가치가 높다.

### 필요도
Safety Event AI 구현 시 **SHOULD~MUST**

---

## 8.4 AI-Hub 지하철 역사 내 CCTV 이상행동
**링크:**  
https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=174

### 확인된 특징
- 13종 이상행동
- 7,030개 클립 기반
- 100만 장 이상 이미지
- 실신
- 계단 전도
- 에스컬레이터 전도
- 고정형 공공 실내 CCTV 환경

### 사용
공공 실내 공간에서의 외부 validation / 보강.

### 필요도
**COULD**

---

## 8.5 AI-Hub 사람동작 영상
**링크:**  
https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=62

### 특징
- 50종 action
- 약 20만 clip
- 5~10초 영상

### 사용
걷기·앉기 등 정상 action representation 보강.

### 필요도
**OPTIONAL**

---

# 9. 해외 Fall Dataset

## 9.1 UR Fall Detection Dataset
**링크:**  
https://fenix.ur.edu.pl/~mkepski/ds/uf.html

### 특징
- 70 sequences
- 30 fall
- 40 ADL
- Kinect + accelerometer

### 추천 사용
```text
Train: AI-Hub
Test: UR Fall
```

으로 cross-dataset generalization 평가.

### 필요도
OPTIONAL

---

## 9.2 UP-Fall
**링크:**  
https://pmc.ncbi.nlm.nih.gov/articles/PMC6539235/

### 특징
- 17명의 건강한 젊은 참가자
- 5종 fall
- 6종 ADL
- wearable + ambient sensor + vision

### 한계
고령자가 아니라 젊은 성인의 staged fall이므로 domain gap이 크다.

### 필요도
OPTIONAL

---

# 10. 향후 개인 위험도 확장 데이터

## AI-Hub 독거노인 돌봄용 위험감지
**링크:**  
https://aihub.or.kr/aihubdata/data/view.do?currMenu=115&dataSetSn=71803&topMenu=100

### 확인된 구성
- 환경측정
- 동작감지
- 생체신호
- 적외선 이미지
- 응급요청
- 상담기록

### 규모
- 신규 30가구
- 기존 약 1,000가구
- 멀티모달 센서·돌봄 기록

### 향후 연결
```text
대상자 댁내 위험도
+
폭염
+
쉼터 실제 가용성
→ 누구를 먼저 연결할지
```

### 필요도
**FUTURE — 이번 해커톤 본체에서는 제외**

---

# 11. 연결 엔진용 공공데이터

## 11.1 전국무더위쉼터표준데이터 — MUST
**링크:**  
https://www.data.go.kr/data/15013199/standard.do

### 주요 필드
- 쉼터시설번호
- 시설구분
- 쉼터명칭
- 상세주소
- 면적
- 이용가능인원
- 선풍기 보유
- 에어컨 보유 등

### 연결
- ② 진입
- ③ 냉방 역량

### 주의
지자체별 결측과 갱신 차이를 확인해야 한다.

---

## 11.2 서울시 무더위쉼터 — MUST
**링크:**  
https://data.seoul.go.kr/dataList/OA-21065/S/1/datasetView.do

### 사용
- 위치
- 주소
- 좌표
- 운영시간 등

### 연결
- ① 시간
- ④ 도달

### 주의
2026년 8월 기준 일부 수용 관련 필드 제공 정책이 변경된 것으로 확인되므로, 실제 다운로드 파일의 최신 schema를 먼저 확인한다.

---

## 11.3 기상청 폭염 데이터 — MUST
**폭염 데이터:**  
https://data.kma.go.kr/data/weatherIssue/slthtList.do

**Open API 목록:**  
https://data.kma.go.kr/api/selectApiList.do?pgmNo=42

### 사용
- 기온
- 습도
- 기상특보
- 폭염 영향예보
- 열대야 등

### 중요 주의
기상자료개방포털의 과거 생활기상지수 체감온도 페이지에는 **2026-05-11 서비스 종료 안내**가 표시되어 있다.

따라서 프로젝트는 특정 `체감온도 API` 하나에 의존하지 말고:
- 기온
- 습도
- 폭염특보
- 영향예보

를 기본으로 사용한다.

---

## 11.4 SGIS 고령인구/가구 공간통계 — SHOULD
**자료제공:**  
https://sgis.mods.go.kr/view/pss/openDataIntrcn

**API:**  
https://sgis.mods.go.kr/developer/html/newOpenApi/api/dataApi/thematicMapCTGR.html

### 사용
- 고령인구 분포
- 가구분포
- POC 대상지역 선정
- 가상 취약대상자 생성

### 연결
```text
고령인구 격자
→ 가상 대상자
→ 5개 필터
→ 연결 가능/불가능 분포
```

---

# 12. 추천 학습 전략

## Model A — Shelter Occupancy
### Baseline
COCO-pretrained YOLO

### Fine-tuning
```text
AI-Hub 실내외 군중 특성
+
자체 Shelter Occupancy Dataset
```

### 평가
- Person AP / Recall
- Empty-seat AP
- Occupied-seat AP
- Count MAE
- **Free-seat Count MAE**
- Availability classification accuracy

서비스 관점에서는 단순 person AP보다 **빈 좌석 수 오차**가 중요하다.

---

## Model B — Safety Event
### 빠른 버전
```text
YOLO Pose
→ keypoint sequence
→ temporal feature/rule
→ Normal / Fall / Collapse
```

사용 feature:
- hip/centroid 높이 변화율
- body angle
- vertical velocity
- bbox aspect ratio
- lying duration
- motionless duration

### 시간이 충분하면
```text
Pose sequence
→ GRU / LSTM / TCN / ST-GCN
→ Normal / Fall / Collapse
```

학습:
```text
AI-Hub 낙상
+
AI-Hub 시니어 이상행동
+
AI-Hub Swoon
```

---

# 13. 데이터 Split 원칙

특히 낙상 모델에서 frame random split은 피한다.

같은 사람·같은 영상의 인접 frame이 train/test에 섞이면 성능이 과대평가될 수 있다.

가능하면:
- subject-disjoint split
- scene-disjoint split
- 자체 쉼터 영상 external test

를 사용한다.

---

# 14. 자체 데이터 촬영·라벨링

## Occupancy
처음부터 너무 크게 만들지 말고 300~500장으로 baseline을 만든 뒤 추가한다.

연속 프레임을 무작정 뽑지 말고 2~5초 간격으로 sampling해 다양성을 확보한다.

### Annotation
```text
class 0: person
class 1: empty_seat
class 2: occupied_seat
```

도구 후보:
- CVAT
- Label Studio
- Roboflow

---

## Safety
실제 위험한 낙상 재현은 하지 않는다.

자체 데이터에서는 오히려:
- 정상적으로 앉기
- 천천히 눕기
- 물건 줍기
- 벽에 기대기
- 쪼그려 앉기

같은 **false-positive 방지용 negative 행동**을 촬영하는 것이 더 유용하다.

---

# 15. 최종 Connection Engine

MVP는 모든 것을 end-to-end AI로 만들 필요가 없다.

추천 구조:

```text
설명 가능한 Rule Filter
+
CV가 만든 현재 상태
+
Ranking
```

예:

```text
운영 종료 → 연결 불가
이용조건 불일치 → 연결 불가
냉방 역량 부족 → 비권장
거리 초과 → 동행 필요/비권장
빈 좌석 0 → 연결 불가
```

남은 후보를 거리·빈 좌석·냉방역량 등으로 정렬한다.

이 방식은:
> “왜 이 쉼터를 추천했나요?”
에 설명 가능하다.

---

# 16. 최종 화면

## 화면 1 — 대상자별 연결 지도
```text
김OO / 가상 프로필

1. OO경로당
   연결 가능성 HIGH
   280m
   운영 O
   이용 가능 O
   냉방 O
   현재 이용자 8명
   빈 좌석 5석

2. OO복지관
   연결 가능성 MID
   430m
   빈 좌석 1석

3. OO주민센터
   연결 불가
   사유: 운영 종료
```

## 화면 2 — 지자체 운영 공백 지도
시간대별:
- 연결 가능 충분
- 연결 가능 부족
- 연결 불가

를 지도에 표시한다.

---

# 17. 구현 우선순위

| 순서 | 기능 | 우선순위 |
|---|---|---|
| 1 | 쉼터 데이터 확보·정제 | MUST |
| 2 | 시간/진입/냉방/도달 4개 필터 | MUST |
| 3 | 대상지역 연결 지도 | MUST |
| 4 | YOLO 사람 검출 | MUST |
| 5 | 자체 빈좌석 데이터 | MUST |
| 6 | 수용여력 AI와 연결 엔진 통합 | MUST |
| 7 | 지자체 운영공백 화면 | SHOULD |
| 8 | 낙상/실신 데모 | COULD |
| 9 | RT-DETR 비교 | COULD |
| 10 | 개인 댁내 위험 AI | FUTURE |

---

# 18. 추천 실험

## 실험 1 — 5개 필터
```text
명목 쉼터 N
→ 시간 n1
→ 진입 n2
→ 냉방 n3
→ 도달 n4
→ AI 수용 n5
```

메시지:
> 지도상 쉼터 수와 실제 연결 가능한 쉼터 수는 다를 수 있다.

## 실험 2 — Occupancy AI Ablation
```text
COCO YOLO
vs
+ AI-Hub 군중 데이터
vs
+ 자체 Shelter 데이터
```

평가:
- Person Recall
- Count MAE
- Free-seat MAE

## 실험 3 — Safety Event
```text
Single-frame posture
vs
Temporal transition
vs
Temporal + motionless
```

평가:
- Fall Recall
- False Alarm / hour

---

# 19. 예상 반론

### “지도 앱에 이미 쉼터가 나오는데요?”
> 지도는 위치를 알려주고, 우리는 **실제 이용 가능성**을 판정한다.

### “그냥 YOLO 아닌가요?”
> YOLO는 현장 상태를 읽는 부품이다.  
> 핵심은 그 결과를 운영시간·이용조건·냉방·도달성과 결합해 **연결 가능/불가**로 변환하는 파이프라인이다.

### “카메라로 시원한지 알 수 있나요?”
> RGB 영상으로 실내온도를 추정한다고 주장하지 않는다.  
> 공공데이터의 냉방기 보유정보는 `냉방 역량`으로만 사용한다.

### “개인정보 문제는요?”
- 영상 저장 최소화
- 엣지 추론 지향
- 얼굴인식 X
- 개인 ID 저장 X
- count / seat / alert만 남김

단, **“개인정보 문제 없음”**이라고 단정하지 않고 실제 도입 시 영상정보 관련 법적 검토가 필요하다고 명시한다.

---

# 20. 데이터 확보 체크리스트

## 바로 신청/다운로드
- [ ] 전국무더위쉼터표준데이터
- [ ] 서울시 무더위쉼터
- [ ] 기상청 폭염 데이터
- [ ] SGIS 고령인구
- [ ] AI-Hub 실내외 군중 특성
- [ ] AI-Hub 낙상사고 위험동작
- [ ] AI-Hub 시니어 이상행동
- [ ] AI-Hub 이상행동 CCTV

## 직접 제작
- [ ] Shelter Occupancy 영상
- [ ] person annotation
- [ ] empty seat annotation
- [ ] occupied seat annotation
- [ ] 정상 눕기/앉기 등 safety negative 영상

---

# 21. 팀 분업 추천

### A — 공공데이터/연결엔진
쉼터 데이터 → 4개 정적 필터 → 연결 가능 후보

### B — Occupancy CV
AI-Hub 군중 + 자체 영상 → person/seat detector

### C — Safety CV
낙상 + 시니어 + swoon 데이터 → 샘플 확인 → 시간이 되면 구현

### D — 공간/기상
SGIS + 기상 + 좌표 spatial join + 지도

---

# 22. 핵심 링크 모음

## 쉼터/공공
- 전국무더위쉼터: https://www.data.go.kr/data/15013199/standard.do
- 서울시 무더위쉼터: https://data.seoul.go.kr/dataList/OA-21065/S/1/datasetView.do
- 기상청 폭염: https://data.kma.go.kr/data/weatherIssue/slthtList.do
- 기상청 API: https://data.kma.go.kr/api/selectApiList.do?pgmNo=42
- SGIS: https://sgis.mods.go.kr/view/pss/openDataIntrcn

## Occupancy
- AI-Hub 실내외 군중: https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=71368
- AI-Hub 유동인구 CCTV: https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=489
- CrowdHuman: https://www.crowdhuman.org/

## Fall / Safety
- AI-Hub 낙상사고 위험동작: https://www.aihub.or.kr/aihubdata/data/view.do?currMenu=115&dataSetSn=71641&topMenu=100
- AI-Hub 시니어 이상행동: https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=167
- AI-Hub 이상행동 CCTV: https://www.aihub.or.kr/aihubdata/data/view.do?dataSetSn=171
- AI-Hub 지하철 CCTV: https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=174
- AI-Hub 사람동작: https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=62
- UR Fall: https://fenix.ur.edu.pl/~mkepski/ds/uf.html
- UP-Fall: https://pmc.ncbi.nlm.nih.gov/articles/PMC6539235/

## 향후 확장
- AI-Hub 독거노인 위험감지: https://aihub.or.kr/aihubdata/data/view.do?currMenu=115&dataSetSn=71803&topMenu=100

---

# 23. 최종 추천 범위

## 이번 해커톤에서 반드시 완성
```text
운영시간
+ 진입조건
+ 냉방역량
+ 도달성
+ AI 현재 수용여력
→ 실제 연결 가능한 쉼터
```

## 시간이 남으면 추가
```text
쉼터 영상
→ 낙상/실신 의심
→ 관리자 알림
```

## 이번에는 빼는 것
- 댁내 센서 기반 개인 위험예측
- 생활지원사 업무 우선순위 AI
- 119 자동신고
- 복잡한 낙상 사전예측
- 전국 단위 최적화

---

# 24. 최종 한 문장

> **지도에 있는 가장 가까운 쉼터가 아니라, 지금 이 어르신이 실제로 들어가 쉴 수 있는 쉼터를 연결한다.**

AI의 역할:

> **공공데이터가 알려주지 못하는 ‘현재 현장 상태’를 관측해 실질 연결 가능성을 완성한다.**
