import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { control, isNotRunning } from './control.js';
import { packageRoot, type CovroPaths } from './paths.js';

const exec = promisify(execFile);
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const unit = (value: string) =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

export async function service(location: CovroPaths, install: boolean) {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error(
      '登录自启目前支持 macOS launchd 和 Linux systemd --user；可使用 covro start 后台运行。',
    );
  const label = `dev.covro.${location.key}`;
  const entry = join(packageRoot, 'bin/covro.mjs');
  if (install) {
    try {
      await control(location, 'stop');
    } catch (error) {
      if (!isNotRunning(error)) throw error;
    }
    await mkdir(location.state, { recursive: true, mode: 0o700 });
  }
  if (process.platform === 'darwin') {
    const directory = join(homedir(), 'Library/LaunchAgents');
    const filename = join(directory, `${label}.plist`);
    const domain = `gui/${process.getuid!()}`;
    if (!install) {
      await exec('launchctl', ['bootout', domain, filename]);
      await rm(filename);
      return;
    }
    await mkdir(directory, { recursive: true });
    const args = [process.execPath, entry, 'run', '--config', location.config];
    await writeFile(
      filename,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin')}</string><key>COVRO_HOME</key><string>${xml(location.home)}</string></dict>
<key>StandardOutPath</key><string>${xml(location.log)}</string><key>StandardErrorPath</key><string>${xml(location.log)}</string>
</dict></plist>\n`,
      { mode: 0o600 },
    );
    await exec('launchctl', ['enable', `${domain}/${label}`]);
    await exec('launchctl', ['bootstrap', domain, filename]);
  } else {
    const directory = join(homedir(), '.config/systemd/user');
    const filename = join(directory, `${label}.service`);
    if (install) {
      await mkdir(directory, { recursive: true });
      if (/[\r\n]/.test([entry, location.config, location.home, process.env.PATH].join('')))
        throw new Error('服务路径和 PATH 不能包含换行');
      await writeFile(
        filename,
        `[Unit]\nDescription=Covro\n[Service]\nExecStart=${[process.execPath, entry, 'run', '--config', location.config].map(unit).join(' ')}\nEnvironment=${unit(`COVRO_HOME=${location.home}`)} ${unit(`PATH=${process.env.PATH ?? '/usr/bin:/bin'}`)}\nRestart=on-failure\nRestartSec=30\n[Install]\nWantedBy=default.target\n`,
        { mode: 0o600 },
      );
      await exec('systemctl', ['--user', 'daemon-reload']);
      await exec('systemctl', ['--user', 'enable', '--now', `${label}.service`]);
    } else {
      await exec('systemctl', ['--user', 'disable', '--now', `${label}.service`]);
      await rm(filename);
      await exec('systemctl', ['--user', 'daemon-reload']);
    }
  }
}
