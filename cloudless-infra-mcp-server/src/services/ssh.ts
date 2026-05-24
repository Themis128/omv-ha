import { NodeSSH } from "node-ssh";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { SSH_CONFIG, NodeName } from "../constants.js";

export interface UploadResult {
  code: number;
  stderr: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
}

/**
 * Tries multiple common private key paths and returns the first that exists.
 */
function resolvePrivateKey(configuredPath: string): string {
  const candidates = [
    configuredPath,
    join(homedir(), ".ssh", "id_ed25519"),
    join(homedir(), ".ssh", "id_rsa"),
    join(homedir(), ".ssh", "id_ecdsa"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  throw new Error(
    `No SSH private key found. Tried: ${candidates.join(", ")}. ` +
      "Set PI_SSH_KEY_PATH env var to the correct path.",
  );
}

/**
 * Runs a shell command on the specified Pi node over SSH.
 * Creates a fresh connection per call (simple, avoids stale socket issues).
 */
export async function runOnNode(
  node: NodeName,
  command: string,
): Promise<ExecResult> {
  const cfg = SSH_CONFIG[node];
  const ssh = new NodeSSH();

  try {
    await ssh.connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: resolvePrivateKey(cfg.privateKeyPath),
      readyTimeout: 10_000,
    });

    const result = await ssh.execCommand(command, {
      execOptions: { pty: false },
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code ?? 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: msg, code: 1, error: msg };
  } finally {
    ssh.dispose();
  }
}

/**
 * Runs the same command on both nodes concurrently.
 */
export async function runOnBothNodes(
  command: string,
): Promise<Record<NodeName, ExecResult>> {
  const [haResult, mainResult] = await Promise.allSettled([
    runOnNode("omv-ha", command),
    runOnNode("omv-main", command),
  ]);

  return {
    "omv-ha":
      haResult.status === "fulfilled"
        ? haResult.value
        : {
            stdout: "",
            stderr:
              (haResult as PromiseRejectedResult).reason?.message ?? "Failed",
            code: 1,
          },
    "omv-main":
      mainResult.status === "fulfilled"
        ? mainResult.value
        : {
            stdout: "",
            stderr:
              (mainResult as PromiseRejectedResult).reason?.message ?? "Failed",
            code: 1,
          },
  };
}

/**
 * Uploads a local file to the remote node via SFTP.
 */
export async function uploadFile(
  node: NodeName,
  localPath: string,
  remotePath: string,
): Promise<UploadResult> {
  const cfg = SSH_CONFIG[node];
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: resolvePrivateKey(cfg.privateKeyPath),
      readyTimeout: 10_000,
    });
    await ssh.putFile(localPath, remotePath);
    return { code: 0, stderr: "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 1, stderr: msg };
  } finally {
    ssh.dispose();
  }
}

/** Human-friendly label for a node */
export function nodeLabel(node: NodeName): string {
  return node === "omv-ha"
    ? "OMV-HA (192.168.1.130)"
    : "OMV main / Pi 5 (192.168.1.128)";
}
