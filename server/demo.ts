import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatUnits, verifyTypedData, Wallet, ZeroAddress } from 'ethers'
import { amountUnits, evaluate, makePermit, permitFields } from '../shared/permit.ts'
import type { Permit } from '../shared/permit.ts'
import { issuerLabel, maskedAccount, scenarios, startingBank } from '../shared/model.ts'
import type { Scenario, State } from '../shared/model.ts'
import { openChain } from './chain.ts'
import { openStore } from './store.ts'
import { openWallet } from './wallet.ts'

type Config = { chainId: number; issuerKey: string; token?: string; module?: string }
const pointer = 'active.json'

async function generation(root: string, id: string) {
  const directory = join(root, id)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'deployment.json')
  const wallet = openWallet(directory)
  const config: Config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {
    chainId: randomInt(100_000, 1_000_000_000), issuerKey: Wallet.createRandom().privateKey,
  }
  const chain = await openChain(directory, wallet.owner, config)
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify({ ...config, token: chain.domain.verifyingContract, module: chain.spender }),
      { flag: 'wx', mode: 0o600 })
  }
  const store = openStore(directory)
  return { id, wallet, chain, store, async close() { store.db.close(); await chain.close() } }
}

export async function openDemo(root: string, walletOrigin: string) {
  mkdirSync(root, { recursive: true })
  const active = join(root, pointer)
  async function fresh() {
    const current = await generation(root, randomUUID())
    try {
      writeFileSync(active + '.tmp', JSON.stringify(current.id))
      renameSync(active + '.tmp', active)
      return current
    } catch (error) {
      await current.close()
      throw error
    }
  }

  let current: Awaited<ReturnType<typeof generation>>
  if (existsSync(active)) {
    const id: unknown = JSON.parse(readFileSync(active, 'utf8'))
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Повреждён указатель стенда.')
    current = await generation(root, id)
  } else {
    current = await fresh()
  }

  function requireRequest(id: unknown) {
    const row = current.store.latest()
    if (!row || id !== row.id) throw new Error('Откройте актуальную заявку.')
    return row
  }

  async function buildRequest(scenario: Scenario, value: bigint) {
    const { chain } = current
    const facts = await chain.facts()
    const permit = makePermit(facts, value)
    if (scenario === 'wrongAmount') permit.message.value = String(amountUnits('50000', chain.decimals))
    if (scenario === 'wrongSpender') permit.message.spender = Wallet.createRandom().address
    return JSON.stringify(permit)
  }

  async function create(input: unknown, scenarioInput: unknown) {
    const { store, chain, wallet } = current
    if (typeof scenarioInput !== 'string' || !Object.hasOwn(scenarios, scenarioInput)) {
      throw new Error('Выберите сценарий стенда.')
    }
    const existing = store.latest()
    if (existing && !['paid', 'denied', 'cancelled'].includes(existing.stage)) return
    const scenario = scenarioInput as Scenario
    const kopecks = Number(amountUnits(input, 2))
    const amount = formatUnits(BigInt(kopecks), 2)
    const value = amountUnits(amount, chain.decimals)
    if (value > (await chain.facts()).balance) throw new Error('Сумма превышает баланс кошелька.')
    const id = '0x' + randomBytes(32).toString('hex')
    const kyt = scenario === 'denied' ? 'denied' : scenario === 'review' ? 'review' : 'approved'
    const stage = kyt === 'approved' ? 'ready' : kyt === 'review' ? 'pending' : 'denied'
    const permit = kyt === 'approved' ? await buildRequest(scenario, value) : null
    store.atomic(() => {
      store.db.prepare(`
        INSERT INTO requests (id, owner, issuer, account, amount, units, kopecks, scenario, stage, kyt, permit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, wallet.owner, issuerLabel, maskedAccount, amount, String(value), kopecks, scenario, stage, kyt, permit)
      store.log(id, 'Клиент', 'Подал заявку на погашение')
      store.log(id, 'Эмитент', 'KYC пройден при подключении клиента')
      store.log(id, 'Эмитент', kyt === 'approved' ? 'KYT одобрен' : kyt === 'review' ? 'KYT на проверке' : 'KYT отказал')
    })
  }

  function walletRequest(id: unknown) {
    const row = requireRequest(id)
    if (row.stage !== 'ready' || row.kyt !== 'approved' || !row.permit) {
      throw new Error('Заявка сейчас недоступна для подписи.')
    }
    return { ...row, permit: row.permit }
  }

  async function review(body: Record<string, unknown>) {
    const row = walletRequest(body.id)
    return current.wallet.review(row.id, row.permit, body.amount, body.issuer, await current.chain.facts())
  }

  async function sign(body: Record<string, unknown>) {
    const row = walletRequest(body.id)
    const { wallet, store, chain } = current
    const { signature } = await wallet.sign(row.id, row.permit, body.amount, body.issuer, body.confirmation,
      await chain.facts())
    store.atomic(() => {
      store.db.prepare('UPDATE requests SET signature = ? WHERE id = ?').run(signature, row.id)
      store.update(row.id, 'signed', 'Кошелёк', 'Клиент подтвердил Permit. Подпись создана вне сети.')
    })
  }

  async function recover() {
    const { store, chain } = current
    const row = store.latest()
    if (!row || (row.stage !== 'permitPending' && row.stage !== 'burnPending')) return
    const kind = row.stage === 'permitPending' ? 'permit' : 'burn'
    const tx = store.tx(row.id, kind)
    if (!tx) throw new Error('Нет записи отправленной транзакции.')
    const receipt = await chain.receipt(tx.raw, tx.hash)
    if (!receipt) return
    if (receipt.status !== 1) {
      store.atomic(() => {
        store.db.prepare('DELETE FROM transactions WHERE request_id = ? AND kind = ?').run(row.id, kind)
        store.update(row.id, kind === 'permit' ? 'permitFailed' : 'allowed',
          'Сеть', 'Транзакция отклонена. Средства по ней не списаны.', tx.hash)
      })
      return
    }
    const actual = await chain.balances()
    if (kind === 'permit') {
      if (actual.allowance !== row.units ||
          !chain.hasEvent(receipt, chain.token, 'Approval', [row.owner, chain.spender, row.units])) {
        throw new Error('Квитанция и фактическое разрешение расходятся.')
      }
      store.atomic(() => store.update(row.id, 'allowed', 'Сеть', 'Permit применён. Разрешение установлено.', tx.hash))
      return
    }
    if (actual.allowance !== '0' || !await chain.module.redeemed(row.id) ||
        !chain.hasEvent(receipt, chain.module, 'Redeemed', [row.id, row.owner, row.units]) ||
        !chain.hasEvent(receipt, chain.token, 'Transfer', [row.owner, ZeroAddress, row.units])) {
      throw new Error('Квитанция не подтверждает ожидаемое сжигание.')
    }
    store.atomic(() => {
      store.db.prepare('UPDATE requests SET debtId = ? WHERE id = ?').run('debt-' + row.id.slice(2), row.id)
      store.update(row.id, 'burned', 'Сеть', 'Сжигание подтверждено. Эмитент должен перечислить рубли.', tx.hash)
    })
  }

  async function transact(id: unknown, kind: 'permit' | 'burn') {
    await recover()
    const row = requireRequest(id)
    const { chain, store } = current
    if (row.kyt !== 'approved') throw new Error('Эмитент может исполнить только заявку с одобренным KYT.')
    if (kind === 'permit' && row.stage !== 'signed' || kind === 'burn' && row.stage !== 'allowed') return
    const balances = await chain.balances()
    let data: string
    let to: string
    if (kind === 'permit') {
      if (!row.permit || !row.signature || balances.allowance !== '0') throw new Error('Нужна подпись и нулевое разрешение.')
      const permit: Permit = JSON.parse(row.permit)
      const { errors } = evaluate(permit, await chain.facts(), BigInt(row.units))
      if (errors.length) {
        store.atomic(() => store.update(row.id, 'permitFailed', 'Эмитент', errors.join(' ')))
        return
      }
      if (verifyTypedData(permit.domain, { Permit: permitFields }, permit.message, row.signature) !== row.owner) {
        throw new Error('Подпись не принадлежит клиенту заявки.')
      }
      data = chain.approvalData(permit, row.signature)
      to = chain.domain.verifyingContract
    } else {
      if (balances.allowance !== row.units || await chain.module.redeemed(row.id)) {
        throw new Error('Заявку нельзя сжечь при текущем состоянии сети.')
      }
      data = chain.module.interface.encodeFunctionData('redeem', [row.id, row.owner, row.units])
      to = chain.spender
    }
    const tx = await chain.prepare(data, to)
    store.atomic(() => {
      store.db.prepare('INSERT INTO transactions VALUES (?, ?, ?, ?)').run(row.id, kind, tx.hash, tx.raw)
      store.update(row.id, kind === 'permit' ? 'permitPending' : 'burnPending', 'Эмитент',
        kind === 'permit' ? 'Отправляет Permit в сеть' : 'Отправляет распоряжение на сжигание', tx.hash)
    })
    await recover()
  }

  function pay(id: unknown, previous: unknown) {
    const row = requireRequest(id)
    const { store } = current
    if (!row.debtId || !['burned', 'refused'].includes(row.stage)) return
    store.atomic(() => {
      const last = store.attempts(row.id).at(-1)
      if ((last?.id ?? null) !== previous) return
      const attempt = 'pay-' + randomUUID()
      const result = (!last && row.scenario === 'refused') || startingBank - store.sum(false) < row.kopecks
        ? 'refused' : 'paid'
      const observed = result === 'paid' && !last && row.scenario === 'lost' ? 'unknown' : result
      store.db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?)').run(attempt, row.id, observed, result)
      if (result === 'paid') {
        store.db.prepare('INSERT INTO transfers VALUES (?, ?, ?)').run(row.debtId, attempt, row.kopecks)
      }
      store.log(row.id, 'Эмитент', 'Передал банку распоряжение', attempt)
      store.update(row.id, observed, 'Банк',
        observed === 'paid' ? 'Подтвердил зачисление' :
          observed === 'refused' ? 'Отказал до списания' : 'Ответ не получен', attempt)
    })
  }

  function reconcile(id: unknown, attempt: unknown) {
    const row = requireRequest(id)
    const { store } = current
    if (row.stage !== 'unknown') return
    const last = store.attempts(row.id).at(-1)
    if (!last || last.id !== attempt) throw new Error('Сверьте исходную попытку выплаты.')
    store.atomic(() => {
      store.db.prepare('UPDATE attempts SET status = result WHERE id = ?').run(last.id)
      store.update(row.id, last.result, 'Банк', 'Подтвердил итог исходной попытки', last.id)
    })
  }

  async function renew(id: unknown) {
    const row = requireRequest(id)
    if (row.stage !== 'ready' && row.stage !== 'permitFailed') return
    const { store } = current
    const permit = await buildRequest(row.scenario, BigInt(row.units))
    current.wallet.clear(row.id)
    store.atomic(() => {
      store.db.prepare('UPDATE requests SET permit = ?, signature = NULL WHERE id = ?').run(permit, row.id)
      store.update(row.id, 'ready', 'Эмитент', 'Выпустил новый запрос Permit')
    })
  }

  function cancel(id: unknown) {
    const row = requireRequest(id)
    if (!['ready', 'pending'].includes(row.stage)) throw new Error('Эту заявку уже нельзя отменить до подписи.')
    const { store } = current
    current.wallet.clear(row.id)
    store.atomic(() => store.update(row.id, 'cancelled', 'Клиент', 'Отменил заявку до подписи'))
  }

  async function state(): Promise<State> {
    await recover()
    const { chain, wallet, store } = current
    const row = store.latest()
    const balance = await chain.balances()
    const confirmed = store.sum(true)
    const debt = row?.debtId && row.stage !== 'paid' ? row.kopecks : 0
    if (!row) return {
      generation: current.id, chainId: Number(chain.domain.chainId), walletOrigin, owner: wallet.owner,
      spender: chain.spender, ...balance, confirmed, debt, bankClient: confirmed, bankIssuer: startingBank - confirmed,
      request: null, journal: [], attempts: [],
    }
    const { permit: _permit, signature: _signature, ...request } = row
    return {
      generation: current.id, chainId: Number(chain.domain.chainId), walletOrigin, owner: wallet.owner,
      spender: chain.spender, ...balance, confirmed, debt, bankClient: confirmed, bankIssuer: startingBank - confirmed,
      request, journal: store.journal(row.id), attempts: store.attempts(row.id).map(({ id, status }) => ({ id, status })),
    }
  }

  return {
    state, create, review, sign, transact, pay, reconcile, cancel, renew,
    walletView(id: unknown) {
      const row = walletRequest(id)
      const { chain, wallet } = current
      return { id: row.id, owner: wallet.owner, issuer: issuerLabel, permit: JSON.parse(row.permit) as Permit,
        spender: chain.spender, token: chain.domain.verifyingContract,
        chainId: chain.domain.chainId, decimals: chain.decimals }
    },
    async reset(id: unknown) {
      if (id !== current.id) return
      const previous = current
      current = await fresh()
      await previous.close()
    },
    close: () => current.close(),
  }
}

export type Demo = Awaited<ReturnType<typeof openDemo>>
