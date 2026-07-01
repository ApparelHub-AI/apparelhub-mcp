// Progress streaming for long-running tools (tool spec §8). MCP delivers progress via
// `notifications/progress`, keyed to the progressToken the client sends in the call's _meta.
// Best-effort by contract: a failed notification must NEVER fail the tool.

export type SendNotification = (notification: {
  method: string;
  params?: Record<string, unknown>;
}) => Promise<void>;

export class ProgressReporter {
  private readonly total = 100;

  constructor(
    private readonly send?: SendNotification,
    private readonly token?: string | number,
  ) {}

  /** Report progress as a percentage (0-100) with an optional human message. */
  async report(percent: number, message?: string): Promise<void> {
    if (!this.send || this.token === undefined) return;
    const params: Record<string, unknown> = {
      progressToken: this.token,
      progress: Math.max(0, Math.min(this.total, percent)),
      total: this.total,
    };
    if (message) params.message = message;
    try {
      await this.send({ method: 'notifications/progress', params });
    } catch (err) {
      // Progress is a UX nicety, not part of the result. Log to stderr (stdout is the MCP
      // channel) and carry on — never surface a notification failure as a tool error.
      console.error('apparelhub-mcp: progress notification failed:', err);
    }
  }
}
