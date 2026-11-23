import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { parseUnits, Wallet } from 'ethers'
import { openDemo } from '../server/demo.ts'
import { openChain } from '../server/chain.ts'
import { amountUnits, evaluate, makePermit, permitFields } from '../shared/permit.ts'
import { issuerLabel } from '../shared/model.ts'
import type { Scenario } from '../shared/model.ts'

mkdirSync('.runtime', { recursive: true })
const sandbox = (prefix: string) => mkdtempSync(resolve('.runtime', prefix))
const origin = 'http://127.0.0.1:4174'
const units = (amount: string) => parseUnits(amount, 18).toString()
const expectation = (id: string) => ({ id, issuer: issuerLabel, amount: '5000' })

test('Сеть: строгая проверка полей, реальные Permit и burn, уже исполненный ID', async () => {
  const owner = Wallet.createRandom()
  const issuer = Wallet.createRandom()
  const chain = await openChain(sandbox('evm-'), owner.address, { chainId: 46261, issuerKey: issuer.privateKey })
  try {
    const facts = await chain.facts()
    const value = BigInt(units('5000'))
    const permit = makePermit(facts, value)
    assert.deepEqual(evaluate(permit, facts, value).errors, [])

    for (const [permitPatch, domainPatch, wanted] of [
      [{ value: units('50000') }, {}, /сумма разрешения/i],
      [{ spender: Wallet.createRandom().address }, {}, /получатель разрешения/i],
      [{}, { chainId: '1' }, /сеть/i],
      [{}, { verifyingContract: Wallet.createRandom().address }, /контракт токена/i],
      [{}, { version: '2' }, /версия домена/i],
      [{ owner: Wallet.createRandom().address }, {}, /другой владелец/i],
      [{ nonce: '1' }, {}, /nonce/i],
      [{ deadline: String(facts.time - 1n) }, {}, /истёк/i],
      [{ deadline: String(facts.time + 601n) }, {}, /10 минут/i],
      [{ value: '0' }, {}, /больше нуля/i],
      [{ value: units('60001') }, {}, /превышает баланс/i],
    ] as const) {
      const candidate = { ...permit, message: { ...permit.message, ...permitPatch }, domain: { ...permit.domain, ...domainPatch } }
      assert.match(evaluate(candidate, facts, value).errors.join(' '), wanted)
    }
    assert.throws(() => evaluate({ ...permit, primaryType: 'Approve' }, facts, value), /структур/)
    assert.throws(() => evaluate({ ...permit, message: { ...permit.message, memo: 'other' } }, facts, value), /структур/)
    assert.throws(() => evaluate({ ...permit, message: { ...permit.message, value: '-1' } }, facts, value), /целое число/)
    assert.throws(() => evaluate({ ...permit, message: { ...permit.message, value: 5e21 } }, facts, value), /целое число/)
    assert.deepEqual(evaluate(permit, { ...facts, domainSeparator: '0x' }, value).errors,
      ['Хеш домена отличается от значения в контракте.'])
    for (const bad of ['0', '-1', '1.001', '1e3', '', '1,', '1.005', ' 1']) {
      assert.throws(() => amountUnits(bad, 2))
    }
    assert.equal(amountUnits('0,01', 2), 1n)
    assert.equal(amountUnits('0.000000000000000001', 18), 1n)

    const signature = await owner.signTypedData(permit.domain, { Permit: permitFields }, permit.message)
    assert.deepEqual(await chain.balances(), { balance: units('60000'), supply: units('60000'), allowance: '0', decimals: 18 })
    const approval = await chain.prepare(chain.approvalData(permit, signature), chain.domain.verifyingContract)
    const approvalReceipt = await chain.receipt(approval.raw, approval.hash)
    assert(approvalReceipt)
    assert(chain.hasEvent(approvalReceipt, chain.token, 'Approval', [owner.address, chain.spender, String(value)]))
    assert.equal((await chain.balances()).balance, units('60000'))
    assert.equal((await chain.balances()).allowance, units('5000'))
    assert.match(evaluate(permit, await chain.facts(), value).errors.join(' '), /nonce/i)
    await chain.rpc.send('evm_increaseTime', [601])
    await chain.rpc.send('evm_mine', [])
    assert((await chain.facts()).time > BigInt(permit.message.deadline))
    assert.equal((await chain.balances()).allowance, units('5000'))

    const request = '0x' + '11'.repeat(32)
    const burnData = chain.module.interface.encodeFunctionData('redeem', [request, owner.address, value])
    await assert.rejects(chain.rpc.call({ from: owner.address, to: chain.spender, data: burnData }))
    const burn = await chain.prepare(burnData, chain.spender)
    const burnReceipt = await chain.receipt(burn.raw, burn.hash)
    assert(burnReceipt)
    assert(chain.hasEvent(burnReceipt, chain.module, 'Redeemed', [request, owner.address, String(value)]))
    assert.equal(await chain.module.redeemed(request), true)
    const repeat = await chain.prepare(burnData, chain.spender)
    assert.equal((await chain.receipt(repeat.raw, repeat.hash))?.status, 0)
    assert.deepEqual(await chain.balances(), { balance: units('55000'), supply: units('55000'), allowance: '0', decimals: 18 })
  } finally {
    await chain.close()
  }
})

test('Восстановление сохранённого хеша до отправки и после сжигания', async () => {
  const root = sandbox('recovery-')
  let demo = await openDemo(root, origin)
  let open = true
  try {
    await demo.create('5000', 'success')
    const state = await demo.state()
    const row = state.request!
    const expected = expectation(row.id)
    const review = await demo.review(expected)
    await demo.sign({ ...expected, confirmation: review.confirmation })
    await demo.close()
    open = false

    const directory = join(root, state.generation)
    const config = JSON.parse(readFileSync(join(directory, 'deployment.json'), 'utf8'))
    const db = new DatabaseSync(join(directory, 'demo.sqlite'))
    const read = db.prepare('SELECT permit, signature FROM requests WHERE id = ?')
    const setPending = db.prepare('UPDATE requests SET stage = ? WHERE id = ?')
    const insertTx = db.prepare('INSERT INTO transactions VALUES (?, ?, ?, ?)')
    const chain = await openChain(directory, row.owner, config)
    try {
      const signed = read.get(row.id)!
      const data = chain.approvalData(JSON.parse(String(signed.permit)), String(signed.signature))
      const approval = await chain.prepare(data, chain.domain.verifyingContract)
      insertTx.run(row.id, 'permit', approval.hash, approval.raw)
      setPending.run('permitPending', row.id)
    } finally {
      await chain.close()
      db.close()
    }
    demo = await openDemo(root, origin)
    open = true
    const allowed = await demo.state()
    assert.equal(allowed.request?.stage, 'allowed')
    assert.equal(allowed.allowance, units('5000'))
    await demo.close()
    open = false

    const chainAfter = await openChain(directory, row.owner, config)
    const dbAfter = new DatabaseSync(join(directory, 'demo.sqlite'))
    try {
      const data = chainAfter.module.interface.encodeFunctionData('redeem', [row.id, row.owner, row.units])
      const burn = await chainAfter.prepare(data, chainAfter.spender)
      dbAfter.prepare('INSERT INTO transactions VALUES (?, ?, ?, ?)').run(row.id, 'burn', burn.hash, burn.raw)
      dbAfter.prepare('UPDATE requests SET stage = ? WHERE id = ?').run('burnPending', row.id)
      assert.equal((await chainAfter.receipt(burn.raw, burn.hash))?.status, 1)
    } finally {
      await chainAfter.close()
      dbAfter.close()
    }
    demo = await openDemo(root, origin)
    open = true
    const recovered = await demo.state()
    assert.equal(recovered.request?.stage, 'burned')
    assert.equal(recovered.allowance, '0')
    assert.equal(recovered.balance, units('55000'))
    assert.equal(recovered.debt, 500_000)
    assert.equal(recovered.confirmed, 0)
    assert.equal((await demo.state()).journal.filter(event => event.text.startsWith('Сжигание подтверждено')).length, 1)
  } finally {
    if (open) await demo.close()
  }
})

test('Стенд: обязательные прогоны, восстановление, фактические проводки и чистый сброс', async t => {
  const path = sandbox('flows-')
  let demo = await openDemo(path, origin)
  async function restart() {
    await demo.close()
    demo = await openDemo(path, origin)
  }
  async function reset() {
    const before = await demo.state()
    await demo.reset(before.generation)
    const state = await demo.state()
    assert.notEqual(state.generation, before.generation)
    assert.notEqual(state.owner, before.owner)
    assert.equal(state.balance, units('60000'))
    assert.equal(state.supply, units('60000'))
    assert.equal(state.allowance, '0')
    assert.equal(state.debt, 0)
    assert.equal(state.bankClient, 0)
    assert.equal(state.bankIssuer, 10_000_000)
    assert.equal(state.request, null)
  }
  async function create(scenario: Scenario) {
    await demo.create('5000', scenario)
    const row = (await demo.state()).request
    assert(row)
    return row.id
  }
  async function approve(id: string) {
    const data = expectation(id)
    const review = await demo.review(data)
    assert(review.confirmation)
    await demo.sign({ ...data, confirmation: review.confirmation })
    assert.equal((await demo.state()).request?.stage, 'signed')
    assert.equal((await demo.state()).allowance, '0')
    await demo.transact(id, 'permit')
    const state = await demo.state()
    assert.equal(state.balance, units('60000'))
    assert.equal(state.supply, units('60000'))
    assert.equal(state.allowance, units('5000'))
    assert.equal(state.request?.stage, 'allowed')
  }
  async function burn(id: string) {
    await demo.transact(id, 'burn')
    const state = await demo.state()
    assert.equal(state.request?.stage, 'burned')
    assert.equal(state.balance, units('55000'))
    assert.equal(state.supply, units('55000'))
    assert.equal(state.allowance, '0')
    assert.equal(state.debt, 500_000)
    assert.equal(state.confirmed, 0)
    assert.equal(state.journal.filter(event => event.text.startsWith('Сжигание подтверждено')).length, 1)
  }
  function movement(generation: string) {
    const db = new DatabaseSync(join(path, generation, 'demo.sqlite'), { readOnly: true })
    try {
      const result = db.prepare('SELECT COUNT(*) AS count, SUM(kopecks) AS amount FROM transfers').get()
      return { count: result?.count, amount: result?.amount }
    } finally {
      db.close()
    }
  }
  async function paid() {
    const state = await demo.state()
    assert.equal(state.request?.stage, 'paid')
    assert.equal(state.balance, units('55000'))
    assert.equal(state.debt, 0)
    assert.equal(state.confirmed, 500_000)
    assert.equal(state.bankIssuer, 9_500_000)
    assert.equal(state.bankClient, 500_000)
    assert.deepEqual(movement(state.generation), { count: 1, amount: 500_000 })
  }

  try {
    await t.test('Успех, повторные действия и перезапуск при установленном разрешении', async () => {
      for (const invalid of ['0', '-1', '0.001', '60000.01']) await assert.rejects(demo.create(invalid, 'success'))
      const id = await create('success')
      await demo.create('7000', 'success')
      assert.equal((await demo.state()).request?.id, id)
      demo.pay(id, null)
      assert.equal((await demo.state()).attempts.length, 0)
      await approve(id)
      await restart()
      assert.equal((await demo.state()).allowance, units('5000'))
      await burn(id)
      await demo.transact(id, 'burn')
      demo.pay(id, null)
      demo.pay(id, null)
      await paid()
    })
    for (const scenario of ['wrongAmount', 'wrongSpender'] as const) {
      await t.test(scenario, async () => {
        await reset()
        const id = await create(scenario)
        const data = expectation(id)
        const review = await demo.review(data)
        assert.equal(review.confirmation, null)
        assert.match(review.errors.join(' '), scenario === 'wrongAmount' ? /сумма/i : /получатель/i)
        assert.equal(review.received, units(scenario === 'wrongAmount' ? '50000' : '5000'))
        await assert.rejects(demo.sign({ ...data, confirmation: 'подмена' }))
        await demo.transact(id, 'permit')
        const state = await demo.state()
        assert.equal(state.balance, units('60000'))
        assert.equal(state.allowance, '0')
        assert.equal(state.confirmed, 0)
        assert.equal(state.debt, 0)
        assert.equal(state.attempts.length, 0)
      })
    }
    await t.test('Отказ банка и повтор только после подтверждённого отказа', async () => {
      await reset()
      const id = await create('refused')
      await approve(id)
      await burn(id)
      demo.pay(id, null)
      demo.pay(id, null)
      const state = await demo.state()
      assert.equal(state.request?.stage, 'refused')
      assert.equal(state.debt, 500_000)
      assert.equal(state.attempts.length, 1)
      assert.deepEqual(movement(state.generation), { count: 0, amount: null })
      demo.pay(id, state.attempts[0].id)
      demo.pay(id, state.attempts[0].id)
      await paid()
      assert.equal((await demo.state()).attempts.length, 2)
    })
    await t.test('Банк провёл платёж, ответ потерян, сервер перезапущен', async () => {
      await reset()
      const id = await create('lost')
      await approve(id)
      await burn(id)
      demo.pay(id, null)
      await restart()
      const state = await demo.state()
      assert.equal(state.request?.stage, 'unknown')
      assert.equal(state.debt, 500_000)
      assert.equal(state.confirmed, 0)
      assert.deepEqual(movement(state.generation), { count: 1, amount: 500_000 })
      demo.pay(id, state.attempts[0].id)
      assert.throws(() => demo.reconcile(id, 'другой перевод'))
      demo.reconcile(id, state.attempts[0].id)
      demo.reconcile(id, state.attempts[0].id)
      await paid()
      assert.equal((await demo.state()).attempts.length, 1)
    })
    await t.test('Оба исхода блокировки KYT на сервере', async () => {
      for (const verdict of ['review', 'denied'] as const) {
        await reset()
        const id = await create(verdict)
        await assert.rejects(demo.review(expectation(id)))
        await assert.rejects(demo.transact(id, 'permit'), /KYT/)
        await assert.rejects(demo.transact(id, 'burn'), /KYT/)
        demo.pay(id, null)
        const state = await demo.state()
        assert.equal(state.balance, units('60000'))
        assert.equal(state.allowance, '0')
        assert.equal(state.debt, 0)
        assert.deepEqual(movement(state.generation), { count: 0, amount: null })
      }
    })
    await t.test('Отмена, подмена подтверждения и сброс с действующим allowance', async () => {
      await reset()
      const id = await create('success')
      const review = await demo.review(expectation(id))
      await assert.rejects(demo.sign({ ...expectation(id), amount: '5001', confirmation: review.confirmation }))
      const checked = await demo.review(expectation(id))
      demo.cancel(id)
      await assert.rejects(demo.sign({ ...expectation(id), confirmation: checked.confirmation }))
      assert.equal((await demo.state()).request?.stage, 'cancelled')
      const next = await create('success')
      await approve(next)
      await reset()
      await assert.rejects(demo.transact(next, 'burn'))
      assert.throws(() => demo.walletView(next))
      await restart()
      assert.equal((await demo.state()).allowance, '0')
    })
  } finally {
    await demo.close()
  }
})
