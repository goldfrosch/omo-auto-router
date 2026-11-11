# omo-auto-router

omo(senpi)에 가상 모델을 추가합니다. 프롬프트마다 난이도(trivial / standard / complex / hard)를 판정하고, 등급마다 설정해 둔 모델로 요청을 보냅니다. 등급별 모델은 `provider/model` 형식으로 적으며, Claude·GLM·GPT 등 provider를 섞어 쓸 수 있습니다.

## 설치

```bash
git clone <this repo> D:/Products/omo-auto-router
cd D:/Products/omo-auto-router
bun run setup      # 설정 파일 생성, 기존 extensions/auto-router.ts 은퇴, settings.json packages 등록
bun run check      # 문제만 점검
bun run uninstall  # setup이 바꾼 것 되돌리기 (auto-router.jsonc는 남김)
```

omo를 재시작한 다음 `/model`에서 프로필(예: `auto/mixed`)을 고릅니다.

## 설정: `~/.omo/agent/auto-router.jsonc`

```jsonc
{
  "classifier": {
    // 앞에서부터 시도합니다. 실패하거나 응답을 해석하지 못하면 다음 모델로 넘어갑니다.
    "models": [{ "model": "zai/glm-5.3-flash", "thinking": "minimal" }, "anthropic-subscription/claude-haiku-4-5"],
    "timeoutMs": 15000
  },
  "profiles": {
    "auto/mixed": {
      "name": "Mixed Auto",
      "contextWindow": 1000000,
      "levels": {
        "trivial":  { "models": ["zai/glm-5.3-flash"], "thinking": "low" },
        "standard": ["zai/glm-5.3", "anthropic-subscription/claude-sonnet-5-5"],
        "complex":  { "models": "anthropic-subscription/claude-sonnet-5-5", "thinking": "high" },
        "hard":     "anthropic-subscription/claude-opus-5-5"
      },
      "tags": { "gpt": { "models": "chatgpt-subscription/gpt-5.6-luna", "thinking": "low" } }
    }
  }
}
```

- 모델 목록은 순서대로 시도합니다. 자격증명이 있는 첫 모델을 쓰고, 일시 오류(429·과부하·5xx)가 나면 재시도 때 다음 모델로 넘어갑니다.
- 등급은 문자열 하나, 목록, `{ models|model, thinking, maxContext }` 객체 중 하나로 적습니다. `thinking`을 생략하면 등급 기본값(low / medium / high / max)을 씁니다.
- 모델별로 thinking을 바꾸려면 `{ "model": "openai/gpt-5", "thinking": "low" }`처럼 적습니다.
- `maxContext`: 컨텍스트가 이 값 이상이면 그 등급을 건너뛰고 한 단계 위 등급을 씁니다.
- `tags`: 프롬프트에 `#gpt`처럼 적으면 그 턴은 해당 경로로 고정됩니다.
- `ceilings`: 가상 모델에서 고른 thinking 레벨(low / medium / high / max)마다 허용할 최대 등급과 최대 thinking을 정합니다. 기본값은 low → standard·low, medium → standard·high, high → hard·high, max → hard·max입니다. 레벨을 빼려면 `null`을 넣습니다.
- 전역 설정: `downgradeMaxContext`(기본 80000, 이 이상이면 낮은 등급으로 내리지 않음), `hardKeywords`, `complexKeywords`(분류기가 실패했을 때 이 단어가 있으면 최소 complex로 올림), `ackWords`, `ackMaxChars`.
- 잡무 규칙: `choreKeywords`, `choreBlockKeywords`, `choreMaxChars`, `choreLevel`. 아래 "잡무(chore) 규칙"을 보세요.
- `compactionModel`(기본 `anthropic-subscription/claude-sonnet-5-5`): 가상 모델 세션의 컨텍스트 압축(compaction) 요약을 보낼 모델입니다. 아래 "압축 요약"을 보세요.

설정 파일이 없으면 기존 `anthropic-subscription/claude-auto` 프로필(Haiku / Sonnet / Opus)을 씁니다. 전체 기본값은 `config.example.jsonc`에 있습니다.

모델 설정을 고치면 다음 프롬프트부터 반영됩니다. 프로필을 추가하거나 지웠다면 `/auto-router reload`를 실행하거나 omo를 재시작해야 합니다.

## 명령

- `/auto-router`: 설정 경로·오류, 분류기·압축 요약 모델, 등급별로 해석된 모델을 보여줍니다. 자격증명이 없는 모델에는 `(unavailable)`이 붙습니다.
- `/auto-router stats [days]`: `~/.omo/agent/logs/auto-router.jsonl`을 집계합니다.
- `/auto-router reload`: 프로필을 다시 등록합니다.

## 판정 순서

`#tag` → hard 키워드 → 잡무(chore) 규칙 → 짧은 수락("응", "ok") 시 현재 등급 유지 → 컨텍스트가 크고 이미 상한 등급이면 고정 → 분류기. tool 호출 후 이어지는 요청과 재시도는 직전 모델을 그대로 써서 프롬프트 캐시를 유지합니다.

## 잡무(chore) 규칙

커밋·푸시·배포 같은 짧은 정형 요청을 긴 세션에서도 싼 등급으로 보냅니다. 기본값은 꺼짐(`"choreKeywords": []`)입니다.

```jsonc
{
  "choreKeywords": ["커밋", "푸시", "배포", "commit", "push", "deploy"],
  "choreBlockKeywords": ["리팩터", "설계", "원인", "왜", "refactor", "design", "why", "debug"],
  "choreMaxChars": 120,     // 앞뒤 공백을 뺼 프롬프트 길이가 이 이하일 때만
  "choreLevel": "standard"  // 잡무로 판정된 턴의 등급
}
```

- 판정: 프롬프트 길이가 `choreMaxChars` 이하이고, `choreKeywords` 중 하나를 포함하고, `choreBlockKeywords`는 하나도 포함하지 않으면 잡무입니다. 대소문자를 가리지 않는 부분 문자열 비교라 한글에도 맞습니다. 그래서 `pr`처럼 짧은 영문 키워드는 `prompt` 같은 다른 단어에도 걸립니다.
- 잡무 턴은 `downgradeMaxContext`를 무시하고 `choreLevel`로 내려갑니다. 모델을 바꾸면 프롬프트 캐시를 한 번 새로 쓰므로, 그 비용을 감수할 만한 짧은 정형 요청에만 쓰세요.
- `hardKeywords`가 먼저 적용됩니다. `ceilings`와 `maxContext`는 그대로 적용되므로, `choreLevel: "trivial"`이어도 컨텍스트가 trivial의 `maxContext`를 넘으면 standard로 올라갑니다.
- 로그(`auto-router.jsonl`)에는 `"source": "rule", "rule": "chore"`로 남습니다.

## 압축 요약 (`compactionModel`)

senpi 기본 compaction은 요약 요청을 세션 모델로 보냅니다. 가상 모델은 라우팅을 거치지 않으면 보낼 수 없어서(`Virtual model ... must be routed before streaming`) 요약이 매번 실패하고 기계적인 대체 요약(deterministic fallback)으로 떨어졌습니다.

이 플러그인은 세션이 시작될 때 senpi의 요약 요청 경로(`ModelRuntime.stream`)를 감쌉니다. 등록된 프로필의 가상 모델로 오는 요약 요청은 `compactionModel` 중 자격증명이 있는 첫 모델로, 하나도 없으면 프로필의 standard 경로로 보냅니다. 실제 모델 요청은 그대로 통과합니다.

- 대화를 처리하던 모델과 다른 모델로 요약하면 프롬프트 캐시를 쓰지 못합니다.
- settings.json에 `compaction.model`을 두면 senpi가 그 모델로 요약하므로 `compactionModel`은 쓰이지 않습니다.

## 개발

```bash
bun test
bun run typecheck   # 로컬에 설치된 senpi 타입으로 tsc 실행
```

thinking 모델(GLM 등)을 분류기로 쓰면 응답이 느려질 수 있습니다. 실측으로 glm-5.3-flash는 4~9초 걸렸습니다. 이럴 때는 `"thinking": "minimal"`을 주거나, thinking이 없는 모델을 앞에 두세요.
