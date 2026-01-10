# Kotlin Consumer Scope

## v1 (locked)
Tag: `yggdrasil-kotlin-consumer@v1`

This project is a **pure verifier + receipt emitter**:
- Parses a strict, minimal envelope.
- Verifies canonical payload digest (SHA-256).
- Emits governance receipts using **locked decision/refusal codes**.
- Does **not** perform repo side effects (git status capture, canon ignore enforcement, writes beyond its own receipt dir).

## v2 decision
Decision: **Keep Kotlin as a pure verifier/receipt emitter**.

Rationale (boring on purpose):
- Avoids mixing responsibilities (verifier vs executor).
- Keeps the contract surface minimal and easy to audit.
- Leaves repo-specific checks (git porcelain, canon ignore) to the TypeScript trunk and other execution branches.
