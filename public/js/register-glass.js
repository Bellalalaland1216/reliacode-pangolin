(() => {
'use strict';
const shell = document.querySelector('.register-shell');
const initialParams = new URLSearchParams(location.search);
const initialMode = initialParams.get('mode') === 'partner' || initialParams.get('code') ? 'partner' : initialParams.get('mode') === 'public' ? 'public' : shell.dataset.mode;
let checkingCode = false;
let activeMode = initialMode;
let invitationRole = '';
let regionCatalog = {};
const publicMsg = document.getElementById('publicMsg');
const partnerMsg = document.getElementById('partnerMsg');
const roleBanner = document.getElementById('roleBanner');

function showMessage(element, text, ok) {
  element.textContent = text;
  element.className = 'msg ' + (ok ? 'ok' : 'error');
  element.classList.toggle('is-hidden', !text);
  if (text && !ok) element.focus({ preventScroll: false });
}

function setMode(mode) {
  activeMode = mode === 'partner' ? 'partner' : 'public';
  shell.dataset.mode = activeMode;
  shell.classList.toggle('is-verified', activeMode === 'partner' && Boolean(invitationRole));
  for (const name of ['public', 'partner']) {
    const selected = name === activeMode;
    document.getElementById(name + 'ModeButton').classList.toggle('is-active', selected);
    document.getElementById(name + 'ModeButton').setAttribute('aria-selected', String(selected));
    document.getElementById(name + 'ModeButton').tabIndex = selected ? 0 : -1;
    document.getElementById(name + 'Panel').classList.toggle('is-hidden', !selected);
  }
  const next = new URL('/register', location.origin);
  if (activeMode === 'partner') {
    next.searchParams.set('mode', 'partner');
    if (initialParams.get('code')) next.searchParams.set('code', document.getElementById('fCode').value);
  }
  history.replaceState(null, '', next.pathname + next.search);
}

async function postRegistration(url, body) {
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('网络连接失败，请检查网络后重试');
  }
  if (url === '/api/register/public' && [403,404].includes(response.status)) {
    throw new Error('当前服务器尚未开放普通用户注册，请使用邀请码注册或返回登录');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('注册服务暂时不可用，请稍后重试');
  }
  return response.json();
}

function passwordIsValid(password) {
  return password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9\s]/.test(password);
}

function normalizeLoginIdentifier(value) {
  const account = String(value || '').trim();
  return account.includes('@') ? account.toLowerCase() : account;
}
function isPublicLoginIdentifier(account) {
  if (/^1\d{10}$/.test(account)) return true;
  const localPart = account.split('@')[0];
  return account.length <= 254 && localPart.length <= 64 && !localPart.startsWith('.') && !localPart.endsWith('.') && !localPart.includes('..') &&
    /^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(account);
}

async function registerPublic(event) {
  event.preventDefault();
  if (event.currentTarget.querySelector('[type="submit"]').disabled) return;
  const body = {
    username: normalizeLoginIdentifier(document.getElementById('publicUsername').value),
    display_name: document.getElementById('publicDisplayName').value.trim(),
    password: document.getElementById('publicPassword').value
  };
  if (!isPublicLoginIdentifier(body.username)) return showMessage(publicMsg, '请输入有效的11位手机号或邮箱地址', false);
  if (!body.display_name) return showMessage(publicMsg, '请填写姓名或昵称', false);
  if (!passwordIsValid(body.password)) return showMessage(publicMsg, '密码至少12位，包含大小写字母、数字和符号', false);
  if (body.password !== document.getElementById('publicPassword2').value) return showMessage(publicMsg, '两次输入的密码不一致', false);

  const button = document.getElementById('publicRegisterButton');
  button.disabled = true;
  button.textContent = '正在创建…';
  try {
    const data = await postRegistration('/api/register/public', body);
    if (!data.success) throw new Error(data.msg || '注册失败');
    showMessage(publicMsg, '注册成功，即将返回登录页', true);
    setTimeout(() => { location.href = '/login'; }, 1200);
  } catch (error) {
    showMessage(publicMsg, error.message || '网络异常，请重试', false);
    button.disabled = false;
    button.textContent = '创建普通用户账号';
  }
}

function fillRegistrationCities() {
  const province = document.getElementById('fProvince').value;
  const city = document.getElementById('fCity');
  city.replaceChildren(new Option(province ? '请选择市级地区' : '请先选择省级地区', ''));
  (regionCatalog[province] || []).forEach(name => city.add(new Option(name, name)));
  city.disabled = !province;
}

async function loadRegistrationRegions() {
  const response = await fetch('/api/regions');
  const data = await response.json();
  regionCatalog = data.countries?.[0]?.provinces || {};
  const province = document.getElementById('fProvince');
  province.replaceChildren(new Option('请选择省级地区', ''));
  Object.keys(regionCatalog).forEach(name => province.add(new Option(name, name)));
}

function resetInvitation() {
  invitationRole = '';
  roleBanner.classList.remove('is-visible');
  shell.classList.remove('is-verified');
  document.getElementById('partnerForm').classList.add('is-hidden');
}

async function checkCode(event) {
  event?.preventDefault();
  if (checkingCode) return;
  const input = document.getElementById('fCode');
  const code = input.value.trim().toUpperCase();
  resetInvitation();
  if (!code) return showMessage(partnerMsg, '请输入邀请码', false);
  const button = document.getElementById('checkCodeBtn');
  checkingCode = true;
  button.disabled = true;
  button.textContent = '正在验证…';
  try {
    const data = await postRegistration('/api/register/check-code', { code });
    if (input.value.trim().toUpperCase() !== code) return;
    if (!data.success) return showMessage(partnerMsg, data.msg || '邀请码无效或已被使用', false);
    invitationRole = data.role;
    showMessage(partnerMsg, '', true);
    roleBanner.textContent = '邀请码已验证 · ' + ({factory: '工厂注册', distributor: '代理商注册', brand: '品牌管理员注册'}[data.role] || '合作方注册');
    roleBanner.classList.add('is-visible');
    document.getElementById('partnerForm').classList.remove('is-hidden');
    shell.classList.toggle('is-verified', activeMode === 'partner');
    document.getElementById('regionGroup').classList.toggle('is-hidden', data.role !== 'distributor');
    document.getElementById('companyLabel').textContent = data.role === 'factory' ? '归属工厂（由邀请码固定）' : (data.role === 'brand' ? '管理员姓名或企业名称' : '公司名称');
    const companyInput = document.getElementById('fCompany');
    companyInput.readOnly = data.role === 'factory' && Boolean(data.factory_name);
    companyInput.classList.toggle('readonly-field', companyInput.readOnly);
    companyInput.value = data.role === 'factory' ? (data.factory_name || '') : '';
    document.getElementById('contactLabel').textContent = data.role === 'factory' ? '联系人姓名（工厂注册必填）' : '联系人/电话（选填）';
    document.getElementById('fContact').placeholder = data.role === 'factory' ? '请填写联系人姓名' : '选填';
    document.getElementById('phoneReq').textContent = data.role === 'factory' ? '工厂注册必填' : '选填';
    if (data.role === 'distributor' && !Object.keys(regionCatalog).length) {
      try { await loadRegistrationRegions(); }
      catch { showMessage(partnerMsg, '地区目录加载失败，请重新验证邀请码后重试', false); }
    }
  } catch (error) {
    if (input.value.trim().toUpperCase() === code) showMessage(partnerMsg, error.message || '网络异常，请重试', false);
  } finally {
    checkingCode = false;
    button.disabled = false;
    button.textContent = '验证邀请码';
  }
}

async function registerPartner(event) {
  event.preventDefault();
  if (event.currentTarget.querySelector('[type="submit"]').disabled) return;
  const body = {
    code: document.getElementById('fCode').value.trim().toUpperCase(),
    username: document.getElementById('fUsername').value.trim(),
    password: document.getElementById('fPassword').value,
    company: document.getElementById('fCompany').value.trim(),
    country: document.getElementById('fCountry').value,
    province: document.getElementById('fProvince').value,
    city: document.getElementById('fCity').value,
    contact: document.getElementById('fContact').value.trim(),
    phone: document.getElementById('fPhone').value.trim()
  };
  if (!invitationRole) return showMessage(partnerMsg, '请先验证邀请码', false);
  if (!body.username) return showMessage(partnerMsg, '请填写账号', false);
  if (!passwordIsValid(body.password)) return showMessage(partnerMsg, '密码至少12位，包含大小写字母、数字和符号', false);
  if (body.password !== document.getElementById('fPassword2').value) return showMessage(partnerMsg, '两次输入的密码不一致', false);
  if (!body.company) return showMessage(partnerMsg, '请填写公司或工厂名称', false);
  if (invitationRole === 'distributor' && (!body.country || !body.province || !body.city)) return showMessage(partnerMsg, '请选择完整的国家、省和市', false);
  if (invitationRole === 'factory') {
    if (!body.contact) return showMessage(partnerMsg, '请填写联系人姓名', false);
    if (!/^1\d{10}$/.test(body.phone)) return showMessage(partnerMsg, '请填写正确的11位手机号', false);
  }

  const button = document.getElementById('partnerRegisterButton');
  button.disabled = true;
  button.textContent = '正在创建…';
  try {
    const data = await postRegistration('/api/register', body);
    if (!data.success) throw new Error(data.msg || '注册失败');
    showMessage(partnerMsg, '注册成功，即将返回登录页', true);
    setTimeout(() => { location.href = '/login'; }, 1200);
  } catch (error) {
    showMessage(partnerMsg, error.message || '网络异常，请重试', false);
    button.disabled = false;
    button.textContent = '创建合作方账号';
  }
}

document.querySelectorAll('.mode-button').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
document.getElementById('publicForm').addEventListener('submit', registerPublic);
document.getElementById('partnerForm').addEventListener('submit', registerPartner);
document.getElementById('inviteForm').addEventListener('submit', checkCode);
document.getElementById('fCode').addEventListener('input', () => { resetInvitation(); showMessage(partnerMsg, '', false); });
document.getElementById('fProvince').addEventListener('change', fillRegistrationCities);
setMode(initialMode);
if (document.getElementById('fCode').value) checkCode();
document.querySelector('.mode-switch').addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 'public' : event.key === 'End' ? 'partner' : activeMode === 'public' ? 'partner' : 'public';
  setMode(next);
  document.getElementById(next + 'ModeButton').focus();
});
for (const id of ['publicPassword','fPassword']) {
  const input = document.getElementById(id);
  const placeholder = input.placeholder;
  input.addEventListener('focus', () => { input.placeholder = '至少12位，含大小写字母、数字和符号'; });
  input.addEventListener('blur', () => { input.placeholder = placeholder; });
}
})();
