import { AuthController } from './auth.controller';

describe('AuthController session cookies', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('sets and clears the production session cookie with matching security attributes', async () => {
    process.env.NODE_ENV = 'production';
    const expiresAt = new Date('2026-08-01T00:00:00.000Z');
    const auth = {
      login: jest.fn().mockResolvedValue({
        token: 'session-token',
        csrfToken: 'csrf-token',
        user: { id: 'user-1' },
        expiresAt,
      }),
      logout: jest.fn().mockResolvedValue(undefined),
    };
    const response = {
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };
    const controller = new AuthController(auth as never);

    await controller.login(
      { studentNumber: '1234', password: 'password' },
      response as never,
    );
    await controller.logout(
      { id: 'user-1' } as never,
      { id: 'session-1' } as never,
      response as never,
    );

    expect(response.cookie).toHaveBeenCalledWith(
      'bmc3_session',
      'session-token',
      {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        expires: expiresAt,
      },
    );
    expect(response.clearCookie).toHaveBeenCalledWith('bmc3_session', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
  });
});
