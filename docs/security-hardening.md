## Security Hardening – safer install and configuration flow

This document introduces an initial security hardening notice focused on reducing supply-chain and persistence risks in installation and configuration flows.

### What was changed

- Added initial security notice document
- Highlighted ongoing security hardening review

### Why

The current installation flow may rely on patterns such as:
- mutable dependencies (e.g. `@latest`)
- remote script execution (e.g. `curl | bash`)
- potential environment-level configuration changes

While no malicious behavior was identified, these patterns can increase risk in stricter threat models.

### Goal

Improve safety without breaking developer experience.

Happy to adjust changes based on feedback.## Security Hardening - safer install and configuration flow

This document introduces an initial security hardening notice focused on reducing supply-chain and persistence risks in installation and configuration flows.

### What was changed

- Added initial security notice document
- Highlighted ongoing security hardening review

### Why

The current installation flow may rely on patterns such as:
- mutable dependencies (e.g. `@latest`)
- remote script execution (e.g. `curl | bash`)
- potential environment-level configuration changes

While no malicious behavior was identified, these patterns can increase risk in stricter threat models.

### Goal

Improve safety without breaking developer experience.

Happy to adjust changes based on feedback.