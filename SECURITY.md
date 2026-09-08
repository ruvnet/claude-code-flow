# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 3.5.x   | Yes                |
| 3.0-3.4 | No                 |
| 2.x     | No                 |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report vulnerabilities by emailing **security@cognitum.one**. Include the following in your report:

- A clear description of the vulnerability
- Steps to reproduce the issue
- Affected versions and components
- Impact assessment (severity, potential for exploitation)
- Any suggested fixes or mitigations, if available

## Response Timeline

- **48 hours** -- Initial acknowledgment of your report
- **7 days** -- Preliminary assessment and severity classification
- **30 days** -- Target for a fix or mitigation to be released

We will keep you informed of progress throughout the process.

## Safe Harbor

We consider security research conducted in good faith to be authorized activity. We will not pursue legal action against researchers who:

- Make a good faith effort to avoid privacy violations, data destruction, and service disruption
- Report vulnerabilities promptly and provide sufficient detail for reproduction
- Do not publicly disclose the vulnerability before a fix is available
- Do not exploit the vulnerability beyond what is necessary to demonstrate the issue

## Credit

We appreciate the work of security researchers. With your permission, we will publicly credit you in the release notes when a reported vulnerability is fixed.

## Security Practices

This project employs the following security measures at system boundaries:

- **Input validation** using Zod schemas for all public API inputs
- **Parameterized SQL queries** to prevent injection attacks
- **Path traversal prevention** via the `PathValidator` module
- **Command injection protection** via the `SafeExecutor` module

For questions about this policy, contact security@cognitum.one.
