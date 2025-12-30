# Contributing to BscRadar

First off, thank you for considering contributing to BscRadar! It's people like you that make this tool better for everyone.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Style Guidelines](#style-guidelines)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Set up the development environment (see below)
4. Create a branch for your changes
5. Make your changes
6. Submit a pull request

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When creating a bug report, include:

- **Clear title** describing the issue
- **Steps to reproduce** the behavior
- **Expected behavior** vs actual behavior
- **Environment details** (Node.js version, OS, etc.)
- **Relevant logs** or error messages
- **Token address** if the issue is token-specific

### Suggesting Enhancements

Enhancement suggestions are welcome! Please include:

- **Clear title** describing the enhancement
- **Detailed description** of the proposed functionality
- **Use case** - why this would be useful
- **Possible implementation** approach (optional)

### Code Contributions

Great areas to contribute:

- **New DEX protocols** - Add support for other BSC DEXes
- **Performance improvements** - Optimize RPC calls, caching
- **Documentation** - Improve docs, add examples
- **Tests** - Increase test coverage
- **Bug fixes** - Fix reported issues

## Development Setup

### Prerequisites

- Node.js 18+
- npm or yarn
- BSC RPC endpoint (Alchemy, QuickNode, or public)

### Installation

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/bscradar.git
cd bscradar

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your RPC URLs
# At minimum, set BSC_RPC

# Start development server
npm run dev
```

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- --testPathPattern="PoolAnalyzer"
```

### Linting

```bash
# Check for issues
npm run lint

# Auto-fix issues
npm run lint:fix

# Format code
npm run format
```

## Style Guidelines

### JavaScript Style

We use ESLint and Prettier for code formatting. Key rules:

- **2 spaces** for indentation
- **Single quotes** for strings
- **Semicolons** required
- **Trailing commas** in multiline
- **No unused variables**

```javascript
// Good
const fetchPoolData = async (address) => {
  const result = await provider.getPool(address);
  return result;
};

// Bad
const fetchPoolData = async(address) =>{
    const result = await provider.getPool(address)
    return result
}
```

### Naming Conventions

- **Files**: `camelCase.js` for utilities, `PascalCase.js` for services/classes
- **Variables**: `camelCase`
- **Constants**: `UPPER_SNAKE_CASE`
- **Classes**: `PascalCase`
- **Functions**: `camelCase`, verbs for actions (`getPool`, `calculatePrice`)

### Documentation

- Add JSDoc comments for public functions
- Update README if adding new features
- Include inline comments for complex logic

```javascript
/**
 * Calculates the USD price for a token based on pool data
 * @param {string} tokenAddress - The token contract address
 * @param {Object} poolData - Pool information including reserves
 * @returns {number} The calculated USD price
 */
const calculateUsdPrice = (tokenAddress, poolData) => {
  // Implementation
};
```

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style (formatting, semicolons, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvement
- `test`: Adding/updating tests
- `chore`: Maintenance tasks

### Examples

```
feat(v3): add support for 0.01% fee tier pools

fix(price): correct decimal handling for non-18 decimal tokens

docs(readme): add Docker deployment instructions

refactor(cache): simplify cache key generation
```

## Pull Request Process

### Before Submitting

1. **Update documentation** if needed
2. **Add tests** for new functionality
3. **Run the test suite** - all tests must pass
4. **Run linting** - no errors allowed
5. **Update CHANGELOG.md** if applicable

### PR Title

Use the same format as commit messages:
```
feat(scope): description
```

### PR Description

Include:
- **What** - What does this PR do?
- **Why** - Why is this change needed?
- **How** - How does it work? (for complex changes)
- **Testing** - How was this tested?
- **Screenshots** - If applicable (UI changes, API responses)

### Review Process

1. At least one maintainer approval required
2. All CI checks must pass
3. No unresolved conversations
4. Up-to-date with main branch

### After Merge

- Delete your branch
- Update your fork's main branch
- Celebrate! 🎉

## Questions?

Feel free to open an issue with the `question` label or reach out to maintainers.

Thank you for contributing! 🙏
