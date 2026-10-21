/** Native OpenCode runs projected into one Quati chat; a reused session can have several runs. */
export interface BackgroundTask {
  id: string;
  rootSessionId: string;
  parentSessionId: string;
  childSessionId: string;
  description: string;
  agent: string;
  model?: string;
  status: "running" | "completed" | "failed" | "interrupted" | "unknown";
  createdAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

/** Admission is not completion. Unknown delivery must never be retried automatically. */
export interface BackgroundReceipt {
  id: string;
  taskId: string;
  action: "steer" | "interrupt";
  status: "pending" | "accepted" | "uncertain" | "rejected";
  createdAt: number;
  nativeId?: string;
}

export interface BackgroundSnapshot {
  tasks: BackgroundTask[];
  receipts: BackgroundReceipt[];
  connected: boolean;
  error?: string;
}
