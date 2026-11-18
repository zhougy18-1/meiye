const allowedRoles = new Set(['ADMIN', 'MANAGER']);

export function isShopRole(role) {
  return allowedRoles.has(role);
}

// The manager can perform daily reception and ordinary checkout. Later milestones
// will extend this list for reviewed service changes and member-card workflows.
export function managerMayAccess(method, url) {
  const path = url.split('?')[0].replace(/\/+$/, '') || '/';
  if (method === 'GET') {
    return [
      /^\/api\/appointments(?:\/count\/today|\/capacity)?$/,
      /^\/api\/members(?:\/[^/]+(?:\/pending)?)?$/,
      /^\/api\/services$/,
      /^\/api\/staff$/,
      /^\/api\/card-types$/,
      /^\/api\/transactions(?:\/today)?$/,
    ].some(pattern => pattern.test(path));
  }
  if (method === 'POST') {
    return path === '/api/appointments' || path === '/api/members' || path === '/api/transactions';
  }
  if (method === 'PATCH') {
    return /^\/api\/appointments\/[^/]+\/status$/.test(path) || path === '/api/users/password';
  }
  return false;
}

export function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 7) return phone;
  if (/^\d{3}\*+\d{4}$/.test(phone)) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

const phoneKeys = new Set(['phone', 'customerPhone', 'memberPhone', 'phoneNumber', 'mobile']);

export function maskPhoneFields(value) {
  if (Array.isArray(value)) return value.map(maskPhoneFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    phoneKeys.has(key) ? maskPhone(item) : maskPhoneFields(item),
  ]));
}

export async function enforceShopAccess(request, reply, authenticate) {
  const path = request.url.split('?')[0];
  if (!path.startsWith('/api/') || path === '/api/health'
    || path.startsWith('/api/auth/') || path.startsWith('/api/public/')) return;
  if (path === '/api/configs' && request.method === 'GET') return;
  const authenticated = await authenticate(request, reply);
  if (authenticated !== true) return;
  if (request.user.role === 'MANAGER' && !managerMayAccess(request.method, request.url)) {
    reply.code(403).send({ message: '权限不足，禁止访问此资源。' });
  }
}

export function maskManagerPayload(role, payload) {
  if (role !== 'MANAGER' || typeof payload !== 'string') return payload;
  if (!payload.startsWith('{') && !payload.startsWith('[')) return payload;
  try { return JSON.stringify(maskPhoneFields(JSON.parse(payload))); }
  catch { return payload; }
}
