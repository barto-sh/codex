# Windows paste reproduction

This harness drives the **native Windows CLI** through the operating system's ConPTY implementation. It measures when a follow-up editing marker is rendered, then independently exports the entire composer with Ctrl+G and compares SHA-256. Completing a pipe write is not counted as completing a paste.

The input-mode change requires the pinned Windows VT decoder in the same build. Apply the integration commit, including its dependency update, as a unit.

Requirements: Windows with ConPTY, Node.js 22 or later, Python 3 on PATH, and two CLI binaries to compare. The dependency `node-pty` may require the Visual C++ build tools if its prebuilt binary is unavailable.

From this directory in PowerShell:

```powershell
npm ci
# Use a disposable profile, never your normal CODEX_HOME.
$env:PASTE_PROBE_HOME = Join-Path $env:TEMP ('codex-paste-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $env:PASTE_PROBE_HOME | Out-Null

node probe.cjs C:\path\to\baseline\codex.exe --baseline
Copy-Item node-baseline-results.json baseline.json
node probe.cjs C:\path\to\candidate\codex.exe
Copy-Item node-candidate-results.json candidate.json
node probe.cjs C:\path\to\candidate\codex.exe --screen-check
node probe.cjs C:\path\to\candidate\codex.exe --cold-check
node functional.cjs C:\path\to\candidate\codex.exe
```

Run each command sequentially, with compilers and profilers stopped. `--cold-check` starts a new CLI process and pastes at the first visible composer without warming it with Escape or Ctrl+G; run it three times and retain each JSON before the next invocation overwrites it. This tests first-composer input, not a first-ever installation with an empty plugin cache. Startup before the measured paste is excluded from the regular measurements.

The harness creates a scratch workspace inside the disposable profile and trusts **only that workspace** through process-local overrides. It selects the non-admin Windows sandbox through a process-local override so the sandbox setup dialog does not intercept editor shortcuts. It neither provisions an elevated sandbox nor executes shell commands through the agent. Internal `CODEX_*` variables inherited from a parent agent are removed. Credentials use the empty profile's file store; no login is needed. The normal user configuration, clipboard and active sessions are untouched.

The provider is a synthetic, unauthenticated loopback endpoint. Performance probes do not submit a prompt. The functional test starts a local HTTP server and explicitly submits only the final synthetic prompt to it; it checks that previous pastes caused zero submissions. The normal startup may synchronize public bundled plugins. Keep the disposable profile to avoid repeating that setup between commands.

Measurements:

- `send_ms`: synchronous writes into the ConPTY connection.
- `ready_ms`: from the beginning of those writes to a rendered follow-up marker.
- `export_roundtrip_ms`: separate editor-protocol export, excluded from `ready_ms`.
- `exact`: full exported text matches the expected input plus marker.
- `input_sha256` and `wire_sha256`: semantic text and actual transport payload, respectively.

The input adapter follows [Windows Terminal 1.24.12741.0](https://github.com/microsoft/terminal/blob/v1.24.12741.0/src/types/utils.cpp): CRLF/LF become CR, and other C0/C1 controls except HT/CR are filtered before the terminal's bracketed paste delimiters. The expected composer text uses LF. This is a source-matched ConPTY reproduction, **not an observed physical Ctrl+V in Windows Terminal**. Clipboard images, IME and physical keyboard layouts require separate compatibility testing.

The baseline matrix is 1,024 / 8,192 / 65,536 characters, single-line and multiline, three repetitions each. The candidate adds 262,144. `--screen-check` tests 65,536 and 262,144 multiline characters three times each with the normal alternate-screen setting. The functional matrix covers Unicode including non-BMP characters, CRLF/LF, tabs and empty lines, fragmented delimiters with a delayed close, insertion in the middle of a draft, unframed input, repeated large pastes, resize, subsequent editing, cancellation and literal command-like lines.

The `.json` results and `capture.txt` are generated locally and ignored by Git. Only use synthetic input with this harness. The editor helper contains no network code. Inspect results before sharing them; do not upload your normal Codex profile or arbitrary diagnostic logs.

## Recorded validation

Source integration: `3c66589bc87b4793333eb7a1b1e28b70792b2aff`; reproduction harness: `233b7f5b427f7b9f383a3819e57eb058025a7278`. [Raw synthetic measurements and test counts](validation-results.json).

The comparison is the installed release `codex-cli 0.163.0` versus this patched main build `codex-cli 0.0.0`, not a same-base full-CLI A/B. Both use identical semantic and transport payloads. The underlying decoder, mode restoration and queue-order behavior also have focused native tests.

| Binary / screen    | Characters / shape    | Median marker latency |           Range | Exact |
| ------------------ | --------------------- | --------------------: | --------------: | ----: |
| baseline (inline)  | 65,536 / single line  |              18.647 s | 18.358-19.167 s |   3/3 |
| baseline (inline)  | 65,536 / multiline    |              18.370 s | 17.649-18.729 s |   3/3 |
| candidate (inline) | 65,536 / single line  |               0.187 s |   0.185-0.188 s |   3/3 |
| candidate (inline) | 65,536 / multiline    |               0.186 s |   0.185-0.186 s |   3/3 |
| candidate (inline) | 262,144 / single line |               0.343 s |   0.341-0.358 s |   3/3 |
| candidate (inline) | 262,144 / multiline   |               0.339 s |   0.337-0.342 s |   3/3 |
| default-screen     | 65,536 / multiline    |               0.187 s |   0.186-0.202 s |   3/3 |
| default-screen     | 262,144 / multiline   |               0.341 s |   0.341-0.353 s |   3/3 |

A baseline `exact=false` is an observed content mismatch, not a successful paste. All final candidate cases require full-text equality. The three first-composer measurements have median 0.145 s and exact text in all three. The functional sequence passed 19 cases.

Measured production build: `cargo +stable build --release -p codex-cli --bin codex --locked --config 'profile.release.package.codex-tui.codegen-units=16' --config 'profile.release.package.codex-cli.codegen-units=16'` using `rustc 1.96.1 (31fca3adb 2026-06-26)`. The 16-unit overrides affect build parallelism; release optimization and thin LTO remain enabled.

The selected TUI groups passed 155 tests with zero failures. Library CI passed Windows 142 unit tests (10 ignored), Ubuntu 154 (7 ignored), 53 doctests on each, formatting and Clippy with `-D warnings`: [CI run](https://github.com/barto-sh/crossterm/actions/runs/39281925280). That CI head differs from the pinned dependency only by its workflow file. A mutation restoring premature Escape expiry failed the real queued-opener regression; restoring the final implementation passed. Native WinAPI checks restored both original VT states and reasserted VT after an external clear without changing other bits.

These are controlled ConPTY observations. Physical clipboard gestures, IME/layout compatibility, image clipboard and legacy-conhost end-to-end behavior were not observed. The tests do not establish results for Claude Code or pi.
