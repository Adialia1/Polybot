# Contributing to Polybot

Thank you for your interest in contributing to Polybot! 🎉

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/Adialia1/polybot/issues)
2. If not, create a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - Your environment (OS, Node version, etc.)
   - Relevant logs (remove any sensitive data!)

### Suggesting Features

1. Open an issue with the tag "feature request"
2. Describe the feature and why it would be useful
3. Provide examples if possible

### Pull Requests

1. Fork the repository
2. Create a new branch: `git checkout -b feature/your-feature-name`
3. Make your changes
4. Test thoroughly (especially with `DRY_RUN=true`)
5. Commit with clear messages: `git commit -m "Add feature: description"`
6. Push to your fork: `git push origin feature/your-feature-name`
7. Open a Pull Request

### Code Style

- Use TypeScript
- Follow existing code formatting
- Add comments for complex logic
- Update README if adding new features

### Testing

- Always test with `DRY_RUN=true` first
- Test with small amounts before recommending to others
- Include test scenarios in PR description

### Security

⚠️ **NEVER commit:**
- Private keys
- API credentials
- Wallet addresses (except example addresses)
- Telegram tokens
- Any `.env` file content

If you find a security vulnerability, please email [security contact] instead of opening a public issue.

## Development Setup

```bash
# Clone your fork
git clone https://github.com/Adialia1/polybot.git
cd polybot

# Install dependencies
npm install

# Copy and configure .env
cp .env.example .env
nano .env

# Run in development mode
npm run bot
```

## Questions?

Feel free to open an issue or start a discussion!

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
