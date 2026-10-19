import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { AppError } from '../shared/errors.js';
import type { GatewayConfig, GatewayConfigSnapshot } from '../shared/gateway-config.js';
import { configSource, parseConfig, parseFileConfig, type AppConfig } from './config.js';

const saveSchema = z
  .object({ revision: z.string().regex(/^[a-f0-9]{64}$/), config: z.unknown() })
  .strict();
const importSchema = z.object({ config: z.unknown() }).strict();
const revision = (text: string) => createHash('sha256').update(text).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const MAX_CONFIG_BYTES = 256 * 1024;

/** The running configuration is immutable; this store only changes the next startup's file. */
export class ConfigStore {
  private readonly source;
  private readonly running: GatewayConfig;
  constructor(config: AppConfig) {
    this.source = configSource(config);
    const { demo: _demo, ...running } = config;
    this.running = structuredClone(running);
  }

  private async read() {
    if (!this.source)
      throw new AppError('CONFIG_UNAVAILABLE', '此实例未指定配置文件，无法管理服务配置。', 503);
    try {
      const stat = await lstat(this.source.path);
      if (stat.size > MAX_CONFIG_BYTES)
        throw new AppError('INVALID_CONFIG', '配置文件不能超过 256 KiB。');
      const text = await readFile(this.source.path, 'utf8');
      if (Buffer.byteLength(text) > MAX_CONFIG_BYTES)
        throw new AppError('INVALID_CONFIG', '配置文件不能超过 256 KiB。');
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new AppError('INVALID_CONFIG', '配置文件不是有效的 JSON，请先修复文件。');
      }
      return { saved: parseFileConfig(value), revision: revision(text), stat };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'CONFIG_READ_FAILED',
        '无法读取启动时指定的配置文件，请检查文件和权限。',
        503,
      );
    }
  }

  async snapshot(): Promise<GatewayConfigSnapshot> {
    const file = await this.read();
    let readOnlyReason: string | undefined;
    if (!file.stat.isFile())
      readOnlyReason = '软链接或特殊配置文件只支持查看和导出，请直接编辑源文件。';
    else {
      try {
        await access(this.source!.path, constants.W_OK);
        await access(dirname(this.source!.path), constants.W_OK);
      } catch {
        readOnlyReason = '配置文件或所在目录不可写，请调整服务进程的文件权限。';
      }
    }
    const { demo: _demo, ...effective } = parseConfig(
      file.saved,
      this.source!.path,
      this.source!.development,
    );
    return {
      path: this.source!.path,
      revision: file.revision,
      saved: file.saved,
      running: this.running,
      restartRequired: !same(effective, this.running),
      writable: !readOnlyReason,
      ...(readOnlyReason ? { readOnlyReason } : {}),
    };
  }

  async previewImport(input: unknown) {
    const imported = parseFileConfig(importSchema.parse(input).config);
    const { saved } = await this.read();
    const preserved = (['dataDir', 'projects'] as const).filter(
      (key) => !same(imported[key], saved[key]),
    );
    return { config: { ...imported, dataDir: saved.dataDir, projects: saved.projects }, preserved };
  }

  async export() {
    return (await this.read()).saved;
  }

  async save(input: unknown): Promise<GatewayConfigSnapshot> {
    const parsed = saveSchema.parse(input);
    const config = parseFileConfig(parsed.config);
    const initial = await this.snapshot();
    if (!initial.writable) throw new AppError('CONFIG_READ_ONLY', initial.readOnlyReason!, 409);
    let release: (() => Promise<void>) | undefined;
    const temporary = join(dirname(this.source!.path), `.codex-config-${randomUUID()}.tmp`);
    try {
      try {
        release = await lockfile.lock(this.source!.path, { realpath: false, retries: 0 });
      } catch {
        throw new AppError('CONFIG_BUSY', '配置正在被其他操作保存，请稍后重试。', 409);
      }
      const current = await this.snapshot();
      if (!current.writable) throw new AppError('CONFIG_READ_ONLY', current.readOnlyReason!, 409);
      if (current.revision !== parsed.revision)
        throw new AppError(
          'CONFIG_CONFLICT',
          '配置文件已被其他页面或程序修改。请重新读取后再保存。',
          409,
        );
      if (
        config.dataDir !== current.saved.dataDir ||
        !same(config.projects, current.saved.projects)
      )
        throw new AppError(
          'CONFIG_PROTECTED',
          '数据目录不可在此修改；项目请使用项目管理功能。',
          400,
        );
      const contents = `${JSON.stringify(config, null, 2)}\n`;
      if (Buffer.byteLength(contents) > MAX_CONFIG_BYTES)
        throw new AppError('INVALID_CONFIG', '配置文件不能超过 256 KiB。');
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(contents, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      // Catch external editors that changed the file while the temporary file was written.
      const latest = await this.snapshot();
      if (latest.revision !== current.revision || !latest.writable)
        throw new AppError('CONFIG_CONFLICT', '配置文件已发生变化，请重新读取后再保存。', 409);
      await rename(temporary, this.source!.path);
      return await this.snapshot();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'CONFIG_WRITE_FAILED',
        '保存配置失败，请检查文件权限和磁盘空间后重试。',
        500,
      );
    } finally {
      await rm(temporary, { force: true });
      await release?.();
    }
  }
}
