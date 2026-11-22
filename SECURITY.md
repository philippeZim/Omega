# Security Policy

## Supported versions

Omega is a small project, so security fixes go into the newest release only. Omega updates itself, so the fix reaches most installs on their next start. `.deb` and `.rpm` installs have to be updated by hand.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No, please update first |

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a security problem.**

Report it privately instead:

1. Open the [Security tab](https://github.com/philippeZim/Omega/security) of this repository.
2. Click **Report a vulnerability**.
3. Fill in the form.

Only you and the maintainers can see the report. These details help most:

- the Omega version and your operating system
- what an attacker can do, and what they need first (for example, the victim opens a crafted file or joins a session)
- steps to reproduce it, ideally with a minimal file or project
- a suggested fix, if you have one

## What to expect

Omega is maintained in spare time, so these are goals rather than guarantees:

| Step | Goal |
| --- | --- |
| First reply | within 7 days |
| Assessment (confirmed or not, and how severe) | within 14 days |
| Fix for a critical or high severity issue | within 30 days |
| Fix for a medium or low severity issue | within 90 days, or in a later regular release |

We'll keep you posted if something takes longer. Once a fix is released, we publish an advisory through GitHub and credit you, unless you'd rather stay anonymous. Please keep the issue private until then.

Omega has no bug bounty.

## Scope

In scope are problems in Omega itself, for example:

- a crafted file or project that runs code just by being opened or previewed
- ways around update signature checks
- a Code Together participant gaining access beyond what the session allows
- escaping the web view into the Tauri backend

Not in scope:

- **Compiling or running untrusted content.** LaTeX compilation, build and run commands and language servers start real programs with your user's permissions, and Omega doesn't sandbox them. Only compile or run projects you trust. Giving a Code Together guest the `run` right is the same trust decision, because their compiles and commands run on your machine.
- Vulnerabilities in third-party tools that Omega starts, such as compilers or language servers. Please report those to their projects.
- Attacks that already require control of your user account or machine.
