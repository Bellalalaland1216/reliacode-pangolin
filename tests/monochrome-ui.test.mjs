import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=name=>readFile(new URL(name,root),'utf8');

test('commercial pages keep a white-first theme with restrained semantic accents',async()=>{
  const [css,style,login,register,print,verify]=await Promise.all([
    read('public/css/monochrome.css'),read('public/css/style.css'),read('views/login.ejs'),read('views/register.ejs'),read('views/print.ejs'),read('views/verify.ejs')
  ]);
  assert.match(style,/^@import url\('\/css\/monochrome\.css\?v=/);
  for(const standalone of [login,register,print,verify])assert.match(standalone,/\/css\/monochrome\.css\?v=/);
  assert.doesNotMatch(css,/body \* \{/);
  assert.match(css,/--primary: #007aff !important;/);
  assert.match(css,/--success: #248a3d !important;/);
  assert.match(css,/--warning: #b85c00 !important;/);
  assert.match(css,/--danger: #d70015 !important;/);
  assert.match(css,/\.topnav a\.active, \.bottom-nav a\.active, \[aria-current="page"\] \{\s*box-shadow: inset 0 -3px #000/s);
  assert.match(css,/\.pagination a\.active \{[^}]*background: #fff !important/s);
  assert.match(css,/\.modal-mask, #printModal, #editModal \{\s*background: #fff !important/s);
  assert.match(css,/\.brand-hero, \.prize-card, \.prize-card\.thanks,/);
  assert.match(css,/\.brand-hero::before \{\s*display: none !important;/s);
  assert.doesNotMatch(verify,/\.brand-hero::before/);
  assert.doesNotMatch(css,/\.btn-primary[^}]+background: #000/s);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/\.ui-icon \{[^}]*width: 1\.1em;[^}]*height: 1\.1em;/s);
  assert.match(css,/\.reg-link a, \.back a \{ display: inline-flex;/);
  assert.match(style,/--accent-product: #007aff;/);
  assert.match(style,/--accent-trace: #248a3d;/);
  assert.match(style,/--accent-code: #5856d6;/);
  assert.match(style,/--accent-campaign: #c93400;/);
  assert.match(style,/\.product-step\[data-step="trace"\]/);
  assert.match(style,/\.function-card::before/);
  assert.match(style,/\.btn-primary \{[^}]*background:var\(--accent-product\) !important/s);
  assert.match(style,/\.btn-success, \.success-action/);
  assert.match(style,/\.btn-warning, \.warning-action/);
  assert.match(style,/\.btn-danger, \.danger-action/);
});

test('every rendered page explicitly keeps browser chrome and controls in light mode',async()=>{
  const files=(await readdir(new URL('views/',root),{recursive:true})).filter(name=>name.endsWith('.ejs')&&!name.startsWith('._')&&!name.startsWith('partials/'));
  for(const file of files){
    const source=await read('views/'+file);
    assert.match(source,/<meta name="color-scheme" content="light">/,`missing light color scheme in ${file}`);
    assert.match(source,/<meta name="theme-color" content="#ffffff">/,`missing white theme color in ${file}`);
  }
  const verify=await read('views/verify.ejs');
  assert.match(verify,/<meta name="apple-mobile-web-app-status-bar-style" content="default">/);
  assert.doesNotMatch(verify,/user-scalable=no|maximum-scale=1/);
  const css=await read('public/css/monochrome.css');
  assert.match(css,/input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="hidden"\]\) \{\s*min-height: 44px;/s);
  assert.match(css,/button:focus-visible, \.btn:focus-visible, a:focus-visible,/);
  assert.match(css,/input\[type="checkbox"\], input\[type="radio"\] \{\s*accent-color: var\(--primary\);/s);
});

test('views contain no emoji glyphs and use the local SVG sprite',async()=>{
  const files=(await readdir(new URL('views/',root),{recursive:true})).filter(name=>name.endsWith('.ejs')&&!name.startsWith('._'));
  const emoji=/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
  for(const file of files)assert.equal(emoji.test(await read('views/'+file)),false,`emoji glyph in ${file}`);
  const sprite=await read('public/icons/ui.svg');
  assert.match(sprite,/<symbol id="home"/);
  assert.match(sprite,/<symbol id="search"/);
  assert.match(sprite,/<symbol id="chevron-right"/);
  assert.match(sprite,/<symbol id="arrow-left"/);
  assert.match(sprite,/<symbol id="plus"/);
  assert.match(sprite,/<symbol id="xmark"/);
  assert.doesNotMatch(sprite,/(?:href|src)="https?:\/\//);
  assert.match(await read('views/settings.ejs'),/icon\('download'\)/);
  assert.doesNotMatch((await Promise.all(files.map(file=>read('views/'+file)))).join('\n'),/[＋×]/);
});

test('the local SVG symbol set is monochrome, complete and self-contained',async()=>{
  const sprite=await read('public/icons/ui.svg');
  const symbolIds=new Set([...sprite.matchAll(/<symbol id="([a-z0-9-]+)" viewBox="0 0 24 24">/g)].map(match=>match[1]));
  assert.ok(symbolIds.size>=25);
  assert.doesNotMatch(sprite,/\b(?:fill|stroke|style|class)=/i);
  assert.doesNotMatch(sprite,/<(?:script|image|foreignObject|use)\b/i);
  assert.equal([...sprite.matchAll(/<symbol\b/g)].length,[...sprite.matchAll(/<symbol id="[a-z0-9-]+" viewBox="0 0 24 24">/g)].length);
  const policy=await read('docs/ui-icon-policy.md');
  assert.match(policy,/cross-platform web service/);
  assert.match(policy,/original, self-contained SVG symbol/);
  assert.match(policy,/aria-label/);
  const files=(await readdir(new URL('views/',root),{recursive:true})).filter(name=>name.endsWith('.ejs')&&!name.startsWith('._'));
  for(const file of files){
    const source=await read('views/'+file);
    const references=[
      ...[...source.matchAll(/icon\('([a-z0-9-]+)'/g)].map(match=>match[1]),
      ...[...source.matchAll(/ui\.svg#([a-z0-9-]+)/g)].map(match=>match[1])
    ];
    for(const reference of references)assert.ok(symbolIds.has(reference),`missing SVG symbol ${reference} used by ${file}`);
  }
});

test('view sources use only the approved white-first semantic palette',async()=>{
  const approved=new Set(['#000','#000000','#fff','#ffffff','#f5f6fa','#1f1f1f','#e8eaed','#1a73e8','#4285f4','#666','#333','#dfe3e8','#b42318','#fff4f3','#ffd0cc']);
  const files=(await readdir(new URL('views/',root),{recursive:true})).filter(name=>name.endsWith('.ejs')&&!name.startsWith('._'));
  for(const file of files){
    const source=await read('views/'+file);
    const colors=source.match(/#[0-9a-fA-F]{3,8}\b/g)||[];
    for(const color of colors)assert.ok(approved.has(color.toLowerCase()),`unapproved color ${color} in ${file}`);
    if(file!=='login.ejs')assert.doesNotMatch(source,/(?:rgb|rgba|hsl|hsla)\s*\(|(?:linear|radial)-gradient\s*\(/i,`unapproved color function in ${file}`);
  }
});

test('interactive navigation uses SVG icons and accessible form labels',async()=>{
  const [login,register,verify,admin,me,business,print,codes,logs,users]=await Promise.all([
    read('views/login.ejs'),read('views/register.ejs'),read('views/verify.ejs'),read('views/admin.ejs'),
    read('views/admin-me.ejs'),read('views/admin-business.ejs'),read('views/print.ejs'),read('views/codes.ejs'),read('views/logs.ejs'),read('views/users.ejs')
  ]);
  for(const source of [login,register,verify,admin,me,business])assert.doesNotMatch(source,/[‹›]/);
  assert.doesNotMatch(login,/[←→]/);
  assert.match(login,/href="\/icons\/ui\.svg#tag"/);
  assert.doesNotMatch(register,/[←→]/);
  assert.match(login,/label for="loginUsername"/);
  assert.match(login,/label for="loginPassword"/);
  assert.match(register,/密码（至少12位，含字母、数字和特殊字符）/);
  assert.doesNotMatch(register,/密码（至少6位）/);
  assert.match(print,/alt="溯源码 <%= c %> 的二维码"/);
  assert.match(codes,/aria-label="查询箱码"/);
  assert.match(logs,/aria-label="选择日志 <%= l.id %>"/);
  assert.match(users,/const passwordIsValid =/);
  assert.match(users,/autocomplete="new-password"/);
  assert.doesNotMatch(users,/至少6位|length < 6/);
  const nav=await read('views/partials/nav.ejs');
  const bottomNav=await read('views/partials/bottom-nav.ejs');
  assert.match(nav,/aria-label="主导航"/);
  assert.match(nav,/aria-current="page"/);
  assert.match(bottomNav,/aria-label="移动端主导航"/);
  assert.match(bottomNav,/aria-current="page"/);
  const css=await read('public/css/style.css');
  assert.match(css,/padding-top: env\(safe-area-inset-top\)/);
  assert.match(css,/\.btn-sm \{ min-height:44px;/);
  assert.match(css,/\.bn-item \{ min-height:50px;/);
});

test('password manager metadata remains on the production login form',async()=>{
  const login=await read('views/login.ejs');
  assert.match(login,/autocomplete="username"/);
  assert.match(login,/autocomplete="current-password"/);
});

test('consumer verification strips dynamic emoji branding and falls back to local SVG',async()=>{
  const verify=await read('views/verify.ejs');
  assert.match(verify,/Extended_Pictographic/);
  assert.match(verify,/safeLogoText/);
  assert.match(verify,/href="\/icons\/ui\.svg#tag"/);
  assert.doesNotMatch(verify,/<%= settings\.logo_text \|\| 'RC' %>/);
  assert.match(verify,/data\.first_scan_region/);
  assert.match(verify,/data\.scan_region/);
  assert.match(verify,/data\.assigned_region/);
  assert.match(verify,/data\.verified_count/);
  assert.doesNotMatch(verify,/data\.(?:items|box_code|distributor|resolved_location|first_scan_location)/);
});
