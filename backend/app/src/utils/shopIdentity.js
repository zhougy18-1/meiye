import { createHmac } from 'node:crypto';

export const managerUsername = () => process.env.MANAGER_USERNAME || 'manager@m77.demo';

export function isConfiguredShopAccount(user) {
  if (!user) return false;
  return (user.role === 'ADMIN' && user.username === process.env.ADMIN_USERNAME)
    || (user.role === 'MANAGER' && user.username === managerUsername());
}

// A password change invalidates existing access tokens without storing tokens
// or adding a schema field. The HMAC does not expose the password hash in JWT.
export function credentialVersion(user) {
  return createHmac('sha256', process.env.JWT_SECRET).update(user.password).digest('hex');
}
