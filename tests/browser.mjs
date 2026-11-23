import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { chromium } from 'playwright'

mkdirSync('.runtime', { recursive: true })
const runtime = mkdtempSync(resolve('.runtime', 'browser-'))
const portal = 'http://127.0.0.1:44273'
const walletOrigin = 'http://127.0.0.1:44274'
const server = spawn(process.execPath, ['server/main.ts'], {
  env: { ...process.env, RUBA_PORT: '44273', RUBA_WALLET_PORT: '44274', RUBA_RUNTIME: runtime },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
server.stdout.on('data', data => { logs += data.toString() })
server.stderr.on('data', data => { logs += data.toString() })
let browser
const errors = []

try {
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      if ((await fetch(portal + '/api/state')).ok) break
    } catch {}
    if (server.exitCode !== null || Date.now() > deadline) throw new Error('Стенд не запустился. ' + logs)
    await setTimeout(200)
  }

  const executablePath = [
    process.env.RUBA_BROWSER_EXE,
    join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  ].find(path => path && existsSync(path))
  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
  const expectedOrigins = new Set([portal, walletOrigin])
  await context.route('**/*', async route => {
    if (expectedOrigins.has(new URL(route.request().url()).origin)) await route.continue()
    else {
      errors.push('Внешний запрос: ' + route.request().url())
      await route.abort()
    }
  })
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('requestfailed', request => errors.push(request.url() + ' ' + request.failure()?.errorText))
  })
  const client = await context.newPage()
  const operator = await context.newPage()
  await client.goto(portal)
  await operator.goto(portal + '/operator')
  await client.getByText('60 000 RUBA', { exact: true }).waitFor()
  assert(await client.locator('.wordmark img').evaluate(async img => {
    await img.decode()
    return img.naturalWidth > 0
  }))
  assert.equal(await client.getByLabel('Следующая заявка').isVisible(), false)
  await client.getByLabel('Сумма погашения').fill('0')
  await client.getByRole('button', { name: 'Создать заявку' }).click()
  await client.getByRole('alert').getByText('Сумма должна быть больше нуля.').waitFor()
  assert.equal(await client.getByLabel('Сумма погашения').getAttribute('aria-invalid'), 'true')
  await client.getByLabel('Сумма погашения').fill('5000')
  await client.getByLabel('Сумма погашения').blur()
  await client.bringToFront()
  await client.screenshot({ path: join(runtime, 'form.png') })
  await client.setViewportSize({ width: 375, height: 812 })
  assert(await client.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await client.screenshot({ path: join(runtime, 'form-mobile.png') })
  await client.setViewportSize({ width: 1366, height: 900 })
  await client.getByRole('button', { name: 'Создать заявку' }).click()
  await client.getByText('Ожидается подпись', { exact: true }).waitFor()
  await client.screenshot({ path: join(runtime, 'client.png'), fullPage: true })

  async function openWallet(amount = '5000') {
    const popup = client.waitForEvent('popup')
    await client.getByRole('link', { name: /Открыть кошелёк/ }).click()
    const wallet = await popup
    await wallet.getByLabel('Ожидаемая сумма').waitFor()
    assert.equal(new URL(wallet.url()).origin, walletOrigin)
    assert.equal(await wallet.getByLabel('Ожидаемая сумма').inputValue(), '')
    await wallet.getByLabel('Ожидаемая сумма').fill(amount)
    await wallet.getByLabel('Эмитент', { exact: true }).selectOption({ label: 'Эмитент «Демо»' })
    await wallet.getByRole('button', { name: 'Проверить разрешение' }).click()
    return wallet
  }

  const wallet = await openWallet()
  await wallet.getByRole('heading', { name: 'Разрешение совпадает' }).waitFor()
  assert(await wallet.locator('.security-art').evaluate(async img => {
    await img.decode()
    return img.naturalWidth > 0
  }))
  assert.equal(await wallet.getByRole('table', { name: 'Сверка запроса' }).getByRole('row').count(), 5)
  await wallet.screenshot({ path: join(runtime, 'wallet.png'), fullPage: true })
  await wallet.getByLabel('Ожидаемая сумма').fill('5001')
  assert.equal(await wallet.getByRole('button', { name: 'Подтвердить и подписать' }).count(), 0)
  await wallet.getByLabel('Ожидаемая сумма').fill('5000')
  await wallet.getByRole('button', { name: 'Проверить разрешение' }).click()
  await wallet.getByRole('button', { name: 'Подтвердить и подписать' }).click()
  await wallet.getByText('Подпись передана эмитенту.', { exact: false }).waitFor()
  await operator.getByRole('button', { name: 'Применить Permit' }).click()
  await operator.getByText('Разрешение установлено', { exact: true }).waitFor()
  const state = async () => (await fetch(portal + '/api/state')).json()
  assert.equal((await state()).allowance, '5000000000000000000000')
  assert.equal((await state()).balance, '60000000000000000000000')
  await operator.getByRole('button', { name: 'Сжечь токены' }).click()
  await operator.getByRole('button', { name: 'Отправить выплату' }).click()
  await operator.getByText('Выплата подтверждена', { exact: true }).waitFor()
  const paid = await state()
  assert.equal(paid.balance, '55000000000000000000000')
  assert.equal(paid.allowance, '0')
  assert.equal(paid.confirmed, 500000)
  assert.equal(paid.debt, 0)
  await wallet.close()
  await operator.bringToFront()
  await operator.screenshot({ path: join(runtime, 'operator.png') })
  console.log('Проверено штатное погашение.')

  async function reset() {
    const panel = client.locator('.demo-tools')
    if (!await panel.evaluate(node => node.open)) await panel.locator('summary').click()
    await client.getByRole('button', { name: 'Сбросить прогон' }).click()
    await client.getByRole('button', { name: 'Подтвердить сброс' }).click()
    await client.locator('.card-head').waitFor({ state: 'hidden' })
    await client.getByRole('button', { name: 'Создать заявку' }).waitFor()
    await client.getByLabel('Следующая заявка').waitFor()
    assert.equal((await state()).allowance, '0')
  }

  async function choose(scenario) {
    await client.getByLabel('Следующая заявка').selectOption(scenario)
    await client.getByRole('button', { name: 'Создать заявку' }).click()
  }

  for (const scenario of ['wrongAmount', 'wrongSpender']) {
    await reset()
    await choose(scenario)
    const rejected = await openWallet()
    await rejected.getByRole('heading', { name: 'Подписание заблокировано' }).waitFor()
    assert.equal(await rejected.getByRole('button', { name: 'Подтвердить и подписать' }).count(), 0)
    assert.equal((await state()).balance, '60000000000000000000000')
    assert.equal((await state()).allowance, '0')
    if (scenario === 'wrongAmount') {
      await rejected.getByText('+45 000 RUBA', { exact: true }).waitFor()
      assert(await rejected.getByRole('button', { name: 'Подписать разрешение' }).isDisabled())
      await rejected.screenshot({ path: join(runtime, 'wallet-blocked.png'), fullPage: true })
    }
    if (scenario === 'wrongSpender') {
      await rejected.setViewportSize({ width: 375, height: 812 })
      const summary = rejected.getByText('Получатель в запросе', { exact: false })
      await summary.focus()
      await rejected.keyboard.press('Enter')
      assert(await summary.evaluate(node => node.parentElement.open))
      assert(await rejected.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      await rejected.screenshot({ path: join(runtime, 'mobile.png'), fullPage: true })
      await rejected.setViewportSize({ width: 812, height: 375 })
      assert(await rejected.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      await rejected.getByRole('heading', { name: 'Подписание заблокировано' }).waitFor()
    }
    await rejected.close()
    console.log('Проверена блокировка ' + scenario)
  }

  for (const scenario of ['refused', 'lost']) {
    await reset()
    await choose(scenario)
    const approved = await openWallet()
    await approved.getByRole('button', { name: 'Подтвердить и подписать' }).click()
    await approved.getByText('Подпись передана эмитенту.', { exact: false }).waitFor()
    await operator.getByRole('button', { name: 'Применить Permit' }).click()
    await operator.getByRole('button', { name: 'Сжечь токены' }).click()
    await operator.getByRole('button', { name: 'Отправить выплату' }).click()
    const recover = operator.getByRole('button', {
      name: scenario === 'lost' ? 'Сверить исходный перевод' : 'Повторить выплату',
    })
    await recover.waitFor()
    assert.equal((await state()).debt, 500000)
    await recover.click()
    await operator.getByText('Выплата подтверждена', { exact: true }).waitFor()
    assert.equal((await state()).confirmed, 500000)
    await approved.close()
    console.log('Проверено восстановление ' + scenario)
  }

  for (const scenario of ['review', 'denied']) {
    await reset()
    await choose(scenario)
    const status = scenario === 'review' ? 'KYT на проверке' : 'KYT отказал'
    await client.locator('.status').filter({ hasText: status }).waitFor()
    assert.equal(await client.getByRole('link', { name: /Открыть кошелёк/ }).count(), 0)
    assert.equal((await state()).debt, 0)
  }
  const csrf = await fetch(walletOrigin + '/api/cancel', {
    method: 'POST', headers: { Origin: portal, 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(csrf.status, 403)
  assert.deepEqual(errors, [])
  for (const page of [client, operator]) {
    await page.setViewportSize({ width: 375, height: 812 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  }
  console.log('Chromium: 7 прогонов, проверка формы, клавиатура, ширина 375 px и альбомный режим кошелька, изоляция origin. Внешних запросов и ошибок страницы нет.')
  console.log('Снимки: ' + runtime)
} finally {
  await browser?.close()
  server.kill()
}
