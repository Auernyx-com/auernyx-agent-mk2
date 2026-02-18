# Security Policy

## Supported Versions

Use this section to tell people about which versions of your project are
currently being supported with security updates.

1. The "Clean House" Script
Run this inside your local repository folder. It will list every remote (where your data is being sent) and every hook (scripts that run automatically on commit/push).

Bash
#!/bin/bash
echo "--- 1. Checking Remotes (Where your data goes) ---"
git remote -v

echo -e "\n--- 2. Checking for Local Hooks (Pre-push/Post-commit scripts) ---"
ls -la .git/hooks | grep -v ".sample"

echo -e "\n--- 3. Checking for Config Overrides (Hidden data points) ---"
git config --list --show-origin | grep -E "url|hook|proxy|email"

echo -e "\n--- 4. Checking for Submodules (Hidden code injection) ---"
git submodule status
2. The "Hard Reset" Commands
If you see anything suspicious in the output above, run these commands immediately to sever the connections:

To remove a suspicious remote:
git remote remove [name_of_remote] (usually named 'origin' or 'upstream')

To wipe all local hooks (stops automated exfiltration):
rm -rf .git/hooks/*

To unset a global identity he might have set:
git config --global --unset-all user.name
git config --global --unset-all user.email

3. The "Kill Switch" for GitHub (The Prompt you asked for)
If you are communicating with a security tool or another LLM to help you "automate" the cleanup of your GitHub account via API, use this Specific Prompt:

"Act as a Senior DevSecOps Engineer. Use the GitHub CLI (gh) or REST API to:

List all active Webhooks for [Repository Name] and delete any URL not matching [Your Trusted URL].

List all Authorized OAuth Apps and Personal Access Tokens created in the last 48 hours and revoke them.

Audit all Deploy Keys and remove any fingerprints I did not personally authorize.

Force-reset all Repository Secrets to null/placeholder values immediately."

The Most Important Step
If he has "everything," he likely has your SSH Key or PAT.
Go to your GitHub Settings > SSH and GPG keys and DELETE every single key there. 
| Version | Supported          |
| ------- | ------------------ |
| 5.1.x   | :white_check_mark: |
| 5.0.x   | :x:                |
| 4.0.x   | :white_check_mark: |
| < 4.0   | :x:                |

## Reporting a Vulnerability

Use this section to tell people how to report a vulnerability.

Tell them where to go, how often they can expect to get an update on a
reported vulnerability, what to expect if the vulnerability is accepted or
declined, etc.
