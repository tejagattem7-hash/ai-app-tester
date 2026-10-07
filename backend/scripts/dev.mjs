import { spawn } from "node:child_process"
import { createConnection, createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const children = []
let stopping = false

function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode
  for (const child of children) child.kill()
}

function start(name, args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" })
  children.push(child)
  child.on("error", (error) => {
    console.error(`${name} could not start:`, error)
    stop(1)
  })
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${name} stopped (${signal ?? code}); stopping the other dev server.`)
      stop(code || 1)
    }
  })
}

process.on("SIGINT", () => stop())
process.on("SIGTERM", () => stop())

function apiPortAvailable(port) {
  const canConnect = (host) => new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false) })
    socket.once("connect", () => { socket.destroy(); resolve(true) })
    socket.once("error", (error) => {
      if (["ECONNREFUSED", "EADDRNOTAVAIL", "ENETUNREACH"].includes(error.code)) resolve(false)
      else reject(error)
    })
  })
  return Promise.all([canConnect("127.0.0.1"), canConnect("::1")]).then((occupied) => {
    if (occupied.some(Boolean)) throw Object.assign(new Error("API port occupied"), { code: "EADDRINUSE" })
    return new Promise((resolve, reject) => {
      const server = createServer()
      server.once("error", reject)
      server.listen(port, "0.0.0.0", () => server.close((error) => error ? reject(error) : resolve()))
    })
  })
}

const port = Number(process.env.PORT ?? "3001")
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("PORT must be an integer between 1 and 65535.")
  process.exitCode = 1
} else {
  try {
    await apiPortAvailable(port)
    start("API", ["--env-file-if-exists=.env", "--import", "tsx", "--watch", "backend/src/index.ts"])
    start("UI", [path.join(root, "node_modules/vite/bin/vite.js"), "--strictPort", ...process.argv.slice(2)])
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      console.error(`API port ${port} is already in use. Stop the other backend server, then run npm run dev again.`)
    } else {
      console.error(`Could not check API port ${port}:`, error)
    }
    process.exitCode = 1
  }
}
