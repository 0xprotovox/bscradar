# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

We take the security of BscRadar seriously. If you believe you have found a security vulnerability, please report it to us as described below.

### How to Report

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email or private message to the maintainers.

### What to Include

Please include the following information:

- Type of vulnerability (e.g., RPC injection, rate limit bypass, etc.)
- Full paths of source file(s) related to the vulnerability
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the vulnerability

### Response Timeline

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Resolution**: Depends on complexity, typically within 30 days

### Safe Harbor

We consider security research conducted in good faith to be authorized and will not pursue legal action against researchers who:

- Make a good faith effort to avoid privacy violations
- Avoid destruction of data or service degradation
- Report vulnerabilities promptly
- Give us reasonable time to address the issue before public disclosure

## Security Best Practices

When deploying BscRadar:

1. **Never commit `.env` files** - Contains RPC keys and sensitive configuration
2. **Use private RPC endpoints** - Public RPCs have rate limits and may expose your queries
3. **Enable rate limiting** - Protect against abuse
4. **Run behind a reverse proxy** - Use nginx/cloudflare for additional protection
5. **Keep dependencies updated** - Run `npm audit` regularly

## Known Limitations

- This is an **analysis tool only** - it does not execute transactions
- Pool data is read-only from public blockchain state
- Price data should not be used for trading without additional verification

Thank you for helping keep BscRadar and its users safe!
