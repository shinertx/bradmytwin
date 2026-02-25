import { env } from '../config/env.js';

interface GoogleTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
}

interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export class GoogleLoginService {
  isConfigured(): boolean {
    return Boolean(
      env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      this.getRedirectUri()
    );
  }

  getRedirectUri(): string {
    return env.GOOGLE_LOGIN_REDIRECT_URI ?? `${env.APP_BASE_URL}/auth/login/google/callback`;
  }

  buildAuthUrl(state: string): string {
    if (!env.GOOGLE_CLIENT_ID) {
      throw new Error('google_login_not_configured');
    }

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', this.getRedirectUri());
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('prompt', 'select_account');
    authUrl.searchParams.set('state', state);
    return authUrl.toString();
  }

  async exchangeCodeForProfile(code: string): Promise<{
    providerUserId: string;
    email?: string;
    emailVerified: boolean;
    name?: string;
    picture?: string;
  }> {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new Error('google_login_not_configured');
    }

    const tokenParams = new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: this.getRedirectUri(),
      grant_type: 'authorization_code'
    });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`google_token_exchange_failed:${tokenRes.status}:${body}`);
    }

    const token = (await tokenRes.json()) as GoogleTokenResponse;
    if (!token.access_token) {
      throw new Error('google_token_missing_access_token');
    }

    const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });

    if (!profileRes.ok) {
      const body = await profileRes.text();
      throw new Error(`google_userinfo_failed:${profileRes.status}:${body}`);
    }

    const profile = (await profileRes.json()) as GoogleUserInfo;
    if (!profile.sub) {
      throw new Error('google_userinfo_missing_sub');
    }

    return {
      providerUserId: profile.sub,
      email: profile.email,
      emailVerified: Boolean(profile.email_verified),
      name: profile.name,
      picture: profile.picture
    };
  }
}
