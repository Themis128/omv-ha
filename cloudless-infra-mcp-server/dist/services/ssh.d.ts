import { NodeName } from "../constants.js";
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
 * Runs a shell command on the specified Pi node over SSH.
 * Creates a fresh connection per call (simple, avoids stale socket issues).
 */
export declare function runOnNode(node: NodeName, command: string): Promise<ExecResult>;
/**
 * Runs the same command on both nodes concurrently.
 */
export declare function runOnBothNodes(command: string): Promise<Record<NodeName, ExecResult>>;
/**
 * Uploads a local file to the remote node via SFTP.
 */
export declare function uploadFile(node: NodeName, localPath: string, remotePath: string): Promise<UploadResult>;
/** Human-friendly label for a node */
export declare function nodeLabel(node: NodeName): string;
