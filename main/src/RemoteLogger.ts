import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import type { ServerEvents } from './server'

export class Logger {
  history = ''
  // Write stream opened once per session; non-blocking unlike appendFileSync.
  private logStream: fs.WriteStream

  constructor (
    private server: ServerEvents
  ) {
    const logPath = path.join(app.getPath('userData'), 'debug.log')
    // 'w' flag truncates the file so each session starts fresh.
    this.logStream = fs.createWriteStream(logPath, { flags: 'w' })
    this.logStream.write(`--- session started ${new Date().toISOString()} ---\n`)
  }

  write (message: string) {
    message = `[${new Date().toLocaleTimeString()}] ${message}\n`
    this.history += message
    this.server.sendEventTo('broadcast', {
      name: 'MAIN->CLIENT::log-entry',
      payload: { message }
    })
    this.logStream.write(message)
  }
}
