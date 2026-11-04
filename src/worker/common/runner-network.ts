import {
  isJobPolicyLabel,
  LIMITED_CONNECT_LABEL,
} from "../../../packages/contracts/runner-scheduling.mjs";

export interface RunnerNetworkRetry {
  retry_key: string;
  kind: "gitedge" | "github";
  repository_id: string;
  connection_id: string | null;
  github_run_id: number | null;
  source_job_id: string;
  source_runner_id: string | null;
  source_lease_hash: string | null;
  failure_log: string;
  started_at: number;
  completed_at: number;
  state: "pending" | "requested" | "failed";
  error_code: string | null;
  created_at: number;
  requested_at: number | null;
}

export function permitsNetworkRetry(labels: string[], runnerLabels: string[]): boolean {
  return (
    labels.some(isJobPolicyLabel) &&
    runnerLabels.some((label) => label.toLowerCase() === LIMITED_CONNECT_LABEL)
  );
}

export function isNetworkFailure(log: string): boolean {
  const plain = log.replace(/\u001b\[[0-9;]*m/g, "");
  return plain.split(/\r?\n/).some((line) => {
    if (/\bWARN(?:ING)?\b/i.test(line)) return false;
    return (
      /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b[^\n]*(?:request to https?:|connect|fetch|socket hang up)/i.test(
        line
      ) ||
      /fatal: unable to access 'https?:[^\n]+(?:Could not resolve host|Failed to connect|Connection timed out|Connection reset by peer)/i.test(
        line
      ) ||
      /curl: \((?:5|6|7|28|35|56)\) [^\n]*(?:resolve|connect|timed out|reset|SSL)/i.test(line)
    );
  });
}

export function githubNetworkRetryKey(connectionId: string, runId: number): string {
  return `github:${connectionId}:${runId}`;
}

export function gitedgeNetworkRetryKey(runId: string): string {
  return `gitedge:${runId}`;
}
