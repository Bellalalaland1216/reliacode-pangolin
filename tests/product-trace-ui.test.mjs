import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../views/verify.ejs', import.meta.url), 'utf8');

test('consumer result renders the published product-specific sections and reports in order', () => {
  const sequence = [
    'renderProductSection(data, media)',
    'renderTraceSection(data)',
    'renderGallerySection(media)',
    'await renderReportsSection(code)',
    'renderPromotionSection(data)',
    'renderCustomerServiceSection()'
  ];
  let cursor = source.indexOf('async function doVerify');
  assert.ok(cursor >= 0);
  for (const marker of sequence) {
    const index = source.indexOf(marker, cursor + 1);
    assert.ok(index > cursor, `${marker} must follow the previous result section`);
    cursor = index;
  }
  assert.match(source, /data-result-section="verification"/);
  assert.match(source, /data-result-section="product"/);
  assert.match(source, /data-result-section="trace"/);
  assert.match(source, /data-result-section="reports"/);
  assert.match(source, /data-result-section="gallery"/);
  assert.match(source, /data-result-section="promotion"/);
  assert.match(source, /data-result-section="customer-service"/);
});

test('consumer result consumes only product-specific trace, media and promotion fields', () => {
  assert.match(source, /data\.product_media/);
  assert.match(source, /data\.trace_timeline/);
  assert.match(source, /data\.promotion/);
  assert.doesNotMatch(source, /settings\.product_images|settings\.promo_video/);
  assert.match(source, /该产品暂未上传封面图片/);
  assert.match(source, /该批次暂未发布公开溯源履历/);
  assert.match(source, /该产品暂未发布相册图片/);
  assert.match(source, /该产品当前没有品牌活动/);
});

test('dynamic public fields are escaped and product images accept local upload URLs only', () => {
  assert.match(source, /function escapeHtml\(value\)/);
  assert.match(source, /function safeLocalImageUrl\(value\)/);
  assert.ok(source.includes("/^\\/uploads\\/[A-Za-z0-9._-]+$/"));
  assert.match(source, /escapeHtml\(data\.product_name/);
  assert.match(source, /escapeHtml\(description\)/);
  assert.match(source, /escapeHtml\(item\.url\)/);
  assert.match(source, /escapeHtml\(item\.alt\)/);
  assert.doesNotMatch(source, /\$\{(?:data|event|item)\.[a-z_]+\}/i);
});

test('promotion links are HTTPS-only and isolated from the verification result', () => {
  assert.match(source, /function safeHttpsUrl\(value\)/);
  assert.match(source, /parsed\.protocol !== 'https:'/);
  assert.match(source, /parsed\.username \|\| parsed\.password/);
  assert.match(source, /target="_blank" rel="noopener noreferrer"/);
  assert.match(source, /品牌提供的活动信息/);
  assert.doesNotMatch(source, /href="\$\{(?:item|data)\./);
});

test('product carousel remains button-driven without inline handlers or inline style attributes', () => {
  assert.match(source, /data-product-carousel-step/);
  assert.match(source, /data-product-carousel-index/);
  assert.match(source, /addEventListener\('click'/);
  assert.doesNotMatch(source, /\son(?:click|error|load|mouseover)=/i);
  assert.doesNotMatch(source, /\sstyle=/i);
  assert.doesNotMatch(source, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u);
});

// Production intentionally keeps internal distribution details out of the public result.
test('consumer result preserves report media and keeps internal distribution details private', () => {
  const result = source.slice(source.indexOf('async function doVerify'));
  assert.doesNotMatch(result, /renderDistributionSection|data\.resolved_location|data\.first_scan_ip/);
  assert.match(source, /safeLocalImageUrl\(r\.url\)/);
  assert.match(source, /escapeHtml\(r\.id\)/);
});
