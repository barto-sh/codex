const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const ROOT = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
// Windows Terminal v1.24.12741.0 ControlCore::PasteText -> FilterStringForPaste.
// Clipboard CRLF and LF become CR on the connection; the composer returns LF.
const terminalPaste = (s) =>
  s
    .replace(/\r?\n/g, "\r")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
async function fileSha(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function payload(n, multi) {
  const line = "Zażółć gęślą jaźń; 0123456789 abcdef." + (multi ? "\n" : " ");
  return (
    "BEGIN|" +
    line.repeat(Math.floor(n / line.length) + 1).slice(0, n - 10) +
    "|END"
  );
}
class Probe {
  constructor(binary, extra = [], privateMode = false) {
    this.raw = "";
    this.closed = false;
    this.privateMode = privateMode;
    this.home =
      process.env.PASTE_PROBE_HOME ||
      fs.mkdtempSync(path.join(os.tmpdir(), "codex-paste-probe-"));
    const cwd = path.join(this.home, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("CODEX_")),
    );
    this.term = new Terminal({
      cols: 100,
      rows: 32,
      scrollback: 3000,
      allowProposedApi: true,
      logLevel: "off",
    });
    const defaultScreen = extra.includes("--probe-default-screen");
    const cliExtra = extra.filter((arg) => arg !== "--probe-default-screen");
    const args = [
      "--no-daemon",
      ...(defaultScreen ? [] : ["--no-alt-screen"]),
      "-c",
      'windows.sandbox="unelevated"',
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      'model_provider="paste_diagnostic"',
      "-c",
      'model_providers.paste_diagnostic.name="Local diagnostic"',
      "-c",
      'model_providers.paste_diagnostic.base_url="http://127.0.0.1:1/v1"',
      "-c",
      'model_providers.paste_diagnostic.wire_api="responses"',
      "-c",
      "model_providers.paste_diagnostic.requires_openai_auth=false",
      "-c",
      'model="paste-test"',
      "-c",
      `projects.${JSON.stringify(cwd)}.trust_level="trusted"`,
      ...cliExtra,
    ];
    let file = path.resolve(binary);
    if (file.endsWith(".js")) {
      args.unshift(file);
      file = process.execPath;
    }
    this.proc = pty.spawn(file, args, {
      cols: 100,
      rows: 32,
      cwd,
      env: {
        ...env,
        CODEX_HOME: this.home,
        VISUAL: path.join(ROOT, "paste-editor.cmd"),
        ...(privateMode ? { PASTE_PROBE_PRIVATE: "1" } : {}),
      },
      useConpty: true,
      useConptyDll: false,
    });
    this.dataSubscription = this.proc.onData((s) => {
      this.raw += s;
      this.term.write(s);
    });
    this.exitSubscription = this.proc.onExit((e) => {
      this.closed = true;
      this.exitCode = e.exitCode;
    });
    this.replySubscription = this.term.onData((s) => {
      if (!this.closed) this.proc.write(s);
    });
  }
  visible() {
    const b = this.term.buffer.active;
    let lines = [];
    for (let y = 0; y < 32; y++)
      lines.push(b.getLine(b.viewportY + y)?.translateToString(true) || "");
    return lines.join("\n");
  }
  write(s) {
    const chars = Array.from(s);
    for (let i = 0; i < chars.length; i += 512)
      this.proc.write(chars.slice(i, i + 512).join(""));
  }
  async wait(fn, ms = 30000) {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      if (fn()) return;
      if (this.closed) throw Error("Own test CLI exited: " + this.exitCode);
      await sleep(5);
    }
    throw Error("Probe timeout; terminal contents withheld");
  }
  async start() {
    await this.wait(() => this.raw.includes("paste-test"), 180000);
    this.write("\x1b");
    await sleep(600);
  }
  async capture() {
    const p = path.join(ROOT, "capture.json");
    let old = fs.existsSync(p) ? fs.statSync(p, { bigint: true }).mtimeNs : 0n;
    let meta;
    this.write("\x07");
    await this.wait(() => {
      try {
        if (fs.statSync(p, { bigint: true }).mtimeNs === old) return false;
        meta = JSON.parse(fs.readFileSync(p, "utf8"));
        return typeof meta.received_sha256 === "string";
      } catch {
        return false;
      }
    }, 60000);
    await sleep(150);
    return meta;
  }
  async clear() {
    const p = path.join(ROOT, "import.txt");
    fs.writeFileSync(p, "");
    try {
      await this.capture();
    } finally {
      fs.unlinkSync(p);
    }
    await sleep(250);
  }
  async stop() {
    for (let i = 0; i < 3 && !this.closed; i++) {
      this.write("\x03");
      await sleep(150);
    }
    if (!this.closed) {
      try {
        await this.wait(() => this.closed, 1500);
      } catch {}
    }
    if (!this.closed) {
      try {
        require("node:child_process").execFileSync(
          "taskkill",
          ["/PID", String(this.proc.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
      } catch {}
    }
    await sleep(300);
    this.dataSubscription.dispose();
    this.replySubscription.dispose();
    this.term.dispose();
    this.exitSubscription.dispose();
  }
}
async function main() {
  const args = process.argv.slice(2),
    binary = args[0];
  const baseline = args.includes("--baseline"),
    smoke = args.includes("--smoke"),
    stress = args.includes("--stress"),
    screenCheck = args.includes("--screen-check"),
    coldCheck = args.includes("--cold-check");
  const profileAt = args.indexOf("--profile-one"),
    profileDir = profileAt >= 0 ? path.resolve(args[profileAt + 1]) : null;
  const sizeAt = args.indexOf("--profile-size"),
    profileSize = sizeAt >= 0 ? Number(args[sizeAt + 1]) : 65536;
  const out = path.join(
    ROOT,
    coldCheck
      ? "node-cold-start-results.json"
      : screenCheck
        ? "node-default-screen-results.json"
        : profileDir
          ? "node-profile-results.json"
          : smoke
            ? "node-smoke-results.json"
            : stress
              ? "node-stress-results.json"
              : baseline
                ? "node-baseline-results.json"
                : "node-candidate-results.json",
  );
  const binaryPath = fs.realpathSync(path.resolve(binary));
  fs.writeFileSync(out, JSON.stringify([]));
  fs.writeFileSync(
    out.replace(".json", ".meta.json"),
    JSON.stringify(
      {
        binary: binaryPath,
        sha256: await fileSha(binaryPath),
        started_at: new Date().toISOString(),
        node_version: process.version,
        transport: "node-pty 1.1.0; native OS ConPTY; @xterm/headless 6.0.0",
        cols: 100,
        rows: 32,
        screen: screenCheck ? "default" : "--no-alt-screen",
        chunk_size_codepoints: 512,
        ready:
          "Follow-up marker rendered in composer after complete input write",
        export:
          "Separate Ctrl+G full-text SHA-256 check; excluded from ready_ms",
        paste_adapter:
          "Windows Terminal v1.24.12741.0 FilterStringForPaste: CRLF/LF -> CR, C0/C1 filtering except HT/CR",
      },
      null,
      2,
    ),
  );
  const t = new Probe(binary, screenCheck ? ["--probe-default-screen"] : []);
  const rows = [];
  try {
    if (coldCheck) {
      await t.wait(
        () => t.raw.includes("Ask Codex") || t.raw.includes("paste-test"),
        45000,
      );
    } else await t.start();
    for (const multi of coldCheck || screenCheck
      ? [true]
      : smoke || stress || profileDir
        ? [false]
        : [false, true])
      for (const n of coldCheck
        ? [65536]
        : screenCheck
          ? profileDir
            ? [profileSize]
            : [65536, 262144]
          : profileDir
            ? [profileSize]
            : stress
              ? [262144]
              : smoke
                ? [1024]
                : baseline
                  ? [1024, 8192, 65536]
                  : [1024, 8192, 65536, 262144])
        for (
          let repeat = 0;
          repeat < (coldCheck || smoke || stress || profileDir ? 1 : 3);
          repeat++
        ) {
          if (!coldCheck) await t.clear();
          const text = payload(n, multi),
            marker = `READY_${+multi}_${n}_${repeat}_9d7`,
            expected = sha(text + marker);
          if (profileDir) {
            fs.mkdirSync(profileDir, { recursive: true });
            fs.writeFileSync(
              path.join(profileDir, "ready.json"),
              JSON.stringify({ pid: t.proc.pid }),
            );
            await t.wait(
              () => fs.existsSync(path.join(profileDir, "go")),
              120000,
            );
          }
          const model_label_seen_before_input = t.raw.includes("paste-test");
          const wire = terminalPaste(text);
          const start = performance.now();
          t.write("\x1b[200~" + wire + "\x1b[201~");
          const sent = performance.now();
          t.write("\x05" + marker);
          await t.wait(() => t.visible().includes(marker), 120000);
          const ready = performance.now();
          if (coldCheck)
            await t.wait(() => t.raw.includes("paste-test"), 60000);
          const exportStart = performance.now(),
            meta = await t.capture(),
            verified = performance.now();
          const row = {
            chars: n,
            input_bytes: Buffer.byteLength(text),
            input_lines: text.split("\n").length,
            input_sha256: sha(text),
            wire_bytes: Buffer.byteLength(wire),
            wire_sha256: sha(wire),
            marker,
            multiline: multi,
            repeat,
            send_ms: sent - start,
            ready_ms: ready - start,
            export_roundtrip_ms: verified - exportStart,
            post_ready_wait_ms: exportStart - ready,
            full_verified_ms: verified - start,
            first_composer_input: coldCheck,
            model_label_seen_before_input,
            received_bytes: meta.received_bytes,
            exact: meta.received_sha256 === expected,
            expected_sha256: expected,
          };
          rows.push(row);
          fs.writeFileSync(out, JSON.stringify(rows, null, 2));
          console.log(JSON.stringify(row));
          if (profileDir) {
            fs.writeFileSync(
              path.join(profileDir, "finished"),
              JSON.stringify(row),
            );
            await t.wait(
              () => fs.existsSync(path.join(profileDir, "done")),
              30000,
            );
          }
          if (!row.exact && !baseline) throw Error("Full prompt mismatch");
        }
  } finally {
    await t.stop();
  }
}
module.exports = { Probe, payload, ROOT, sleep, sha, terminalPaste };
if (require.main === module)
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e.stack);
      process.exit(1);
    },
  );
