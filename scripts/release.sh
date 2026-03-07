#!/bin/bash

# Release script for Polybot
# Usage: ./scripts/release.sh [major|minor|patch]

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if version type is provided
if [ -z "$1" ]; then
  echo -e "${RED}Error: Version type required${NC}"
  echo "Usage: ./scripts/release.sh [major|minor|patch]"
  echo ""
  echo "Examples:"
  echo "  ./scripts/release.sh patch  # 1.0.0 -> 1.0.1"
  echo "  ./scripts/release.sh minor  # 1.0.0 -> 1.1.0"
  echo "  ./scripts/release.sh major  # 1.0.0 -> 2.0.0"
  exit 1
fi

VERSION_TYPE=$1

# Check if git is clean
if [ -n "$(git status --porcelain)" ]; then
  echo -e "${RED}Error: Git working directory is not clean${NC}"
  echo "Please commit or stash your changes first"
  exit 1
fi

# Check if on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo -e "${YELLOW}Warning: You are not on the main branch (current: $CURRENT_BRANCH)${NC}"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "${GREEN}Current version: $CURRENT_VERSION${NC}"

# Bump version
echo -e "${YELLOW}Bumping $VERSION_TYPE version...${NC}"
npm version $VERSION_TYPE --no-git-tag-version

# Get new version
NEW_VERSION=$(node -p "require('./package.json').version")
echo -e "${GREEN}New version: $NEW_VERSION${NC}"

# Update CHANGELOG.md
echo -e "${YELLOW}Update CHANGELOG.md with release notes${NC}"
echo "Press Enter when ready to continue..."
read

# Commit changes
echo -e "${YELLOW}Committing version bump...${NC}"
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v$NEW_VERSION"

# Create tag
echo -e "${YELLOW}Creating git tag v$NEW_VERSION...${NC}"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

# Show summary
echo ""
echo -e "${GREEN}✅ Release v$NEW_VERSION prepared!${NC}"
echo ""
echo "Next steps:"
echo "  1. Review the changes: git show HEAD"
echo "  2. Push to GitHub: git push && git push --tags"
echo "  3. GitHub Actions will create the release automatically"
echo ""
echo -e "${YELLOW}To undo: git reset --hard HEAD~1 && git tag -d v$NEW_VERSION${NC}"
