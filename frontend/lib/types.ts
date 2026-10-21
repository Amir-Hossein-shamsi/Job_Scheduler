export type User = { id: string; email: string; role: string };
export type Connection = {
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  tls_enabled: boolean;
  trust_server_certificate: boolean;
};
export type Job = {
  id: string;
  name: string;
  description: string;
  script_type: string;
  script_path: string;
  args: string[];
  env: Record<string, string>;
  working_dir: string;
  timeout_seconds: number;
  enabled: boolean;
  connection?: Connection;
  created_at: string;
};
export type Run = {
  id: string;
  job_id: string;
  status: string;
  trigger_type: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  error_message?: string;
  worker_id?: string;
  created_at: string;
};
export type Schedule = {
  id: string;
  job_id: string;
  type: string;
  run_at?: string;
  cron_expr?: string;
  interval_seconds?: number;
  timezone: string;
  next_run_at?: string;
  enabled: boolean;
  created_at: string;
};
export type Log = {
  id: number;
  run_id: string;
  timestamp: string;
  stream: string;
  message: string;
};
