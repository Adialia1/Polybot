# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Telegram bot commands (`/status`, `/positions`, `/stats`, `/help`)
- Start/stop shell scripts for macOS/Linux
- Comprehensive CI/CD with GitHub Actions
- Security scanning with CodeQL and Trivy
- Dependabot for automated dependency updates

## [1.0.0] - 2026-03-06

### Added
- Real-time trade monitoring and copying
- Smart position sizing based on account size
- Automatic order execution via Polymarket CLOB API
- Crash recovery with state persistence
- Stop loss and take profit automation
- Trailing stop loss
- Daily loss limit protection
- Max open positions limit
- Probability filtering (skip lottery tickets and sure things)
- Market blacklist (avoid sports/entertainment)
- Market whitelist (focus on specific topics)
- Multi-trader support with per-trader allocation
- Conflict resolution strategies
- Buy-only mode
- Time-based exits
- Position reconciliation (handle offline exits)
- Telegram notifications
- Health check HTTP endpoint
- Web dashboard with real-time updates
- Config file support with hot-reload
- Retry logic with exponential backoff

### Security
- API credentials never committed to git
- .env file in .gitignore
- State file excluded from repository
- Security policy and vulnerability reporting process

---

## Version History

### How to Release

1. Update version in `package.json`
2. Update CHANGELOG.md with new version
3. Commit changes: `git commit -am "Release v1.x.x"`
4. Create tag: `git tag v1.x.x`
5. Push: `git push && git push --tags`
6. GitHub Actions will automatically create the release

### Semantic Versioning

- **MAJOR** (1.x.x): Breaking changes
- **MINOR** (x.1.x): New features, backwards compatible
- **PATCH** (x.x.1): Bug fixes, backwards compatible

---

[Unreleased]: https://github.com/Adialia1/polybot/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Adialia1/polybot/releases/tag/v1.0.0
