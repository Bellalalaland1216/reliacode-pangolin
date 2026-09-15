/* Only included by the server for the authenticated AUDIT_VIEWER identity. */
(function () {
  'use strict';
  const message = '只读体验账号不能执行此操作，请使用独立管理员账号。';
  const ids = [
    'addProductBtn','saveProductBtn','genBoxesBtn','genItemsBtn','createPackageBtn',
    'handleAllBtn','batchBtn','changePwdBtn','chooseLogoBtn','logoRemoveBtn','saveSettingsBtn',
    'chooseImagesBtn','chooseVideoBtn','removeVideoBtn','createCampaignBtn','loadBackupsBtn',
    'cameraScanBtn','cancelStockBtn','noBoxModeBtn','confirmProductBtn','applyBoxSizeBtn','changeProductBtn','boxFullNextBtn',
    'openScannerBtn','cancelShipBtn','shipBoxBtn','clearPendingBtn',
    'addDistRegionBtn','addEditRegionBtn','addDistBtn','saveDistBtn',
    'openCreateBtn','createBrandBtn','addFactoryBtn','genInviteBtn','newFactoryBtn','saveUserBtn',
    'boxCode','distSelect','orderNoInput','remarkInput',
    'packageProduct','packageBatch','packageQuantity','packageOriginTitle','packageOriginLocation','packageOccurredAt'
  ];
  const classes = [
    'del-scan-btn','code-action-btn','handle-one-btn','delete-alert-btn','danger-action','warning-action',
    'edit-product-btn','marketing-review-btn','report-del-btn','trace-img-btn',
    'toggle-campaign-btn','delete-campaign-btn','remove-image-btn','remove-pending-btn',
    'edit-dist-btn','delete-dist-btn','region-add','r-remove',
    'edit-user-btn','reset-user-password-btn','toggle-user-btn','delete-user-btn',
    'copy-invite-btn','revoke-invite-btn','delete-invite-btn','rename-brand-btn','toggle-brand-btn','delete-brand-btn','delete-factory-btn'
  ];
  const selectors = ids.map(id => '#' + id).concat(classes.map(name => 'button.' + name));
  if (['/generate','/factory','/distributors','/users','/settings','/profile'].includes(location.pathname)) {
    selectors.push('.container input','.container select','.container textarea','.modal input','.modal select','.modal textarea');
  }
  function disable(el) {
    if (!('disabled' in el)) return;
    if (!el.disabled) el.disabled = true;
    if (!el.hasAttribute('data-readonly-blocked')) {
      el.setAttribute('data-readonly-blocked','true');
      el.setAttribute('aria-describedby','readonlyAccountNotice');
      if (el.tagName === 'BUTTON') el.setAttribute('title',message);
      else if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !el.labels?.length) {
        const label = el.closest('.form-group')?.querySelector('label');
        if (label?.textContent.trim()) el.setAttribute('aria-label',label.textContent.trim());
      }
    }
  }
  function apply() {
    document.querySelectorAll(selectors.join(',')).forEach(disable);
    document.querySelectorAll('form').forEach(form => {
      const url = new URL(form.action || location.href, location.href);
      if (form.method.toUpperCase() !== 'GET' && !['/login','/logout','/api/logout'].includes(url.pathname)) {
        form.querySelectorAll('button,input,select,textarea').forEach(disable);
      }
    });
  }
  document.addEventListener('submit', event => {
    const form = event.target;
    const url = new URL(form.action || location.href, location.href);
    if (form.method.toUpperCase() !== 'GET' && !['/login','/logout','/api/logout'].includes(url.pathname)) {
      event.preventDefault();event.stopImmediatePropagation();
    }
  },true);
  apply();
  new MutationObserver(apply).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
})();
