# BYOK + 1회 결제 잠금 해제 — 설계

작성일: 2026-08-31

## 배경

지금 확장은 두 가지 방식으로 동작한다. **Pro 모드**는 우리 Cloudflare Worker가
우리 Anthropic 키로 대신 호출하고, **Own Key 모드**는 사용자 키로 직접 호출한다.
Pro 모드에는 무료 티어 미터링(하루 10회), Durable Object 사용량 카운터, Stripe
월 구독, 만료·유예 처리가 딸려 있다.

이 구조는 조회 1건마다 우리 비용이 나간다. Haiku 4.5 기준 조회당 약 $0.003이고
비용의 95%가 출력 토큰이다. 월 ₩3,000 구독에서 Stripe 수수료를 빼면 실수령이
약 $1.68이라, 현재 상한인 월 1000회를 다 쓰는 구독자 한 명당 매월 $1.5~3.7의
손실이 난다. 서버 측 단어 캐시가 없어 사용자가 늘어도 원가가 그대로 비례한다.

BYOK로 전환하면 조회 원가가 0이 된다. 그러면 팔 것은 AI 호출이 아니라 **우리
소프트웨어가 만든 자산** — 사용자가 모은 단어장과 그것을 쓰는 기능 — 이 된다.

## 목표

- AI 조회 원가를 0으로 만든다 (사용자 키 사용).
- 구독을 없애고 **1회 $3 결제**로 세 기능을 영구 잠금 해제한다.
- 워커에서 프록시·미터링·구독 상태 추적을 전부 제거해 운영 부담을 없앤다.

## 핵심 불변 조건

**우리는 어떤 경우에도 AI 토큰을 사용하지 않는다.**

이것은 최적화나 현재 방침이 아니라 이 설계가 서 있는 전제다. 아래는 전부 같은
한 가지 사실의 다른 표현이다.

- 영어 단어·구문 조회는 **BYOK로만** 동작한다. 사용자가 등록한 Claude·Gemini·
  OpenAI 키로 확장이 제공자를 **직접** 호출한다.
- **$3를 결제해도 마찬가지다.** 결제는 소프트웨어 기능 잠금을 해제할 뿐,
  AI 사용량·크레딧·토큰을 포함하지 않는다. 결제 전후로 조회 경로가 동일하다.
- 우리 워커는 AI 제공자를 호출하는 코드를 **보유하지 않는다.** `CLAUDE_API_KEY`
  시크릿은 삭제하며 다시 만들지 않는다.
- 따라서 조회 원가는 사용자 수·사용량과 무관하게 **항상 0**이다. 무료 사용자든
  결제 사용자든 헤비 유저든 우리 비용은 변하지 않는다.

이 조건이 깨지면 이 설계의 근거가 통째로 무너진다. 조회 한도를 두지 않는 것도,
서버 캐시를 만들지 않는 것도, 구독 대신 1회 결제를 택한 것도 전부 여기서 나온다.

**사용자에게 명확히 고지해야 한다.** 구매 화면과 웹스토어 설명에 "AI 사용료는
본인 API 키로 별도 청구됨"을 적는다. 이걸 빠뜨리면 "$3 냈는데 왜 또 돈이
나가냐"는 환불 요청이 발생한다.

## 하지 않을 것

- AI 조회 횟수 제한. 사용자 키로 사용자가 지불하므로 우리가 막을 근거가 없다.
- 기본 번역(Google Translate) 제한. 원가가 0이고 매일 열 이유를 만든다.
- 서버 측 라이선스 강제 검증. $3짜리 잠금에 비해 과하다 (아래 "우회 가능성" 참고).
- 서버 측 단어 캐시. BYOK에서는 우리가 비용을 내지 않으므로 이유가 사라졌다.

## 판매 구성

| 기능 | 무료 | $3 결제 후 | 우리 원가 |
|---|---|---|---|
| AI 단어·구문 조회 | 무제한 — **본인 키, 본인 부담** | 무제한 — **본인 키, 본인 부담** | **0** |
| 기본 번역 | 무제한 | 무제한 | 0 |
| 단어 저장 | 50개까지 | 제한 없음 | 0 |
| 복습(Review) | 잠김 | 열림 | 0 |
| xlsx 내보내기 | 잠김 | 열림 | 0 |

AI 조회 칸이 무료와 결제 후가 같다는 점에 주목할 것. **$3는 AI를 사지 않는다.**
잠금이 걸리는 세 줄은 전부 원가가 0인 소프트웨어 기능이며, 그래서 1회 결제로
영구 제공해도 손실이 누적되지 않는다.

가격은 $3. $1은 Stripe 고정 수수료 $0.30이 매출의 33%를 가져가지만 $3에서는
13%로 떨어진다. 1회 결제라 $1 대비 저항 차이는 작다.

## 아키텍처

전환 후 워커는 **라이선스 확인 전용**이 된다. 엔드포인트는 셋만 남는다.

```
확장 (Own Key) ──직접──> api.anthropic.com / generativelanguage / api.openai.com
      │
      └─ 라이선스 확인 ──> Worker ── /v1/me        (구매 여부 조회)
                                  ├─ /v1/checkout  (Stripe 결제 세션)
                                  └─ /stripe/webhook
                                        │
                                        └──> KV: user:<google_sub>
```

Own Key 직접 호출은 이미 구현되어 있다 — `service-worker.js`의 Anthropic(586행),
Gemini(622행), OpenAI(662행). 새로 만들 호출 코드는 없다.

### 라이선스 데이터 모델

Google 계정을 라이선스 식별자로 유지한다. 이미 동작하고, 기기가 바뀌어도 구매가
따라오며, 붙여넣기식 라이선스 키와 달리 공유가 어렵다.

KV에 두 개의 키를 쓴다. 본체와, 환불 처리를 위한 역방향 색인이다.

```
user:<google_sub> = {
  sub:            "116730542516590468814",
  email:          "user@example.com",
  paid:           true,
  purchasedAt:    1788147269697,
  paymentIntentId: "pi_..."
}

payment:<payment_intent_id> = "<google_sub>"
```

만료·상태·갱신 필드가 없다. `paid`가 `true`가 되면 그대로 유지된다.

역방향 색인이 필요한 이유는 환불 웹훅 때문이다. `charge.refunded` 이벤트는
`charge.payment_intent`는 주지만 Google 계정은 모른다. `mode: 'payment'`
체크아웃은 설정에 따라 Stripe Customer를 만들지 않을 수도 있어서 고객 ID에
의존할 수 없다. PaymentIntent는 어떤 경우에도 존재하므로 이것을 연결 고리로 쓴다.

### 결제 흐름

1. 사용자가 잠긴 기능을 누른다 → 구매 안내가 뜬다.
2. 구매 버튼 → 서비스 워커가 Google 로그인을 요구한다(미로그인 시).
3. `/v1/checkout` → Stripe Checkout Session (`mode: 'payment'`), 새 탭에서 열림.
   `client_reference_id`에 Google `sub`을 실어 보낸다.
4. 결제 완료 → `checkout.session.completed` 웹훅 → KV에 `paid: true` 기록.
5. 확장이 `/v1/me`로 확인 → 잠금 해제.

`mode: 'payment'`이므로 구독 객체가 생성되지 않고, 구독 관련 웹훅도 오지 않는다.

### 환불 처리

Stripe 대시보드에서 환불하면 `charge.refunded` 웹훅으로 `paid: false`로 되돌린다.
`charge.payment_intent` → `payment:<id>` 색인 → `user:<sub>` 순으로 찾아간다.
"구매 → 환불 → 계속 사용"을 막기 위한 최소 장치다. 웹훅 이벤트는 두 개만 구독한다:
`checkout.session.completed`, `charge.refunded`.

환불 후에도 저장된 단어는 지우지 않는다. 잠기는 것은 기능이지 사용자의 데이터가
아니다.

### `/v1/me` 응답

```
{ signedIn: true,  email: "user@example.com", paid: true  }
{ signedIn: true,  email: "user@example.com", paid: false }
{ signedIn: false, email: null,               paid: false }
```

기존 `/v1/me`가 요구하던 `deviceId`는 더 이상 받지 않는다. 무료 티어 미터링이
없어져 익명 식별자가 필요 없기 때문이다. 미로그인 호출은 오류가 아니라
`paid: false`로 정상 응답한다.

### 확장 쪽 상태 관리

`/v1/me` 결과를 `chrome.storage.local`에 캐시해 기능을 쓸 때마다 서버를 부르지
않는다. 갱신 시점은 셋이다.

- 사이드패널·옵션 페이지가 열릴 때
- 로그인/로그아웃 직후
- 결제 완료 후 새로고침

로그인 상태 변경 브로드캐스트는 기존 `planChangedAt` 메커니즘을 그대로 쓴다
(`service-worker.js`의 `notifyPlanChanged()`).

## 잠금 지점

세 곳 모두 사이드패널에 있다.

| 기능 | 위치 | 무료일 때 동작 |
|---|---|---|
| 단어 저장 | `sidepanel.js` `toggleSaved` | 51번째 저장 시도에서 차단, 구매 안내 |
| 복습 | Review 탭 진입 | 탭은 보이되 잠금 화면 + 구매 버튼 |
| 내보내기 | `sidepanel.js` 내보내기 버튼 | 클릭 시 구매 안내 |

**이미 저장된 단어는 절대 지우지 않는다.** 이전 버전에서 50개를 넘겨 저장한
사용자가 있다면 그 단어들은 그대로 두고, 새로 추가하는 것만 막는다. 사용자가 모은
자산을 소급해서 뺏지 않는다.

저장 개수는 Saved 탭에 `47/50`처럼 상시 표시해 한도가 갑작스럽지 않게 한다.
구매 후에는 개수만 표시한다.

### 우회 가능성

세 잠금 모두 클라이언트에서 검사하므로 확장 코드를 고칠 수 있는 사용자는 우회할 수
있다. 의도한 선택이다. $3 결제를 우회하려고 확장을 리버싱하는 사람은 애초에 결제
대상이 아니고, 서버 검증을 붙이면 오프라인에서 단어장을 못 쓰게 되는 손해가 더 크다.

## 삭제 대상

### 워커 (`worker/index.js`)

```
/v1/complete 라우트와 handleComplete()
buildPrompt(), wordPrompt(), phrasePrompt()
meter(), refund(), UsageCounter (Durable Object 클래스)
resolveEntitlement(), isActive(), periodEndMs()
customer.subscription.updated / .deleted 핸들러
invoice.payment_failed 핸들러
handlePortal() 과 /v1/portal 라우트
CONFIG의 MODEL, MAX_TOKENS, FREE_DAILY_LIMIT, PRO_MONTHLY_LIMIT, GRACE_MS
```

`findSubByCustomer()`와 `customer:<id>` 색인은 제거한다. 환불 역추적은
`payment:<payment_intent_id>` 색인으로 대체된다.

### 설정 (`worker/wrangler.toml`)

```
[[durable_objects.bindings]]  USAGE     ← 제거
[[migrations]]                          ← 제거
STRIPE_PRICE_ID                         ← 1회성 Price ID로 교체
```

시크릿에서 `CLAUDE_API_KEY`와 사용하지 않는 `ACCESS_CODES`를 삭제한다.

### 확장

```
manifest.json      host_permissions에서 *.workers.dev 외 프록시 관련 정리 불필요
                   (Own Key가 직접 호출하므로 3개 provider 도메인은 유지)
options.html/js    Pro / Own Key 모드 토글 제거 — Own Key만 남음
service-worker.js  accessMode 분기 제거, 기본값을 own으로
                   callProxy() 및 조회용 proxyPost 경로 삭제
                   getDeviceId() 삭제 (무료 미터링이 없어짐)
sidepanel.js       사용량 배지(quota-badge) 제거 — 셀 사용량이 없음
```

`proxyPost()` 자체는 `/v1/me`·`/v1/checkout` 호출에 계속 쓰이므로 남긴다.

## 온보딩

Pro 모드가 사라지므로 **API 키가 없으면 확장이 아무것도 못 한다.** 이것이 이
설계의 가장 큰 제품 리스크이며, 온보딩이 성패를 가른다.

옵션 페이지 첫 화면을 키 발급 안내로 바꾼다. **Gemini를 첫 번째로 제시한다** —
무료 등급이 있어 카드 등록 없이 키를 받을 수 있고, 일반 학습자가 넘을 수 있는
유일한 장벽 높이다. Anthropic·OpenAI는 그 아래에 둔다.

## 오류 처리

| 상황 | 동작 |
|---|---|
| API 키 미설정 | 조회 시 옵션 페이지로 유도하는 안내 |
| 사용자 키가 거부됨(401/403) | 제공자가 준 사유를 그대로 노출하고 키 확인 안내 |
| 사용자 키 사용량 초과(429) | 잠시 후 재시도 안내 (우리 한도가 아님을 명시) |
| `/v1/me` 실패 | 캐시된 `paid` 값으로 동작. 서버가 죽어도 구매자가 잠기지 않는다 |
| 미로그인 상태에서 구매 시도 | 로그인부터 유도 (기존 `openCheckout` 흐름과 동일) |

`/v1/me` 실패 시 캐시를 신뢰하는 것은 의도적이다. 결제한 사용자가 네트워크 문제로
자기 단어장을 못 쓰는 상황을 막는 쪽이 우회 위험보다 중요하다.

## 테스트

- **결제 경로**: 테스트 카드로 1회 결제 → KV에 `paid: true` 기록 확인 →
  세 기능이 열리는지 확인.
- **환불 경로**: Stripe 대시보드에서 환불 → `charge.refunded` 수신 →
  `paid: false` 확인 → 기능이 다시 잠기고 저장된 단어는 남아 있는지 확인.
- **무료 한도**: 저장 50개까지 되고 51번째가 차단되는지, 안내가 뜨는지.
- **기존 사용자 보호**: `savedWords`에 60개를 넣은 상태에서 무료로 전환해도
  60개가 그대로 보이고 추가만 막히는지.
- **다기기**: A기기에서 결제 → B기기에서 같은 Google 계정 로그인 → 잠금 해제.
- **BYOK 조회**: Gemini 무료 키로 단어 조회가 되는지 (프록시 제거 후).
- **불변 조건 검증**: 워커 코드에 AI 제공자 호출이 하나도 남지 않았는지 확인한다.
  `api.anthropic.com`, `generativelanguage`, `api.openai.com` 문자열이 워커에서
  전부 사라져야 하고, `wrangler secret list`에 `CLAUDE_API_KEY`가 없어야 한다.
  결제 계정으로 조회를 돌려도 워커 로그에 요청이 찍히지 않아야 한다 — 확장이
  제공자를 직접 부르므로 워커를 거치지 않는 것이 정상이다.

## 이관 메모

v1.1.0은 아직 배포되지 않았고, 구독자는 개발 중 만든 테스트 계정 하나뿐이므로
실사용자 이관 문제는 없다. Stripe의 기존 구독 Price는 남겨두되 사용하지 않는다.

제거하는 코드는 커밋 `3872264`에 전체가 남아 있으므로, 호스팅형 Pro 모드를
나중에 되살리고 싶으면 그 시점에서 복원할 수 있다.

## 남은 리스크

1. **API 키 장벽.** BYOK는 키를 발급받을 의향이 있는 사용자만 남긴다. Gemini
   온보딩이 얼마나 매끄러운지가 사용자 수를 결정한다.
2. **$3의 가치 입증.** 저장·복습·내보내기 묶음이 $3만큼의 가치로 느껴져야 한다.
   느껴지지 않으면 가격이 아니라 그 기능들의 완성도 문제다.
3. **클라이언트 잠금.** 우회가 가능하다. 의도한 절충이지만, 우회가 실제로
   퍼진다면 그때 서버 검증을 재검토한다.
