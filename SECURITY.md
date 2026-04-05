# Security Policy

**Last Updated:** February 2026

## Overview

This document outlines the security policy for Auernyx Agent Mk2, a governed AI orchestrator with strict policy enforcement and tamper-evident audit trails. This is a daemon-first system that separates reasoning (Auernyx), execution (controlled capabilities), and audit (Kintsugi ledger).

**Scope:** This policy covers the core orchestration daemon, CLI client, VS Code extension, and all registered capabilities. It applies to vulnerabilities in authentication, authorization, data handling, governance controls, and dependency management.

## Supported Versions

We provide security updates for the following versions:

| Version | Supported | Notes                           |
| ------- | --------- | ------------------------------- |
| main    | ✅ Yes    | Active development branch       |
| 0.x.x   | ✅ Yes    | Pre-release, actively maintained|

**Note:** This project is in pre-release (0.x.x series). Breaking changes may occur between minor versions as we stabilize the governance model and API surface.

## Reporting a Vulnerability

**⚠️ Important:** Please **DO NOT** report security vulnerabilities through public GitHub issues.

### Preferred Method: GitHub Security Advisories (Private Disclosure)

1. Navigate to the **Security** tab of this repository
2. Click **"Report a vulnerability"**
3. Provide a detailed description including:
   - Type of vulnerability (e.g., RCE, privilege escalation, path traversal)
   - Affected component(s) and version(s)
   - Steps to reproduce
   - Potential impact assessment
   - Suggested mitigation (if applicable)

### Alternative: Direct Email Contact

If you cannot use GitHub Security Advisories, email: **admin@auernyx.com**

> ⚠️ **Maintainer Note:** Update the email address above with your actual security contact email.

**Subject line format:** `[SECURITY] Brief description of vulnerability`

### What to Expect

**Response Timeline:**
- **Initial response:** Within 48 hours of report submission
- **Status updates:** Every 5 business days until resolution
- **Fix timeline by severity:**
  - 🔴 **Critical:** 1-7 days (RCE, auth bypass, data exfiltration)
  - 🟡 **High:** 7-30 days (privilege escalation, significant data exposure)
  - 🟢 **Medium:** 30-90 days (DoS, minor information disclosure)
  - **Low:** Best effort, may defer to next release

**If Accepted:**
1. We will confirm the vulnerability and assign a severity level
2. You will be credited in the advisory (unless you request anonymity)
3. We will develop a patch and coordinate disclosure timing with you
4. A CVE identifier will be requested for qualifying vulnerabilities
5. Security advisory and patch will be published simultaneously

**If Declined:**
1. We will explain why the report does not qualify as a security vulnerability
2. If it's a bug, we will direct you to open a public issue
3. If it's out of scope, we will reference this document's scope section

## Security Best Practices for Contributors

### Code Changes
- All changes must go through the **alteration program** governance flow
- Intent files must be properly formatted and approved before merge
- Run `python3 tools/ci_gate.py` locally before pushing
- Never commit secrets, tokens, or credentials to the repository

### Local Development Security Checks
```bash
# Type checking
npm run typecheck

# Build verification
npm run compile

# Full verification (includes capability tests)
npm run verify

# Security audit of dependencies
npm audit

# Governance gate validation
python3 tools/ci_gate.py
```

### Dependency Management
- Dependencies are managed via npm and reviewed by Dependabot
- All dependency updates require an intent file in the alteration program
- Security updates are expedited through the governance process
- Review `npm audit` output before accepting dependency changes

## Known Security Considerations

### Local Daemon Server (Port 43117)
- The daemon server (`core/server.ts`) binds to **127.0.0.1 only** (localhost)
- No external network access by design
- Optional secret-based authentication via `AUERNYX_SECRET` environment variable
- Rate limiting: 30 requests per 10-second window (configurable)
- Max request body: 64 KB (configurable)

**Risk:** Local privilege escalation if an attacker gains local user access. Mitigation: Use `AUERNYX_SECRET` for production deployments.

### File System Access
- Capabilities have controlled file system access scoped to `scanAllowedRoots` (configured in `config/auernyx.config.json`)
- Path validation via `isSafeReceiptSegment` prevents directory traversal in receipt paths
- Write operations require `AUERNYX_WRITE_ENABLED=1` environment variable
- Protected paths (`.auernyx/kintsugi/`, ledger files) are append-only

**Risk:** Path traversal vulnerabilities in capability implementations. Mitigation: All file operations undergo validation before execution.

### Governance Controls (Alteration Program)
- Every code change requires an **intent file** in `governance/alteration-program/intent/`
- CI gate (`mk2-alteration-gate.yml`) enforces fail-closed invariants
- Intent files are hash-chained and tamper-evident
- Audit trail stored in `.auernyx/kintsugi/` ledger (append-only)

**Security property:** Changes to governance-critical code cannot bypass review due to CI enforcement. This is a foundational security control.

### Kintsugi Ledger (Audit Trail)
- All daemon operations are logged to an append-only hash-chained ledger (`logs/ledger.ndjson`)
- Receipts are generated for every capability execution
- Integrity verification available via `governanceSelfTest` capability

**Risk:** Ledger tampering if attacker gains write access to `.auernyx/` directory. Mitigation: Verify ledger integrity regularly, especially after incidents.

### Dependency Supply Chain
- Dependabot monitors for known vulnerabilities
- Automated alerts for security advisories
- Dependencies pinned via `package-lock.json`
- Dependency changes reviewed through alteration program

**Best practice:** Run `npm audit` before every release.

## Scope

### ✅ In Scope
- Remote code execution vulnerabilities
- Authentication and authorization bypasses
- Path traversal or directory escape
- Governance control bypasses (alteration gate evasion)
- Ledger tampering or audit trail corruption
- Privilege escalation (local or within daemon)
- Denial of service (DoS) affecting availability
- Information disclosure of sensitive data
- Dependency vulnerabilities with exploitable impact
- Memory safety issues leading to crashes or exploits

### ❌ Out of Scope
- Vulnerabilities in third-party services (GitHub, npm registry)
- Social engineering attacks
- Physical access attacks
- Issues requiring local admin/root access as a prerequisite
- Denial of service via resource exhaustion (rate limiting is documented behavior)
- Issues in deprecated or unsupported versions
- Theoretical vulnerabilities without proof-of-concept
- Reports about missing security headers (this is not a web application)

### ⚠️ Edge Cases
- **VS Code Extension:** Security issues in the extension wrapper should be reported here, but issues in VS Code itself should go to Microsoft.
- **Capability Plugins:** If a vulnerability exists in a specific capability (e.g., `scanRepo`, `analyzeDependency`), it is in scope.
- **Configuration Issues:** Misconfigurations that lead to security weaknesses are accepted, but we will provide guidance rather than patches.

## Security Contact

- **GitHub Security Advisories:** [https://github.com/Auernyx-com/auernyx-agent-mk2/security/advisories](https://github.com/Auernyx-com/auernyx-agent-mk2/security/advisories)
- **Email:** admin@aeurnyx.com
- **Issue Tracker (non-security bugs):** [https://github.com/Auernyx-com/auernyx-agent-mk2/issues](https://github.com/Auernyx-com/auernyx-agent-mk2/issues)

---

**Thank you for helping keep Auernyx Agent Mk2 and the community safe!**
