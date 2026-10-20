import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';

const io = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: Object.assign(vi.fn(), { [promisify.custom]: io.exec }),
}));
import { doctor } from '../../src/cli/doctor.js';

beforeEach(() => {
  vi.stubEnv('GH_TOKEN', '');
  vi.stubEnv('GITHUB_TOKEN', '');
  io.exec.mockReset();
  io.exec.mockImplementation(async (command: string, args: string[]) => {
    if (command === '/bin/launchctl') return { stdout: 'Aqua\n', stderr: '' };
    if (args[0] === 'auth') return { stdout: 'secret-token-188', stderr: '' };
    return { stdout: 'HTTP/2.0 200 OK\n', stderr: '' };
  });
});
afterEach(() => vi.unstubAllEnvs());

it('reports daemon context and never includes tokens or raw command output', async () => {
  vi.stubEnv('GH_TOKEN', 'secret-token-188');
  const result = await doctor();
  expect(result).toMatchObject({
    pid: process.pid,
    scope: 'daemon-child-process',
    sandbox: 'not-tested',
    result: 'authenticated',
    credentialReadable: true,
    credentialSource: 'environment',
    httpStatus: 200,
  });
  expect(JSON.stringify(result)).not.toContain('secret-token-188');
  expect(io.exec).toHaveBeenCalledWith(
    'gh',
    ['api', 'user', '--hostname', 'github.com', '--include', '--silent'],
    expect.objectContaining({ timeout: 4000 }),
  );
});

it('does not validate an unavailable credential or label it as invalid', async () => {
  io.exec.mockImplementation(async (command: string) => {
    if (command === '/bin/launchctl') return { stdout: 'Background\n', stderr: '' };
    throw Object.assign(new Error('secret-token-188'), {
      code: 1,
      stdout: '',
      stderr: 'secret-token-188',
    });
  });
  const result = await doctor();
  expect(result).toMatchObject({ result: 'credential-unavailable', credentialReadable: false });
  expect(io.exec.mock.calls.filter((call) => call[1][0] === 'api')).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain('secret-token-188');
  if (process.platform === 'darwin') expect(result.notes.join(' ')).toContain('Aqua');
});

it.each([
  [401, 'authentication-rejected'],
  [403, 'request-forbidden'],
  [502, 'request-failed'],
])('distinguishes HTTP %s after a successful credential lookup', async (status, result) => {
  io.exec.mockImplementation(async (command: string, args: string[]) => {
    if (command === '/bin/launchctl') return { stdout: 'Aqua\n', stderr: '' };
    if (args[0] === 'auth') return { stdout: 'secret-token-188', stderr: '' };
    throw Object.assign(new Error('secret-token-188'), {
      code: 1,
      stdout: `HTTP/2.0 ${status}\nsecret-token-188`,
      stderr: '',
    });
  });
  const report = await doctor();
  expect(report).toMatchObject({ result, credentialReadable: true, httpStatus: status });
  expect(JSON.stringify(report)).not.toContain('secret-token-188');
});

it.each(['ENOENT', 'timeout'])('reports %s without exposing command errors', async (failure) => {
  io.exec.mockRejectedValue(
    Object.assign(new Error('secret-token-188'), {
      code: failure === 'ENOENT' ? 'ENOENT' : undefined,
      killed: failure === 'timeout',
    }),
  );
  const report = await doctor();
  expect(report.result).toBe(failure === 'ENOENT' ? 'gh-unavailable' : 'credential-unavailable');
  expect(JSON.stringify(report)).not.toContain('secret-token-188');
});

it('distinguishes an API timeout from a credential lookup failure', async () => {
  io.exec.mockImplementation(async (command: string, args: string[]) => {
    if (command === '/bin/launchctl') return { stdout: 'Aqua\n', stderr: '' };
    if (args[0] === 'auth') return { stdout: 'secret-token-188', stderr: '' };
    throw Object.assign(new Error('secret-token-188'), { killed: true });
  });
  const report = await doctor();
  expect(report).toMatchObject({
    credentialReadable: true,
    result: 'request-failed',
    httpStatus: null,
  });
  expect(JSON.stringify(report)).not.toContain('secret-token-188');
});
