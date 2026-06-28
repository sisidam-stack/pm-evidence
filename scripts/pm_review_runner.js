#!/usr/bin/env node
/**
 * PM Review Runner v2.0
 * PM側独立取得スクリプト。Claude Codeの証跡とは独立して公開HTMLを取得・検証する。
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');
const zlib  = require('zlib');

const SITE_KEY             = process.env.SITE_KEY             || '';
const PUBLIC_URL           = process.env.PUBLIC_URL           || '';
const BUNDLE_ID            = process.env.BUNDLE_ID            || '';
const REVIEW_ID            = process.env.REVIEW_ID            || '';
const EXPECTED_HASH        = process.env.EXPECTED_LIVE_HTML_HASH || '';
const OUTPUT_DIR           = process.env.OUTPUT_DIR           || '/tmp/pm-review-output';

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'PM-Review-Runner/2.0 (independent-verification)',
        'Accept-Encoding': 'gzip, deflate',
        'Cache-Control': 'no-cache, no-store',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout: ' + url)); });
  });
}

async function run() {
  const startedAt = new Date().toISOString();
  const result = {
    runner: 'PM Review Runner v2.0',
    started_at: startedAt,
    site_key: SITE_KEY,
    public_url: PUBLIC_URL,
    bundle_id: BUNDLE_ID,
    review_id: REVIEW_ID,
    expected_live_html_hash: EXPECTED_HASH,
    checks: {},
    blocking_reasons: [],
    overall_status: 'PASS',
  };

  console.log(`[PM Review Runner] Starting: ${SITE_KEY} / ${BUNDLE_ID}`);
  console.log(`[PM Review Runner] Target URL: ${PUBLIC_URL}`);

  // ── 1. 公開HTML 独立取得（環境に応じてPlaywright or HTTPフォールバック）──
  const USE_PLAYWRIGHT_HTML = process.env.USE_PLAYWRIGHT_HTML !== 'false';
  console.log(`[PM Review Runner] Fetching HTML (playwright=${USE_PLAYWRIGHT_HTML})...`);
  let publicHtml = '';
  let publicHash = '';
  try {
    if (USE_PLAYWRIGHT_HTML) {
      const { chromium } = require('playwright');
      const LAUNCH_OPT = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      };
      // ホスティング側のbot保護を回避するため最大3回リトライ
      let attempt = 0;
      const MAX_ATTEMPTS = 3;
      while (attempt < MAX_ATTEMPTS) {
        attempt++;
        console.log(`[PM Review Runner] Playwright fetch attempt ${attempt}/${MAX_ATTEMPTS}...`);
        const browser = await chromium.launch(LAUNCH_OPT);
        const ctx0 = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          viewport: { width: 1280, height: 900 },
        });
        const page0 = await ctx0.newPage();
        await page0.goto(PUBLIC_URL, { waitUntil: 'networkidle', timeout: 30000 });
        // bot challenge が解除されるまで最大8秒待機
        await page0.waitForFunction(() => !document.title.includes('moment') && !document.title.includes('please'), { timeout: 8000 }).catch(() => {});
        publicHtml = await page0.content();
        await browser.close();
        const isChallenge = publicHtml.includes('One moment') || publicHtml.includes('cf_challenge') || publicHtml.length < 20000;
        if (!isChallenge) { console.log(`[PM Review Runner] Got real HTML on attempt ${attempt}`); break; }
        console.warn(`[PM Review Runner] Challenge page detected on attempt ${attempt}, retrying...`);
        if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 3000));
      }
    } else {
      // HTTP-only モード（Codex/制限環境向け）
      const res = await fetchUrl(PUBLIC_URL);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      publicHtml = res.body.toString('utf-8');
      console.log(`[PM Review Runner] HTTP fetch done. Size: ${publicHtml.length}`);
    }

    // CloudFlare bot チャレンジ検出
    const isCloudflareChallenge = publicHtml.includes('One moment, please') ||
      publicHtml.includes('cf-browser-verification') ||
      publicHtml.includes('cf_challenge');
    if (isCloudflareChallenge) {
      console.warn('[PM Review Runner] WARNING: CloudFlare bot challenge detected. Azure IP ranges are blocked.');
      result.checks.html_fetch = 'WARNING: CloudFlare challenge (Azure datacenter IP blocked)';
      result.cloudflare_blocked = true;
      // コンテンツ検証はスキップ（チャレンジページを検証しても意味がないため）
      result.checks.wakaru_single = 'SKIPPED (CloudFlare blocked)';
      result.checks.lead_single = 'SKIPPED (CloudFlare blocked)';
      result.checks.dup_judge_absent = 'SKIPPED (CloudFlare blocked)';
      result.checks.table_fixed = 'SKIPPED (CloudFlare blocked)';
      result.checks.template_leak = 'SKIPPED (CloudFlare blocked)';
      result.checks.pc_title_dom_absent = 'SKIPPED (CloudFlare blocked)';
      // screenshots は引き続き取得（チャレンジページの画像も証跡として残す）
    } else {
      const buf = Buffer.from(publicHtml, 'utf-8');
      publicHash = crypto.createHash('md5').update(buf).digest('hex');
      fs.writeFileSync(path.join(OUTPUT_DIR, 'pm-public.html'), publicHtml);
      fs.writeFileSync(path.join(OUTPUT_DIR, 'pm-public.txt'),
        publicHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 200000));
      result.actual_live_html_hash = publicHash;
      result.checks.html_fetch = 'PASS';
      console.log(`[PM Review Runner] HTML fetched. Size: ${publicHtml.length}. Hash: ${publicHash}`);
    }
  } catch (e) {
    result.checks.html_fetch = `FAIL: ${e.message}`;
    result.blocking_reasons.push(`公開HTML取得失敗: ${e.message}`);
  }

  // ── 2. live_html_hash 確認（参考情報・非blocking）────────────────────
  // Note: Claude Code は Python urllib でハッシュを計算。PM Runner は Playwright（DOM描画後）で取得。
  // 取得方式が異なるため hash は一致しない場合がある。これは INFO 扱い（blocking しない）。
  if (EXPECTED_HASH && publicHash) {
    const match = publicHash === EXPECTED_HASH;
    result.checks.hash_match = match ? 'MATCH' : `INFO(expected=${EXPECTED_HASH.slice(0,8)} runner=${publicHash.slice(0,8)} — 取得方式が異なるため差異あり)`;
    result.pm_actual_hash = publicHash;
    console.log(`[PM Review Runner] Hash comparison (INFO only): ${match}`);
  }

  // ── 3. DOM 独立検証 ───────────────────────────────────────────────────
  const domSummary = { checked_at: new Date().toISOString(), public_url: PUBLIC_URL };

  if (publicHtml && !result.cloudflare_blocked) {
    // この記事でわかること
    const wakaruCount = (publicHtml.match(/この記事でわかること/g) || []).length;
    domSummary.wakaru_count = wakaruCount;
    result.checks.wakaru_single = wakaruCount === 1 ? 'PASS' : `FAIL(count=${wakaruCount})`;
    if (wakaruCount !== 1) result.blocking_reasons.push(`「この記事でわかること」出現数=${wakaruCount}（期待値=1）`);

    // lp-toc-pc-title DOM
    const hasPcTitleDom = /class="lp-toc-pc-title/.test(publicHtml);
    domSummary.has_pc_title_dom = hasPcTitleDom;
    result.checks.pc_title_dom_absent = !hasPcTitleDom ? 'PASS' : 'FAIL(pc-title-div残存)';
    if (hasPcTitleDom) result.blocking_reasons.push('lp-toc-pc-title DOMが残存');

    // 導入文
    const leadCount = (publicHtml.match(/気になっている方も多い/g) || []).length;
    domSummary.lead_count = leadCount;
    result.checks.lead_single = leadCount === 1 ? 'PASS' : `FAIL(count=${leadCount})`;
    if (leadCount !== 1) result.blocking_reasons.push(`導入文出現数=${leadCount}（期待値=1）`);

    // 意味重複
    const dupJudge = (publicHtml.match(/判断することが重要/g) || []).length;
    domSummary.dup_judge_count = dupJudge;
    result.checks.dup_judge_absent = dupJudge === 0 ? 'PASS' : `FAIL(count=${dupJudge})`;

    // 比較表
    const tableFixed = /table-layout\s*:\s*fixed/.test(publicHtml);
    domSummary.table_layout_fixed = tableFixed;
    result.checks.table_fixed = tableFixed ? 'PASS' : 'FAIL';
    if (!tableFixed) result.blocking_reasons.push('比較表 table-layout:fixed なし');

    // テンプレ流用語
    const templateLeakWords = ['製品保証','工事保証','定期点検','施工'].filter(w => publicHtml.includes(w));
    domSummary.template_leak_words = templateLeakWords;
    result.checks.template_leak = templateLeakWords.length === 0 ? 'PASS' : `FAIL(${templateLeakWords.join(',')})`;
    if (templateLeakWords.length > 0) result.blocking_reasons.push(`テンプレ流用語: ${templateLeakWords.join(', ')}`);

    // H2 リスト
    const h2Matches = [...publicHtml.matchAll(/<h2[^>]*>(.*?)<\/h2>/gsi)];
    domSummary.h2_list = h2Matches.map(m => m[1].replace(/<[^>]+>/g,'').trim())
      .filter(h => !['Recent Posts','Recent Comments','Archives','Categories'].includes(h));

    // lp-review 件数
    domSummary.lp_review_count = (publicHtml.match(/lp-review/g) || []).length;

    fs.writeFileSync(path.join(OUTPUT_DIR, 'pm-dom-summary.json'),
      JSON.stringify(domSummary, null, 2));
    console.log('[PM Review Runner] DOM checks done:', result.checks);
  }

  // ── 4. Playwright スクリーンショット（PC / SP）────────────────────────
  const USE_PLAYWRIGHT_SS = process.env.USE_PLAYWRIGHT_SS !== 'false';
  if (!USE_PLAYWRIGHT_SS) {
    result.checks.screenshots = 'SKIPPED (playwright disabled in this env)';
    console.log('[PM Review Runner] Screenshots skipped (USE_PLAYWRIGHT_SS=false)');
  } else try {
    const { chromium } = require('playwright');
    console.log('[PM Review Runner] Taking screenshots...');
    const LAUNCH_ARGS = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] };

    for (const [vp, label] of [[1280, 'pc'], [375, 'sp']]) {
      const br = await chromium.launch(LAUNCH_ARGS);
      const ctx = await br.newContext({ viewport: { width: vp, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(PUBLIC_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await page.screenshot({
        path: path.join(OUTPUT_DIR, `pm-${label}-${vp}.png`),
        fullPage: true,
      });
      await br.close();
      console.log(`[PM Review Runner] Screenshot: ${label} ${vp}px done`);
    }
    result.checks.screenshots = 'PASS';
  } catch (e) {
    console.error('[PM Review Runner] Screenshot error:', e.message);
    result.checks.screenshots = `FAIL: ${e.message}`;
    result.blocking_reasons.push(`スクリーンショット取得失敗: ${e.message}`);
  }

  // ── 5. 総合判定 ─────────────────────────────────────────────────────
  if (result.cloudflare_blocked) {
    result.overall_status = 'CLOUDFLARE_BLOCKED';
    result.note = 'GitHub Actions (Azure datacenter) IP が CloudFlare にブロックされています。' +
      'DOM 検証はスキップされました。スクリーンショットは CloudFlare チャレンジページのものです。' +
      'PM は公開URL を直接ブラウザで確認してください: ' + PUBLIC_URL;
  } else {
    result.overall_status = result.blocking_reasons.length === 0 ? 'PASS' : 'FAIL';
  }
  result.completed_at = new Date().toISOString();

  const resultPath = path.join(OUTPUT_DIR, 'pm-review-runner-result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));

  // HTML レポート生成
  const passCount = Object.values(result.checks).filter(v => v === 'PASS' || v === 'MATCH').length;
  const failCount = Object.values(result.checks).filter(v => v !== 'PASS' && v !== 'MATCH').length;
  const htmlReport = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<title>PM Review Runner - ${REVIEW_ID}</title>
<style>body{font-family:sans-serif;max-width:900px;margin:40px auto;padding:0 20px}
.pass{color:green;font-weight:bold}.fail{color:red;font-weight:bold}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px}th{background:#f0f0f0}
pre{background:#f8f8f8;padding:12px;overflow:auto}
</style></head><body>
<h1>PM Review Runner v2.0</h1>
<p><strong>Review ID:</strong> ${REVIEW_ID} | <strong>Bundle:</strong> ${BUNDLE_ID}</p>
<p><strong>Overall:</strong> <span class="${result.overall_status === 'PASS' ? 'pass' : 'fail'}">${result.overall_status}</span></p>
<p><strong>公開URL:</strong> <a href="${PUBLIC_URL}">${PUBLIC_URL}</a></p>
<p><strong>Hash一致:</strong> ${result.checks.hash_match || 'N/A'}</p>
<p><strong>実行日時:</strong> ${result.completed_at}</p>
<h2>Checks</h2>
<table><tr><th>項目</th><th>結果</th></tr>
${Object.entries(result.checks).map(([k,v]) =>
  `<tr><td>${k}</td><td class="${v==='PASS'||v==='MATCH'?'pass':'fail'}">${v}</td></tr>`
).join('')}
</table>
${result.blocking_reasons.length > 0 ? `<h2 style="color:red">Blocking Issues</h2><ul>${result.blocking_reasons.map(r=>`<li>${r}</li>`).join('')}</ul>` : '<h2 class="pass">Blocking Issues: None</h2>'}
<h2>DOM Summary</h2><pre>${JSON.stringify(domSummary||{}, null, 2)}</pre>
<p>PASS: ${passCount} / FAIL: ${failCount}</p>
</body></html>`;
  fs.writeFileSync(path.join(OUTPUT_DIR, 'pm-review.html'), htmlReport);

  console.log(`[PM Review Runner] Overall: ${result.overall_status}`);
  console.log(`[PM Review Runner] Blocking: ${result.blocking_reasons.length} issues`);
  console.log(`[PM Review Runner] Output: ${OUTPUT_DIR}`);

  process.exit(result.overall_status === 'PASS' ? 0 : 1);
}

run().catch(e => {
  console.error('[PM Review Runner] Fatal error:', e);
  process.exit(1);
});
