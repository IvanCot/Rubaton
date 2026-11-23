import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { openDemo } from './demo.ts'

const host = '127.0.0.1'
const portalPort = Number(process.env.RUBA_PORT ?? 4173)
const walletPort = Number(process.env.RUBA_WALLET_PORT ?? 4174)
const portalOrigin = 'http://' + host + ':' + portalPort
const walletOrigin = 'http://' + host + ':' + walletPort
const assets = resolve('dist')
await stat(resolve(assets, 'index.html'))
const demo = await openDemo(resolve(process.env.RUBA_RUNTIME ?? '.runtime'), walletOrigin)

let pending: Promise<unknown> = Promise.resolve()
function serialized<T>(action: () => Promise<T>) {
  const result = pending.then(action)
  pending = result.catch(() => undefined)
  return result
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of req) {
    body += chunk.toString()
    if (body.length > 8192) throw new Error('Запрос слишком длинный.')
  }
  const data: unknown = JSON.parse(body)
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Ожидается объект JSON.')
  return data as Record<string, unknown>
}

const walletActions = {
  '/api/review': (b: Record<string, unknown>) => demo.review(b),
  '/api/sign': async (b: Record<string, unknown>) => { await demo.sign(b); return { ok: true } },
  '/api/cancel': async (b: Record<string, unknown>) => { demo.cancel(b.id); return { ok: true } },
}

const portalActions = {
  '/api/create': (b: Record<string, unknown>) => demo.create(b.amount, b.scenario),
  '/api/permit': (b: Record<string, unknown>) => demo.transact(b.id, 'permit'),
  '/api/burn': (b: Record<string, unknown>) => demo.transact(b.id, 'burn'),
  '/api/pay': (b: Record<string, unknown>) => demo.pay(b.id, b.previous),
  '/api/reconcile': (b: Record<string, unknown>) => demo.reconcile(b.id, b.attempt),
  '/api/cancel': (b: Record<string, unknown>) => demo.cancel(b.id),
  '/api/renew': (b: Record<string, unknown>) => demo.renew(b.id),
  '/api/reset': (b: Record<string, unknown>) => demo.reset(b.generation),
}

function listener(origin: string, wallet: boolean) {
  return createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: 'Недоверенный адрес сервиса.' })
    const url = new URL(req.url ?? '/', origin)
    const path = url.pathname
    try {
      if (path.startsWith('/api/')) {
        if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin' &&
            req.headers['sec-fetch-site'] !== 'none') return json(res, 403, { error: 'Недоверенный источник.' })
        if (req.method === 'GET') {
          if (!wallet && path === '/api/state') return json(res, 200, await serialized(() => demo.state()))
          if (wallet && path === '/api/request') {
            return json(res, 200, await serialized(async () => demo.walletView(url.searchParams.get('id'))))
          }
        }
        if (req.method === 'POST') {
          if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') {
            return json(res, 403, { error: 'Недоверенный источник.' })
          }
          const actions: Record<string, (body: Record<string, unknown>) => unknown> = wallet ? walletActions : portalActions
          if (Object.hasOwn(actions, path)) {
            const body = await readBody(req)
            const result = await serialized(async () => {
              const output = await actions[path](body)
              return wallet ? output : demo.state()
            })
            return json(res, 200, result)
          }
        }
        return json(res, 404, { error: 'Такого действия нет.' })
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Метод недоступен.' })
      if (path === '/favicon.ico') { res.writeHead(204).end(); return }
      if (!['/', '/operator', '/wallet'].includes(path) && !/^\/assets\/[\w.-]+\.(css|js|webp)$/.test(path)) {
        return json(res, 404, { error: 'Страница не найдена.' })
      }
      const file = path.startsWith('/assets/') ? resolve(assets, '.' + path) : resolve(assets, 'index.html')
      const content = await readFile(file)
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.webp': 'image/webp',
      }
      res.writeHead(200, { 'Content-Type': mime[extname(file)], 'Cache-Control': 'no-store' })
      res.end(content)
    } catch (error) {
      // В ответе не передаём вложенные ошибки RPC с транзакциями или пути к файлам.
      const message = error instanceof Error && /^[А-Яа-яЁё]/.test(error.message)
        ? error.message : 'Операция не завершилась. Обновите состояние стенда и повторите проверку.'
      json(res, 409, { error: message })
    }
  })
}

const servers = [listener(portalOrigin, false), listener(walletOrigin, true)]
async function stop() {
  await Promise.all(servers.map(server => new Promise<void>(done => server.close(() => done()))))
  await pending
  await demo.close()
}
try {
  await Promise.all(servers.map((server, i) => new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(i === 0 ? portalPort : walletPort, host, done)
  })))
  console.log('Портал      ' + portalOrigin)
  console.log('Оператор    ' + portalOrigin + '/operator')
  console.log('Кошелёк     ' + walletOrigin + '/wallet')
} catch (error) {
  await stop()
  throw error
}

function shutdown() {
  void stop().then(() => process.exit(0), () => process.exit(1))
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
