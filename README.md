# PM Evidence Repository

Evidence Framework v1.2 Final 準拠の PM 独立検証リポジトリ。

## PM Review Runner v2.0

Claude Code の証跡とは独立して、PM が公開URLを直接確認するためのツール。

### GitHub Actions での実行

1. Actions タブ → **PM Review Runner v2.0** → **Run workflow**
2. 以下を入力して実行:

| 項目 | 説明 | consul V6 の値 |
|---|---|---|
| site_key | サイトキー | `consul` |
| public_url | 公開URL | `https://www.consul-tenshoku.com` |
| bundle_id | Bundle ID | `consul-E1-20260628-v6-READY` |
| review_id | Review ID | `CSL-E1-20260628-V6` |
| expected_live_html_hash | Evidence Bundle の hash | `cc392ff824eb9ef1f1ad45c152b67851` |

3. 完了後 Artifacts から以下をダウンロード:
   - `pm-review-runner-result.json` — 総合判定
   - `pm-review.html` — HTML レポート
   - `pm-public.html` — PM が取得した公開HTML
   - `pm-pc-1280.png` — PC 1280px スクリーンショット
   - `pm-sp-375.png` — SP 375px スクリーンショット
   - `pm-dom-summary.json` — DOM 検証サマリー

### ローカル実行

```bash
npm install
SITE_KEY=consul \
PUBLIC_URL=https://www.consul-tenshoku.com \
BUNDLE_ID=consul-E1-20260628-v6-READY \
REVIEW_ID=CSL-E1-20260628-V6 \
EXPECTED_LIVE_HTML_HASH=cc392ff824eb9ef1f1ad45c152b67851 \
OUTPUT_DIR=/tmp/pm-review-output \
npm run pm-review
```

## 独立検証の思想

PM Review Runner が取得するスクリーンショット・HTML は Claude Code の成果物とは完全に独立。

これにより「Claude Code が見た画面と PM が見た画面の不一致」問題を防止する。

## Evidence Framework v1.2 Final

Bundle State Machine:
```
PRE_FLIGHT → GENERATING → READY → PM_REVIEWING → APPROVED
                                               → REJECT → SUPERSEDED
```

詳細: [Evidence Framework Charter](https://github.com/sisidam-stack/affiliate-tool/blob/main/docs/EQAF_REGRESSION.md)
