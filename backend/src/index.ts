import { app } from "./app.js"

const rawPort = process.env.PORT ?? "3001"
const parsedPort = Number(rawPort)
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
  throw new Error(`PORT must be an integer between 1 and 65535; received ${rawPort}`)
}

const server = app.listen(parsedPort, () => {
  console.log(`AI App Tester API listening on http://localhost:${parsedPort}`)
})

server.on("error", (error) => {
  console.error("API server failed", error)
  process.exitCode = 1
})

function shutdown(signal: string) {
  console.log(`${signal} received; closing API server`)
  server.close((error) => {
    if (error) {
      console.error("API server shutdown failed", error)
      process.exitCode = 1
    }
  })
}

process.once("SIGINT", () => shutdown("SIGINT"))
process.once("SIGTERM", () => shutdown("SIGTERM"))
