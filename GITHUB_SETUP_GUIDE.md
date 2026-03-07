# GitHub Setup Guide

This guide will help you set up your repository on GitHub with all the CI/CD features.

## 1. Create GitHub Repository

1. Go to https://github.com/new
2. **Repository name:** `polybot`
3. **Description:** Automated Polymarket trade copier with risk management and Telegram notifications
4. **Visibility:** Public
5. **Don't** initialize with README (we already have one)
6. Click "Create repository"

## 2. Update Repository References

Replace `Adialia1` with your actual GitHub username in these files:

### package.json (3 locations)
```json
"repository": {
  "url": "https://github.com/YOUR_USERNAME/polybot.git"
},
"bugs": {
  "url": "https://github.com/YOUR_USERNAME/polybot/issues"
},
"homepage": "https://github.com/YOUR_USERNAME/polybot#readme"
```

### README.md (Badge URLs)
Update the badge URLs at the top:
```markdown
[![CI](https://github.com/YOUR_USERNAME/polybot/actions/workflows/ci.yml/badge.svg)]...
```

### Other files
- CONTRIBUTING.md
- CHANGELOG.md
- SECURITY.md
- .github/dependabot.yml

**Quick replace command:**
```bash
# macOS
find . -type f \( -name "*.md" -o -name "*.json" -o -name "*.yml" \) -not -path "*/node_modules/*" -exec sed -i '' 's/Adialia1/YOUR_ACTUAL_USERNAME/g' {} +

# Linux
find . -type f \( -name "*.md" -o -name "*.json" -o -name "*.yml" \) -not -path "*/node_modules/*" -exec sed -i 's/Adialia1/YOUR_ACTUAL_USERNAME/g' {} +
```

## 3. Push to GitHub

```bash
cd /Users/adialia/polybot

# Initialize git (if not already done)
git init

# Add all files
git add .

# Create initial commit
git commit -m "Initial commit: Polymarket trade copier v1.0.0"

# Rename branch to main
git branch -M main

# Add remote (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/polybot.git

# Push
git push -u origin main
```

## 4. Configure Repository Settings

### Enable Features

Go to **Settings** → **General**:

- ✅ Enable Issues
- ✅ Enable Discussions (optional but recommended)
- ✅ Enable Wikis (optional)

### Set Topics

Go to **About** (top right of repository page):

Add topics:
- `polymarket`
- `trading-bot`
- `copy-trading`
- `typescript`
- `prediction-markets`
- `automated-trading`
- `risk-management`
- `telegram-bot`

### Repository Description

Set description:
```
Automated Polymarket trade copier with risk management, multi-trader support, and Telegram notifications
```

## 5. Enable GitHub Actions

GitHub Actions should be automatically enabled. Verify:

1. Go to **Actions** tab
2. You should see workflows running (CI, CodeQL)
3. If not, check **Settings** → **Actions** → **General**
   - Select "Allow all actions and reusable workflows"
   - Enable "Read and write permissions" for workflows

## 6. Enable Security Features

### Dependabot

Go to **Settings** → **Security & analysis**:

- ✅ Enable Dependency graph
- ✅ Enable Dependabot alerts
- ✅ Enable Dependabot security updates

Dependabot is already configured via `.github/dependabot.yml`

### CodeQL

CodeQL will run automatically on:
- Every push to main
- Every pull request
- Weekly schedule (Mondays)

View results in **Security** → **Code scanning alerts**

### Secret Scanning

Enable in **Settings** → **Security & analysis**:
- ✅ Enable Secret scanning

This will alert if you accidentally commit API keys or private keys.

## 7. Branch Protection (Recommended)

Go to **Settings** → **Branches** → **Add rule**:

**Branch name pattern:** `main`

Enable:
- ✅ Require a pull request before merging
- ✅ Require status checks to pass before merging
  - Select: `build-and-test`, `lint`, `security-scan`
- ✅ Require conversation resolution before merging
- ✅ Do not allow bypassing the above settings

This ensures all code goes through CI/CD before merging.

## 8. Create First Release

### Option 1: Using the Release Script

```bash
# For a patch release (1.0.0 → 1.0.1)
npm run release:patch

# For a minor release (1.0.0 → 1.1.0)
npm run release:minor

# For a major release (1.0.0 → 2.0.0)
npm run release:major
```

The script will:
1. Bump version in package.json
2. Prompt you to update CHANGELOG.md
3. Create a git commit
4. Create a git tag
5. Show you the push command

Then push:
```bash
git push && git push --tags
```

### Option 2: Manual Release

```bash
# Update version in package.json
npm version patch  # or minor, or major

# Update CHANGELOG.md with release notes

# Commit
git commit -am "chore: release v1.0.1"

# Tag
git tag v1.0.1

# Push
git push && git push --tags
```

GitHub Actions will automatically create a release with changelog!

## 9. Verify CI/CD

After pushing, check:

1. **Actions tab** - All workflows should pass ✅
2. **Security tab** - CodeQL scans should complete
3. **Releases** (if you tagged) - Automated release created
4. **Pull requests** - Dependabot should create PRs for updates

## 10. Add Status Badges to README

Badges are already in README.md, but verify they work:

- CI badge: Shows build status
- CodeQL badge: Shows security scan status
- License badge: Shows MIT license
- Node.js badge: Shows required Node version

## 11. Optional: Add Contributors

If you want to acknowledge contributors:

Create `.github/CODEOWNERS`:
```
# Default owners for everything
* @Adialia1

# Specific paths
/src/ @Adialia1
/.github/ @Adialia1
```

## 12. Post-Release Checklist

- [ ] Repository created and pushed ✅
- [ ] All badges working ✅
- [ ] CI/CD running ✅
- [ ] Security features enabled ✅
- [ ] Branch protection enabled ✅
- [ ] First release created ✅
- [ ] Topics added ✅
- [ ] Description set ✅

## Troubleshooting

### CI Failing

If CI fails on first run:
- Check **Actions** tab for error logs
- Common issues:
  - TypeScript errors: Run `npm run lint` locally
  - Build errors: Run `npm run build` locally
  - Missing dependencies: Run `npm install`

### Badge Not Showing

If badges show "unknown":
- Wait a few minutes for first CI run
- Check workflow files are in `.github/workflows/`
- Verify repository name in badge URLs

### Dependabot Not Creating PRs

- Check **Insights** → **Dependency graph**
- Verify `.github/dependabot.yml` exists
- Check **Settings** → **Security & analysis** → Dependabot is enabled

## Next Steps

1. **Monitor Issues** - Respond to user questions
2. **Review PRs** - Check Dependabot updates
3. **Security Alerts** - Act on CodeQL findings
4. **Community** - Engage with users
5. **Releases** - Follow semantic versioning

---

**Congratulations!** 🎉 Your repository is now professional and ready for open source!
