import { app } from "./app.js"

const parsedPort = Number.parseInt(process.env.PORT ?? "3001", 10)
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65_535 ? parsedPort : 3001

app.listen(port, () => {
  console.log(`AI App Tester API listening on http://localhost:${port}`)
})
