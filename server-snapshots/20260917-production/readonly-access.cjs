'use strict';
const ROLE = 'AUDIT_VIEWER';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const AUTH_ACTIONS = new Set(['/login', '/logout', '/api/logout']);
const PUBLIC_SETTINGS = new Set(['brand_name','brand_subtitle','logo_text','logo_image','welcome_msg','theme_color','contact_phone','product_images','promo_video','show_scan_count']);
function allowed(method, path) {
  let normalized;
  try { normalized = decodeURIComponent(path).toLowerCase().replace(/\/+$/, '') || '/'; }
  catch { return false; }
  if (/^\/api\/(?:backups?|invitations|verify)(?:\/|$)/.test(normalized)) return false;
  return SAFE.has(method) || (method === 'POST' && AUTH_ACTIONS.has(normalized));
}
function roleAllowed(roles, role, method) {
  return roles.includes(role) || (role === ROLE && ['GET', 'HEAD'].includes(method) && roles.includes('admin'));
}
function publicSettings(rows) {
  return Object.fromEntries(rows.filter(row => PUBLIC_SETTINGS.has(row.key)).map(row => [row.key, row.value]));
}
module.exports = {ROLE, allowed, roleAllowed, publicSettings};
