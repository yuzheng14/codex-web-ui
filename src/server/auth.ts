import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AppConfig } from './config.js';
import { AppError } from '../shared/errors.js';
export interface Identity {
  expiresAt?: number;
}
export function createAuthenticator(
  config: AppConfig,
  testKey?: JWTVerifyGetKey | CryptoKey | Uint8Array,
) {
  const access = config.auth.mode === 'cloudflare-access' ? config.auth : undefined;
  const key = access
    ? (testKey ?? createRemoteJWKSet(new URL('/cdn-cgi/access/certs', access.issuer)))
    : undefined;
  const origins = new Set([...config.publicOrigin, ...config.developmentOrigins]);
  const hosts = new Set([...origins].map((value) => new URL(value).host));
  return async function authenticate(request: Request, websocket = false): Promise<Identity> {
    // Host is checked in both modes; forwarded headers never grant identity.
    const host = request.headers.get('host') ?? new URL(request.url).host;
    if (!hosts.has(host))
      throw new AppError('INVALID_HOST', 'Request Host does not match a configured origin', 403);
    const requestOrigin = request.headers.get('origin');
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if ((websocket || mutating) && (!requestOrigin || !origins.has(requestOrigin)))
      throw new AppError(
        'INVALID_ORIGIN',
        'Request Origin does not match a configured origin',
        403,
      );
    if (requestOrigin && !origins.has(requestOrigin))
      throw new AppError(
        'INVALID_ORIGIN',
        'Request Origin does not match a configured origin',
        403,
      );
    if (
      mutating &&
      request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/json'
    )
      throw new AppError('INVALID_CONTENT_TYPE', 'Expected application/json', 415);
    if (!access || !key) return {};
    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) throw new AppError('UNAUTHENTICATED', 'Cloudflare Access login is required', 401);
    try {
      const { payload } = await jwtVerify(token, key as JWTVerifyGetKey, {
        issuer: access.issuer,
        audience: access.audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iss', 'aud', 'sub'],
      });
      return { expiresAt: payload.exp! * 1000 };
    } catch {
      throw new AppError('UNAUTHENTICATED', 'Cloudflare Access login is invalid or expired', 401);
    }
  };
}
export type Authenticator = ReturnType<typeof createAuthenticator>;
