# Repository Guidelines

## Project Structure & Module Organization

XuYa Terminal combines a React 19/TypeScript frontend with a Tauri v2/Rust backend.

- `src/app/` and `src/settings/`: main and settings window entry points.
- `src/modules/`: feature modules, including terminal, AI, editor, and Git; `src/components/`, `src/lib/`, and `src/styles/`: shared UI, utilities, and styles.
- `src-tauri/src/modules/`: native services; `src-tauri/src/lib.rs`: Tauri command registration; `src-tauri/tests/`: integration tests.
- `public/` and `assets/`: static assets and branding; `src-tauri/icons/`: application icons.
- `scripts/`: build/version utilities; `docs/`: supporting documentation.

## Build, Test, and Development Commands

Use Node.js 22+, the pnpm version pinned in `package.json`, Rust stable, and Tauri v2 platform prerequisites. Run commands from the repository root.

- `pnpm install --frozen-lockfile`: install locked frontend dependencies.
- `pnpm dev`: serve the frontend at `http://localhost:1420`.
- `pnpm tauri dev`: launch the desktop development app.
- `pnpm build` / `pnpm tauri build`: build frontend assets / desktop installers.
- `pnpm check-types`, `pnpm lint`, `pnpm format:check`: check TypeScript, lint, and formatting.
- `pnpm format` / `cargo fmt`: format frontend / Rust code.
- `pnpm test` / `pnpm test:watch`: run Vitest once / continuously.
- `cargo check --all-targets --locked`, `cargo test --locked`: check and test Rust.
- `cargo clippy --all-targets --locked -- -D warnings`: check Rust lint warnings.

## Coding Style & Naming Conventions

Biome enforces two-space indentation, 80-column formatting, double quotes, semicolons, and trailing commas. Use explicit type imports and the `@/` alias for `src/`. Follow existing PascalCase component filenames, camelCase utilities and `use...` hooks, and snake_case Rust names. Keep feature code in its module.

## Testing Guidelines

Place Vitest tests beside source as `*.test.ts`. Rust uses inline `#[test]` modules and integration tests under `src-tauri/tests/`; CI runs cargo-nextest across Linux, Windows, and macOS. Add regression tests for behavior changes. CI collects Rust coverage without a configured minimum percentage. Smoke-test affected desktop flows and document platforms and shells tested.

## Commit & Pull Request Guidelines

Recent history uses emoji-prefixed bilingual categories. Follow `CONTRIBUTING.md` and the PR template's Conventional Commit guidance, e.g. `fix(terminal): preserve native shortcuts`. Complete `.github/PULL_REQUEST_TEMPLATE.md`: explain what changed and why, link issues, describe validation, and attach screenshots/GIFs for UI changes. Flag Tauri command signature changes and update frontend callers together.

## Security & Configuration

Keep API keys, tokens, and local provider databases out of commits. Treat `~/.claude/settings.json`, `~/.codex/auth.json`, and `~/.xuya/agent-providers.sqlite` as sensitive.
