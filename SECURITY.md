# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in Polybot, please report it privately:

1. **Email:** [Your email or security contact]
2. **GitHub Security Advisory:** Use the [private vulnerability reporting](https://github.com/Adialia1/polybot/security/advisories/new) feature

### What to Include

Please include the following information:

- Type of vulnerability
- Full paths of source files related to the vulnerability
- Location of the affected source code (tag/branch/commit or direct URL)
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the vulnerability
- Suggested fix (if available)

### Response Timeline

- **Initial Response:** Within 48 hours
- **Status Update:** Within 7 days
- **Fix Timeline:** Depends on severity
  - Critical: 1-3 days
  - High: 1-2 weeks
  - Medium: 2-4 weeks
  - Low: Next release cycle

## Security Best Practices

When using Polybot:

### 🔐 Credential Management

- **NEVER** commit your `.env` file
- **NEVER** share your private keys or API credentials
- **NEVER** post logs containing API keys or wallet addresses
- Store credentials in environment variables or secure secret management tools
- Rotate API keys regularly

### 💰 Financial Safety

- **ALWAYS** start with `DRY_RUN=true`
- **ALWAYS** test with small amounts first
- Set conservative `DAILY_LOSS_LIMIT`
- Use `STOP_LOSS_PERCENT` to limit downside
- Don't risk more than you can afford to lose

### 🛡️ Operational Security

- Run the bot on a secure server (not public WiFi)
- Keep your Node.js and dependencies up to date
- Monitor `npm audit` warnings
- Use firewall rules to restrict access
- Enable 2FA on your GitHub account
- Review all code changes before pulling updates

### 📊 Monitoring

- Enable Telegram notifications for alerts
- Monitor the health check endpoint
- Review positions daily
- Check for unusual trading patterns
- Keep logs for audit purposes

## Known Security Considerations

### Private Key Storage

The bot requires your wallet private key in the `.env` file. This is necessary for signing transactions. To minimize risk:

- Never commit `.env` to version control (already in `.gitignore`)
- Use file system permissions to restrict access (`chmod 600 .env`)
- Consider using a dedicated trading wallet with limited funds
- Don't store large amounts in the trading wallet

### API Credentials

Polymarket API credentials are derived from your wallet. Keep them secure:

- Don't share API credentials
- Don't post them in issues or discussions
- Rotate them if you suspect they're compromised

### Network Security

The bot makes HTTP requests to:
- Polymarket CLOB API
- Telegram API (if enabled)

Ensure:
- You trust your network connection
- You're not on compromised WiFi
- Consider using a VPN for additional security

## Dependency Security

We use:
- **Dependabot** for automated dependency updates
- **npm audit** in CI/CD pipeline
- **CodeQL** for security scanning
- **Trivy** for vulnerability scanning

Stay updated by:
- Watching for Dependabot PRs
- Reviewing security advisories
- Updating to latest stable versions

## Disclosure Policy

When we receive a security bug report, we will:

1. Confirm the issue and determine severity
2. Prepare a fix and test thoroughly
3. Release a security patch
4. Credit the reporter (if desired)
5. Publish a security advisory

## Bug Bounty

Currently, we do not offer a bug bounty program. However, we greatly appreciate responsible disclosure and will acknowledge contributors in our security advisories.

## Contact

For security concerns, contact:
- **Email:** [your-email@example.com]
- **GitHub Security:** [Private vulnerability reporting](https://github.com/Adialia1/polybot/security/advisories/new)

---

**Remember:** This bot handles real money. Security should be your top priority. When in doubt, ask questions before proceeding.
