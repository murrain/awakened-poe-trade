import { appendFileSync, writeFileSync } from "node:fs";
import type { ServerEvents } from "./server";

export class Logger {
  history = "";
  private readonly logPath =
    process.platform === "linux" ? "/tmp/apoe-debug.log" : undefined;

  constructor(private server: ServerEvents) {
    if (this.logPath) {
      try {
        writeFileSync(this.logPath, "");
      } catch {}
    }
  }

  write(message: string) {
    message = `[${new Date().toLocaleTimeString()}] ${message}\n`;
    this.history += message;
    if (this.logPath) {
      try {
        appendFileSync(this.logPath, message);
      } catch {}
    }
    this.server.sendEventTo("broadcast", {
      name: "MAIN->CLIENT::log-entry",
      payload: { message },
    });
  }
}
