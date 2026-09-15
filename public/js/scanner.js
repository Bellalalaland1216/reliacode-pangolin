// ============ 通用手机扫码组件 ============
// 用法:
//   openScanner({ onScanned: (code) => {...}, title: '请扫描箱码' })
//   openScanner({ onScanned: (code) => {...}, continuous: true })  // 连续扫码模式
// 默认模式：扫码成功后自动调用 onScanned(纯码值)，并关闭摄像头
// 连续模式：识别成功后不关摄像头，持续回调，适合装箱等批量扫码场景
// 外部可调用 stopScanner() 主动关闭（如需要用户填表时暂停扫码）
// 注意: 手机摄像头扫码需要 HTTPS 环境（localhost 除外）

let _currentScanner = null;
let _currentScannerId = null;

// 对外：主动关闭扫码器
function stopScanner() {
  if (_currentScanner) {
    try { _currentScanner.stop().catch(() => {}); } catch (e) {}
    _currentScanner = null;
  }
  _currentScannerId = null;
  const m = document.getElementById('scannerMask');
  if (m) m.remove();
}

function openScanner(options) {
  const { onScanned, title = '请将二维码对准取景框', continuous = false } = options;

  // 先关掉上一次的
  if (_currentScanner) {
    try { _currentScanner.stop(); } catch (e) {}
    _currentScanner = null;
    _currentScannerId = null;
  }

  // 创建遮罩层
  const mask = document.createElement('div');
  mask.id = 'scannerMask';
  mask.className = 'scanner-mask';

  const panel = document.createElement('div');
  panel.className = 'scanner-panel';
  const heading = document.createElement('div');
  heading.className = 'scanner-heading';
  const cameraIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  cameraIcon.setAttribute('class', 'ui-icon');
  cameraIcon.setAttribute('aria-hidden', 'true');
  const cameraUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  cameraUse.setAttribute('href', '/icons/ui.svg#camera');
  cameraIcon.appendChild(cameraUse);
  const headingText = document.createElement('span');
  headingText.textContent = String(title || '请将二维码对准取景框');
  heading.append(cameraIcon, headingText);

  const region = document.createElement('div');
  region.id = 'scannerRegion';
  region.className = 'scanner-region';
  const hint = document.createElement('div');
  hint.id = 'scannerHint';
  hint.className = 'scanner-hint';
  hint.textContent = '正在启动摄像头...';
  const closeBtn = document.createElement('button');
  closeBtn.id = 'scannerCloseBtn';
  closeBtn.className = 'btn btn-outline scanner-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '关闭';
  panel.append(heading, region, hint, closeBtn);
  mask.appendChild(panel);
  document.body.appendChild(mask);
  const scanId = Date.now();
  _currentScannerId = scanId;

  const closeScanner = () => {
    if (_currentScannerId !== scanId) return;
    if (_currentScanner) {
      try { _currentScanner.stop().catch(() => {}); } catch (e) {}
      _currentScanner = null;
    }
    mask.remove();
  };

  closeBtn.addEventListener('click', closeScanner);

  // 判断是否 HTTPS / localhost
  const isSecure = window.location.protocol === 'https:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  if (typeof Html5Qrcode === 'undefined') {
    hint.textContent = '扫码组件加载失败，请刷新页面重试';
    return;
  }

  if (!isSecure) {
    hint.textContent = '手机摄像头扫码需要 HTTPS 访问\n请用 https:// 打开本系统（部署后自动支持），或用微信/浏览器扫二维码进入';
  }

  try {
    // 连续模式防重复：同一码停留在取景框内只触发一次
    let lastCode = null, lastTime = 0;

    _currentScanner = new Html5Qrcode('scannerRegion');
    _currentScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      (decodedText) => {
        const code = extractCode(decodedText);
        const now = Date.now();
        if (continuous) {
          // 同一码 5 秒内重复识别视为同一次（取景框未移开），刷新时间戳
          if (code === lastCode && now - lastTime < 5000) {
            lastTime = now;
            return;
          }
          lastCode = code;
          lastTime = now;
          hint.textContent = '已识别 ' + code + '，继续扫下一个';
          onScanned(code);
        } else {
          hint.textContent = '识别成功！';
          // 成功先停再回调
          closeScanner();
          onScanned(code);
        }
      },
      () => {}
    ).then(() => {
      if (_currentScannerId === scanId) {
        hint.textContent = continuous
          ? '摄像头已开启，连续扫码中，扫完关闭即可退出'
          : '摄像头已开启，请对准二维码';
      }
    }).catch((err) => {
      hint.textContent = '无法开启摄像头：' + (err && err.message ? err.message : '权限被拒绝或非HTTPS环境') + '\n可改为手动输入码值';
    });
  } catch (err) {
    hint.textContent = '无法开启摄像头，请使用HTTPS访问或用扫码枪';
  }
}

// 从完整URL或纯码值中提取溯源码
function extractCode(input) {
  if (!input) return input;
  const s = String(input).trim();
  const m = s.match(/([BS][A-Z0-9]+)/);
  return m ? m[1] : s;
}

// ============ 取消操作二次确认弹窗（取消入库 / 取消发货通用） ============
// 用法: showCancelConfirm(title, subtitleHtml, codes[], onConfirm)
//   - title: 弹窗标题
//   - subtitleHtml: 副标题（可含 HTML，如数量加粗）
//   - codes: 待取消的码数组（字符串），弹窗内列表展示
//   - onConfirm: 点「确认取消」回调（异步）
function showCancelConfirm(title, subtitleHtml, codes, onConfirm) {
  let mask = document.getElementById('cancelConfirmMask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'cancelConfirmMask';
    mask.className = 'cancel-confirm-mask';
    mask.innerHTML = `
      <div class="cancel-confirm-panel">
        <div class="cancel-confirm-icon"><svg class="ui-icon ui-icon-lg" aria-hidden="true"><use href="/icons/ui.svg#alert"></use></svg></div>
        <div class="cancel-confirm-title" id="cancelConfirmTitle"></div>
        <div class="cancel-confirm-sub" id="cancelConfirmSub"></div>
        <div class="cancel-confirm-list" id="cancelConfirmList"></div>
        <div class="cancel-confirm-actions">
          <button type="button" class="btn btn-outline cancel-confirm-cancel" id="cancelConfirmCancelBtn">取消</button>
          <button type="button" class="btn btn-danger cancel-confirm-ok" id="cancelConfirmOkBtn">确认取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);
    mask.querySelector('#cancelConfirmCancelBtn').addEventListener('click', () => {
      mask.classList.remove('is-open');
    });
  }
  document.getElementById('cancelConfirmTitle').innerHTML = title;
  document.getElementById('cancelConfirmSub').innerHTML = subtitleHtml || '';
  const list = document.getElementById('cancelConfirmList');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  list.innerHTML = (codes || []).map(c => `<span class="cancel-confirm-code">${esc(c)}</span>`).join('');
  const okBtn = document.getElementById('cancelConfirmOkBtn');
  okBtn.textContent = '确认取消';
  okBtn.onclick = async () => {
    okBtn.disabled = true;
    okBtn.textContent = '执行中…';
    try {
      await onConfirm();
      mask.classList.remove('is-open');
    } finally {
      okBtn.disabled = false;
      okBtn.textContent = '确认取消';
    }
  };
  mask.classList.add('is-open');
}
