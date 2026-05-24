import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  Route53Client,
  GetHealthCheckStatusCommand,
  GetHealthCheckCommand,
} from "@aws-sdk/client-route-53";
import {
  SSMClient,
  GetParametersByPathCommand,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import { AWS_REGION } from "../constants.js";

// Lazy singletons — created on first use
let _cwl: CloudWatchLogsClient | null = null;
let _r53: Route53Client | null = null;
let _ssm: SSMClient | null = null;

export function getCwlClient(): CloudWatchLogsClient {
  return (_cwl ??= new CloudWatchLogsClient({ region: AWS_REGION }));
}

export function getR53Client(): Route53Client {
  return (_r53 ??= new Route53Client({ region: "us-east-1" }));
}

export function getSsmClient(): SSMClient {
  return (_ssm ??= new SSMClient({ region: AWS_REGION }));
}

// ─── CloudWatch Logs ─────────────────────────────────────────────────────────

export interface LogEvent {
  timestamp: number;
  message: string;
  logStream: string;
}

/** Fetch recent log events from a Lambda log group. */
export async function getLambdaLogs(
  logGroupName: string,
  startMs: number,
  limit: number,
  filterPattern?: string,
): Promise<LogEvent[]> {
  const client = getCwlClient();
  const cmd = new FilterLogEventsCommand({
    logGroupName,
    startTime: startMs,
    limit,
    ...(filterPattern ? { filterPattern } : {}),
  });
  const res = await client.send(cmd);
  return (res.events ?? []).map((e) => ({
    timestamp: e.timestamp ?? 0,
    message: (e.message ?? "").trim(),
    logStream: e.logStreamName ?? "",
  }));
}

/** List Lambda log groups matching a prefix. */
export async function listLambdaLogGroups(prefix: string): Promise<string[]> {
  const client = getCwlClient();
  const res = await client.send(
    new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, limit: 20 }),
  );
  return (res.logGroups ?? []).map((g) => g.logGroupName ?? "").filter(Boolean);
}

// ─── Route 53 ────────────────────────────────────────────────────────────────

export interface HealthCheckStatus {
  id: string;
  status: string;
  checkedRegions: { region: string; status: string }[];
}

export async function getHealthCheckStatus(
  healthCheckId: string,
): Promise<HealthCheckStatus> {
  const client = getR53Client();
  const statusRes = await client.send(
    new GetHealthCheckStatusCommand({ HealthCheckId: healthCheckId }),
  );
  const checkRes = await client.send(
    new GetHealthCheckCommand({ HealthCheckId: healthCheckId }),
  );

  const config = checkRes.HealthCheck?.HealthCheckConfig;
  const observations = statusRes.HealthCheckObservations ?? [];
  const checkedRegions = observations.map((o) => ({
    region: o.Region ?? "unknown",
    status: o.StatusReport?.Status ?? "unknown",
  }));

  const passing = checkedRegions.filter((r) =>
    r.status.toLowerCase().includes("success"),
  ).length;
  const total = checkedRegions.length;
  const overallStatus = passing > total / 2 ? "HEALTHY" : "UNHEALTHY";

  return {
    id: healthCheckId,
    status: overallStatus,
    checkedRegions,
  };
}

// ─── SSM ─────────────────────────────────────────────────────────────────────

export interface SsmParam {
  name: string;
  value?: string;
  type: string;
  lastModified?: Date;
}

/** List all SSM parameters under a path prefix (values not decrypted). */
export async function listSsmParameters(prefix: string): Promise<SsmParam[]> {
  const client = getSsmClient();
  const params: SsmParam[] = [];
  let nextToken: string | undefined;

  do {
    const res = await client.send(
      new GetParametersByPathCommand({
        Path: prefix,
        WithDecryption: false,
        NextToken: nextToken,
        MaxResults: 10,
      }),
    );
    for (const p of res.Parameters ?? []) {
      params.push({
        name: p.Name?.replace(`${prefix}/`, "") ?? "",
        // Mask SecureString values
        value: p.Type === "SecureString" ? "***REDACTED***" : (p.Value ?? ""),
        type: p.Type ?? "String",
        lastModified: p.LastModifiedDate,
      });
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return params;
}

/** Get a single SSM parameter by full name. */
export async function getSsmParameter(
  name: string,
  decrypt = false,
): Promise<SsmParam | null> {
  const client = getSsmClient();
  try {
    const res = await client.send(
      new GetParameterCommand({ Name: name, WithDecryption: decrypt }),
    );
    const p = res.Parameter;
    if (!p) return null;
    return {
      name: p.Name ?? name,
      value:
        p.Type === "SecureString" && !decrypt
          ? "***REDACTED (pass decrypt=true to reveal)***"
          : (p.Value ?? ""),
      type: p.Type ?? "String",
      lastModified: p.LastModifiedDate,
    };
  } catch {
    return null;
  }
}
