// CommonJS to use node-ssh's CJS build (avoids ESM resolution issue)
const { NodeSSH } = require("node-ssh");
const { readFileSync, existsSync, mkdirSync, writeFileSync } = require("fs");
const { join } = require("path");
const { homedir } = require("os");

async function main() {
  const keyPath = join(homedir(), ".ssh", "id_ed25519");
  const ssh = new NodeSSH();

  console.log("Connecting to 192.168.1.128 ...");
  await ssh.connect({
    host: "192.168.1.128",
    port: 22,
    username: "tbaltzakis",
    privateKey: readFileSync(keyPath, "utf-8"),
    readyTimeout: 10000,
  });

  console.log("Connected. Fetching kubeconfig...");
  const result = await ssh.execCommand("sudo k3s kubectl config view --raw");
  ssh.dispose();

  if (!result.stdout) {
    console.error("No output from kubectl config view. stderr:", result.stderr);
    process.exit(1);
  }

  let kubeconfig = result.stdout;
  kubeconfig = kubeconfig.replace(
    /https:\/\/(127\.0\.0\.1|localhost):6443/g,
    "https://192.168.1.128:6443"
  );

  const kubeDir = join(homedir(), ".kube");
  if (!existsSync(kubeDir)) mkdirSync(kubeDir, { recursive: true });

  const outputPath = join(kubeDir, "config-k3s-pi");
  writeFileSync(outputPath, kubeconfig, { mode: 0o600 });
  console.log("\nKubeconfig saved to:", outputPath);

  const preview = kubeconfig
    .replace(/certificate-authority-data: .+/g, "certificate-authority-data: <redacted>")
    .replace(/client-certificate-data: .+/g, "client-certificate-data: <redacted>")
    .replace(/client-key-data: .+/g, "client-key-data: <redacted>");
  console.log("\n--- Config ---");
  console.log(preview);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
