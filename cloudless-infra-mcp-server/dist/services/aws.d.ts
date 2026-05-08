import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { Route53Client } from "@aws-sdk/client-route-53";
import { SSMClient } from "@aws-sdk/client-ssm";
export declare function getCwlClient(): CloudWatchLogsClient;
export declare function getR53Client(): Route53Client;
export declare function getSsmClient(): SSMClient;
export interface LogEvent {
    timestamp: number;
    message: string;
    logStream: string;
}
/** Fetch recent log events from a Lambda log group. */
export declare function getLambdaLogs(logGroupName: string, startMs: number, limit: number, filterPattern?: string): Promise<LogEvent[]>;
/** List Lambda log groups matching a prefix. */
export declare function listLambdaLogGroups(prefix: string): Promise<string[]>;
export interface HealthCheckStatus {
    id: string;
    status: string;
    checkedRegions: {
        region: string;
        status: string;
    }[];
}
export declare function getHealthCheckStatus(healthCheckId: string): Promise<HealthCheckStatus>;
export interface SsmParam {
    name: string;
    value?: string;
    type: string;
    lastModified?: Date;
}
/** List all SSM parameters under a path prefix (values not decrypted). */
export declare function listSsmParameters(prefix: string): Promise<SsmParam[]>;
/** Get a single SSM parameter by full name. */
export declare function getSsmParameter(name: string, decrypt?: boolean): Promise<SsmParam | null>;
