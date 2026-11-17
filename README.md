# 활협전 세이브 에디터 v1.0 (`LegendOfMortalSaveEditor`)

원시공작소(Obb Studio)의 **활협전(`Legend of Mortal`, Steam AppID `1859910`)** 전용 오프라인 3-Surface 세이브 편집기입니다.

## 주요 실행 방식 (3종 표면)

- **Windows x64 단독 실행 파일**: `LegendOfMortalSaveEditor-v1.0.exe` (`.NET Framework 4.8` + `WebView2` 내장, `%USERPROFILE%\AppData\LocalLow\Obb Studio\Mortal\` 및 Steam 경로 자동 탐색)
- **단독 오프라인 HTML**: `dist/LegendOfMortalSaveEditor-v1.0.html` (CSP `default-src 'none'; connect-src 'none'` 적용, 외부 네트워크 요청 0건, 밝은/어두운 테마 전환)
- **Python 3 CLI 및 로컬 웹 서버**: `lom_editor.py` (`demo`, `discover`, `inspect`, `validate`, `presets`, `edit`, `serve`)

## 지원 세이브 형식 및 구조 (REA 검증 기반)

- **바이너리 포맷**: 전 4종 세이브 `.NET BinaryFormatter` (MS-NRBF) 순수 JavaScript / Python stdlib 양방향 코덱
  - `Save_001..020.dat` / `Save_FastSave_QQ.dat`: `Mortal.Core.GameSave`
  - `Save_auto*.dat`: `Mortal.Core.AutoGameSave`
  - `Legend_001..012.dat`: `Mortal.Core.LegendSave`
  - `Save_universe.dat`: `Mortal.Core.UniverseSave`
- **실세이브 호환성**: Unity `FileMode.OpenOrCreate` 후행 바이트(`trailingBytesCount`) 파싱 시 `MessageEnd(0x0B)` 기준 안전 절단 및 판본별 필드 차이 보존
- **순수 한국어 카탈로그 (`tools/extract_catalog.py` → `src/catalog-data.js`)**: 한자·가나·외부 URL 0건
  - 능력치/문파 59종, 인물 호감도 46종, 비급 102종, 잡물 47종, 귀중품 75종, 특기 150종, 전역 전투 기술 13종, 독술/단조 개발 40종, 도감(사망·엔딩·업적·CG) 217종, 적 세력 24종, 이벤트 플래그 1,069종

## 편집 기능

- **요약 · 시간 · 파생 미리보기 · 프리셋**: 연/월/순(`1=상순, 2=중순, 3=하순`)/낮·밤(`1=낮, 2=밤`), 체험판·계승 플래그, 심상 단계·예상 최대 생명·무학/학문 합계 실시간 미리보기 및 원클릭 프리셋 6종 (`rich_start`, `hero_all_100`, `martial_master`, `tangmen_prosperity`, `full_favorability`, `unlock_all_library`)
- **능력치 · 문파 / 인물 · 호감도 / 비급 · 특기 · 기술**: 분류 필터(`기초·성정`, `무학·학문`, `문파·전투`), 음수·범위 불변식 검사, 신규 비급/특기 추가 및 장착 슬롯 1~4 지정
- **잡물 · 귀중품 · 개발 / 세력 · 이벤트 / 도감 · 전설 / 변경 내역**: 독술·단조 개발도 및 전역 도감 217종 일괄 해금, 실시간 변경 diff 표 및 검증 결과

## 안전 장치

- 게임 실행 중(`Mortal.exe` / `LOM_SIMULATE_GAME_RUNNING=1`) 저장 차단
- 덮어쓰기 전 원본 SHA-256 동시성 검사, SHA-256 검증 `.backup-*.bak` 백업 생성 및 `MoveFileExW` / `os.replace` 원자적 파일 교체
- 심볼릭 링크·디렉터리 정션·재분석 지점·하드링크·NTFS ADS(`:` 스트림)·`..` 상위 이동·예약 장치명(`CON`, `NUL` 등)·UNC 경로·비 `.dat` 쓰기 차단
- WebView2 `e.Source` HTTPS `lom-editor.local` 발신 문서 검증 및 DevTools/외부 탐색/새 창 차단; 로컬 웹 서버 `127.0.0.1` 루프백 + `Host`/`Origin`/`Sec-Fetch-Site` 검사 + 일회성 `X-Lom-Token` 인증

## 빠른 실행 및 검증

```text
python3 tools/extract_catalog.py --check-only
python3 build.py --check
python3 lom_editor.py presets
node tests/test_editor.cjs
python3 -m unittest tests/test_cli_and_server.py
node tests/test_playwright_e2e.cjs
```

## 라이선스

- 본 프로젝트 소스 코드: [MIT License](LICENSE)
- 내장 Microsoft WebView2 로더 재배포 고지: Windows 배포 압축에 `WebView2-LICENSE.txt` 포함
