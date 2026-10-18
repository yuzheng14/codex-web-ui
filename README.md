<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/covro-logo-dark.svg" />
    <img src="docs/assets/covro-logo.svg" alt="Covro" width="266" height="64" />
  </picture>
</p>

<h1 align="center">Your Codex. Any browser.</h1>

<p align="center">
  A workspace for the Codex running on your computer.<br />
  Start a task at your desk. Follow it from your phone. Keep the context.
</p>

<p align="center"><strong>Self-hosted · Desktop & mobile · Your existing Codex login · MIT</strong></p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#what-you-can-do">Features</a> ·
  <a href="#access-from-another-device">Remote access</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

![Covro desktop workspace with a conversation and a Markdown document side by side](docs/assets/workspace-desktop.png)

<p align="center"><sub>Captured from the running app with sample projects and fixture-generated conversations.</sub></p>

## What you can do

- **Keep projects in view.** Switch between projects and conversations, run independent tasks in parallel, and see which ones need your attention.
- **Continue your Codex work.** Browse saved conversations, resume existing work, fork a new direction, rename threads, and archive finished ones.
- **Stay in control.** Follow tool activity and file changes, handle permission requests, and answer Codex's questions from the browser.
- **Read without losing your place.** View Markdown, tables, code, images, and local Markdown documents. Use a side panel on desktop or a full-screen reader on mobile.
- **Keep your working context.** Each conversation keeps its own draft, pasted images, and model settings while you move around the workspace. Copy or export results when you're done.
- **Stay up to date.** Choose stable, beta, or dev; check versions and upgrade from the Web UI. Managed upgrades wait for tasks to finish, restart the service, and preserve the data directory.

<details>
  <summary><strong>A workspace that fits your phone</strong></summary>
  <p>Check a result, answer a question, or send the next instruction without returning to your desk.</p>
  <img src="docs/assets/workspace-mobile.png" alt="Covro conversation on a phone-sized screen" width="320" />
</details>

## Get started

You need **Node.js 24.19 or later in the 24.x line** and an installed, signed-in **Codex CLI**. The current verified Codex version is **0.163.0**; other versions may require confirmation. The interface currently uses Simplified Chinese.

### Run from source

With **pnpm 12.11.2** installed:

```sh
git clone https://github.com/yuzheng14/codex-web-ui.git covro
cd covro
pnpm install --frozen-lockfile
cp config.example.json config.local.json
pnpm build
pnpm start -- --config ./config.local.json
```

Open **<http://127.0.0.1:8787>**, click **添加项目** (Add project), and enter a project directory on the computer running Covro. Open a conversation or send your first task.

For local development, run `pnpm dev` instead and open <http://127.0.0.1:5173>.

### npm installation

The first public npm release is being prepared. Use the source instructions above until `covro` is published. After publication:

```sh
npm install -g covro
covro
```

`covro` starts in the background. Close the terminal and keep working in your browser.

| Command                   | Purpose                                      |
| ------------------------- | -------------------------------------------- |
| `covro status`            | Show the running instance and its address    |
| `covro logs`              | Read recent service logs                     |
| `covro stop`              | Stop the service                             |
| `covro run`               | Run in the foreground                        |
| `covro service install`   | Opt in to login auto-start on macOS or Linux |
| `covro service uninstall` | Remove login auto-start                      |

The npm CLI uses `~/.covro/config.json` and a fixed data directory beside it. Reuse an existing configuration with `covro --config /absolute/path/config.json`.

## Access from another device

Covro runs on your computer; the browser is your control surface. Tasks continue when you close the page, and reopening it reconnects to the service. The host computer must stay awake and online.

| Setup                          | How to connect                                                       |
| ------------------------------ | -------------------------------------------------------------------- |
| On the host computer           | Open the local address                                               |
| Your devices through Tailscale | Configure Tailscale Serve and add its HTTPS origin to `publicOrigin` |
| Through Cloudflare             | Use a tunnel with Cloudflare Access and Covro's JWT verification     |

Follow the [deployment guide](docs/deployment.md) for complete configuration. Remote access is explicit: a fresh installation listens on loopback only. When adding projects remotely, choose directories on the host computer.

## Updates and release channels

Open **Covro** in the sidebar to check versions, choose a channel, enable idle-time automatic upgrades, or upgrade and restart. The CLI provides the same update engine:

```sh
covro update status
covro update
covro update --channel dev
```

| Channel | npm tag  | Choose it for                               |
| ------- | -------- | ------------------------------------------- |
| Stable  | `latest` | Regular use                                 |
| Beta    | `beta`   | Preview releases selected by the maintainer |
| Dev     | `dev`    | New main-branch changes after CI passes     |

Automatic installation is off by default. Managed upgrades support **macOS and Linux npm global installations**; source, linked, container, and Windows installations use their original update method. A failed candidate is rolled back before business writes resume; downgrades must pass database compatibility checks. Old backups are retained without automatic rotation.

See [distribution and recovery](docs/distribution.md) and [release operations](docs/releases.md) for details.

## Your computer, your workspace

Covro is a single-user app built around your existing Codex environment. Code runs on the host computer through `codex app-server`. Projects and Codex history stay there; Covro stores its own project registry and operation records in SQLite. It does not provide a separate hosted account or copy your Codex login into the browser. Codex itself still uses its configured model provider.

Use the browser to follow work, review requests, and continue conversations. An interactive terminal, file editor, Git GUI, and multi-user team management are outside the current scope.

## Development and contribution

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

Browser tests require the Chromium version used by the existing Playwright dependency. Tests and CI use explicit fixtures; they do not send real model requests.

Found a problem or have an idea? [Open an issue](https://github.com/yuzheng14/codex-web-ui/issues). Include your OS, Node.js and Codex versions, installation method, and steps to reproduce. Small, focused PRs are welcome. Update both `README.md` and `README.zh-CN.md` when changing user-facing facts or setup instructions.

## Documentation

| Guide                                        | Contents                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| [Detailed usage · 中文](docs/usage.zh-CN.md) | Projects, conversations, approvals, notifications, images, and recovery |
| [Deployment](docs/deployment.md)             | Local access, Tailscale, and Cloudflare Access                          |
| [Distribution](docs/distribution.md)         | CLI, services, data locations, upgrades, and repair                     |
| [Compatibility](docs/compatibility.md)       | Verified Codex versions and behavior boundaries                         |
| [Slash commands](docs/slash-commands.md)     | Supported commands and usage                                            |
| [Architecture](docs/architecture.md)         | How the gateway, Codex adapter, and browser fit together                |
| [Verification](docs/verification.md)         | Test coverage and recorded live checks                                  |
| [Brand assets](docs/brand.md)                | Editable SVG logo and wordmarks                                         |

## License

[MIT](LICENSE). Covro is an independent project and is not affiliated with OpenAI.
