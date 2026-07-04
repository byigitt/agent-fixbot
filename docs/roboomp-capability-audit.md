# Roboomp kabiliyet denetimi

Amaç: `@roboomp` hesabının `can1357/oh-my-pi` reposunda yaptığı işleri bu repodaki `agent-fixbot` ile karşılaştırmak. Kullanım modeli: **GitHub App değil, normal GitHub kullanıcı hesabı / machine user + `gh` CLI/PAT**.

Güncel sonuç: bu repo artık Roboomp benzeri normal-user runner paritesinin büyük kısmını sağlar: issue auto-label polling, comment polling/dispatch, triage, review, fix-ci, address-review, existing PR continuation, labels, status comment upsert, local job lock/stop, PR checks/read-only CI context, review-thread context + optional resolve, prepublish/evidence/live-service guards. Kalan farklar GitHub platform sınırları veya kalite derinliği: Check Run yazma yoktur çünkü GitHub Apps'e özeldir; semantic review hâlâ ajan + evidence contract ağırlıklıdır; workflow log derin korelasyonu sınırlıdır.

## Kaynak aramaları

| Arama | Sonuç | Not |
|---|---:|---|
| `repo:can1357/oh-my-pi type:pr author:roboomp` | 904 | Roboomp tarafından açılmış PR'lar. |
| `repo:can1357/oh-my-pi type:pr author:roboomp state:open` | 61 | Açık Roboomp PR'ları. |
| `repo:can1357/oh-my-pi type:pr author:roboomp state:closed` | 843 | Kapalı Roboomp PR'ları. |
| `repo:can1357/oh-my-pi type:issue commenter:roboomp` | 1427 | Roboomp'un issue altında yorum yaptığı kayıtlar. |
| `repo:can1357/oh-my-pi type:pr commenter:roboomp` | 949 | Roboomp'un PR altında yorum/review yaptığı kayıtlar. |
| `repo:can1357/oh-my-pi type:pr commenter:roboomp -author:roboomp` | 488 | Roboomp'un kendisinin açmadığı PR'larda yorum/review yaptığı kayıtlar. |
| `repo:can1357/oh-my-pi "Resolve codex reviews"` | 9 | İnsanların Roboomp'tan Codex review feedback çözmesini istediği kayıtlar. |
| `repo:can1357/oh-my-pi involves:roboomp` | HTTP 403 | GitHub API bu aramayı reddetti; kullanılmadı. |

Örneklenen kayıtlar: `#4431`, `#4502`, `#4497`, `#4496`, `#4494`, `#4491`, `#4487`, `#4478`, `#4465`, `#4468`, `#4420`, `#4413`, `#4385`, `#3341`, `#4506`, `#4505`, `#4503`, `#4498`, `#2735`.

## Güncel kabiliyet matrisi

| Roboomp kabiliyeti | Kanıt örnekleri | `agent-fixbot` güncel durumu | Durum |
|---|---|---|---|
| Issue/PR referansından fix PR açma | `#4502`, `#4497`, `#4496`, `#4465`, `#4468` | `fix <owner/repo#issue>` issue context alır, workspace hazırlar, ajanı çalıştırır, guard sonrası PR açar veya dry-run URL verir. | **Var** |
| Repro-first düzeltme | Roboomp PR'ları baseline'da fail eden focused test anlatır. | Fix prompt'u repro-first ister; `reproduce <ref>` `.fixbot/reproduction.json` planını expected-failure doğrular. | **Var** |
| Sadece reproduction modu | Repro özetleri ayrıntılı. | `reproduce <ref>` var; source dışı değişiklik guard'ı var. | **Var** |
| Dry-run güvenliği | Güvenli işletim için gerekli. | `--dry-run` GitHub mutasyonlarını kapatır, NoopAgentRunner kullanır. Poll dry-run state yazmaz. | **Var** |
| PR body üretme | Structured PR body. | `.fixbot/result.md` PR body olur; fallback body var. | **Var** |
| Human-review guard | PR review/vouched akışı. | `requireHumanReview` PR body'de görünür; branch protection enforcement repo ayarına bağlı. | **Kısmi** |
| Diff/path guard | Dar PR'lar. | `maxChangedFiles`, `maxDiffLines`, `blockedPaths` enforcement var. | **Var** |
| Prepublish command gate | `gh_push_branch`/gate davranışı. | `.fixbot/prepublish.json` command allowlist + exit-code gate var. | **Var** |
| Test/changelog evidence guard | Roboomp PR'larında test/changelog disiplini. | `.fixbot/evidence.json`, `requireTestEvidence`, `requireChangelog`, passing-status enforcement var. | **Var** |
| Live-service policy | Provider PR'larında live API contract sonucu. | `allowLiveServices:false` live evidence'i bloklar; `requireLiveServiceEvidence` passing live evidence ister. | **Var** |
| Semantic scope guard | `#4503` scope creep/stub uyarıları. | Review prompt'u scope/stub/no-op ister; `.fixbot/evidence.json` içinde `scope.status:"failed"` publish'i bloklar. Otomatik static semantic diff hâlâ sınırlı. | **Kısmi** |
| GitHub secret izolasyonu | Host sınırlarını açık söylüyor. | Agent env'inden `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN` temizlenir. | **Var** |
| Issue açılınca otomatik label | Yeni issue'yu görüp label'lama isteği. | `poll-issues <repo>` open issue listesini okur, PR kayıtlarını filtreler, `autoLabel.rules` ile eksik semantic label'ları ekler; dry-run mutasyon/state yazmaz. | **Var** |
| Issue triage | `#4385`, `#3341`, `#4505`, `#4506` | `triage <ref>` `.fixbot/triage.md` üretir; comment/status/label publish eder. | **Var** |
| Maintainer decision gate | Maintainer kararları ayrılır. | Triage prompt'u maintainer decisions ister; label/approval otomasyonu sınırlı. | **Kısmi** |
| Contributor PR review | `#4503`, `#4413`, `#4498`, `#2735` | `review <pull>` read-only `.fixbot/review.md` üretir; PR diff/reviews/comments/checks context'i vardır. | **Var** |
| CI/flaky teşhisi | `#2735` unrelated flake ayrımı. | `fix-ci` PR check/run summary, changed files, diff ve comments context'iyle çalışır. Workflow log derin korelasyonu sınırlı. | **Kısmi** |
| Review feedback çözme | `#4431`, `#4465`, `#4468`, `#4420`, `#4478` | `address-review <pull>` mevcut branch'i checkout eder, review thread/comment context'iyle patch yapar, aynı PR'a push eder. | **Var** |
| Review thread context | Review comment'lerine commit bazlı cevap. | GraphQL reviewThreads okunur; `.fixbot/resolved-review-threads.json` ile thread resolve best-effort yapılır. | **Var / yetkiye bağlı** |
| Aynı PR/branch'e incremental commit | Review sonrası aynı PR'a commit. | Existing bot PR lookup güvenli: bot-owned + issue marker veya `fixbot/issue-N` branch boundary. | **Var** |
| Status/progress comment | “Looking into this”, “Fix landed”. | Marker'lı status comment upsert; duplicate comment spam'i yerine PATCH. | **Var** |
| Label lifecycle | `triaged`, `review:p*`, provider labels. | `autoLabel.rules` semantic issue label'ları ekler; `policy.statusLabels` üzerinden eski status label'ları kaldırıp yeni status label'ı ekler; gelişmiş priority/domain inference sınırlı. | **Kısmi** |
| Stop/cancel job | Running lifecycle. | Local lock + running PID registry + `stop` var. Aynı host dışındaki process durdurulamaz. | **Kısmi** |
| Comment-triggered orchestration | GitHub yorumlarından tetikleniyor. | `poll-comments` normal user/PAT modeliyle recent issue comments okur, route eder, dispatch eder; daemon/cron tekrarı dışarıdan. | **Var** |
| Check Run yazma | Bot-visible status olabilir. | Bilerek yok: GitHub docs'a göre authenticated users/PAT check run oluşturamaz; yalnızca GitHub Apps. Alternatif: comments/labels/status. | **Platform sınırı** |
| Hosted auth modeli | Roboomp normal User görünüyor. | Normal GitHub user + `gh` CLI/PAT modeli desteklenir; GitHub App planı yok. | **Var** |

## Mevcut botun kanıtlanmış çekirdek akışı

Kod referansları:

- `src/features/cli/commands.ts`: command dispatch, `poll-issues`, `poll-comments`, job lock wiring, mode orchestration.
- `src/features/controller/commentRouter.ts`: `@bot fix`, `fix ci`, `address review`, `triage`, `review`, `stop` parse.
- `src/features/github/ghClient.ts`: issue/PR context, labels, comments, check runs, review threads, upsert comment, labels, thread resolve.
- `src/features/jobs/jobLock.ts`: per-repo#number local lock.
- `src/features/jobs/runningJobs.ts`: PID registry and stop.
- `src/features/prompts/renderPrompt.ts`: mode-specific artifact contracts, resolved-review-thread artifact, evidence artifact.
- `src/features/publisher/statusComments.ts`: marker comment upsert + labels.
- `src/features/publisher/evidenceGate.ts`: test/changelog/live/scope evidence gate.
- `src/features/publisher/commandGate.ts`: prepublish command gate.
- `src/features/publisher/publisher.ts`: diff/command/evidence guard then PR publish/continuation.

## Kalan farklar

1. **Workflow log derinliği:** Check run summary okunur; full Actions log download/correlation henüz yok.
2. **Review thread resolve yetki sınırı:** Normal kullanıcı yetkisi varsa GraphQL mutation çalışır; GitHub UI'da resolve edilemeyen durumlarda bot bunu host sınırı olarak raporlamalı.
3. **Priority/domain label inference:** Keyword tabanlı `autoLabel.rules` var; `review:p1/p2/p3` veya provider/domain label çıkarımı hâlâ sınırlı.
4. **Semantic scope otomasyonu:** Evidence contract ve review prompt'u var; statik olarak unrelated subsystem tespiti hâlâ ajan kalitesine bağlı.
5. **Daemon packaging:** `poll-issues` ve `poll-comments` tek pass; gerçek daemon/cron/systemd/launchd packaging deploy kararına bağlı.

## Güvence kriteri

Normal-user Roboomp paritesi için minimum acceptance:

- `poll-issues` recent open issues okur, PR kayıtlarını filtreler, configured semantic label'ları dry-run güvenliğiyle uygular.
- `poll-comments` recent comments okur, `@bot` komutlarını dispatch eder, state'i güvenli yönetir.
- `@bot fix` issue'dan PR açar veya existing bot PR'a devam eder.
- `@bot address review` PR review comments/thread context'iyle aynı PR'a commit atar.
- `@bot review` contributor PR'ına read-only review comment üretir.
- `@bot triage` implementation başlamadan feasibility/tradeoff/maintainer-decision comment'i üretir.
- `@bot stop` aynı hosttaki job'ı durdurur.
- Status comment upsert ve status labels çalışır.
- Evidence/live-service/prepublish/diff guards publish öncesi çalışır.
- Check run yazma iddia edilmez; normal user modeli comments/labels ile görünürlük sağlar.

## Sonuç

`agent-fixbot`, GitHub App olmadan normal bir GitHub kullanıcı hesabıyla çalışacak Roboomp-benzeri runner paritesine getirildi. Tam üretim işletimi için kalan iş koddan çok deployment seçimi: `poll-comments`'ı hangi host/cron/daemon üzerinde ne sıklıkla çalıştıracağın, workspace cleanup ve bot hesabı yetkilerinin nasıl yönetileceği.
