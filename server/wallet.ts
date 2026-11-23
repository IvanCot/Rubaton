import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { amountUnits, evaluate, permitFields } from '../shared/permit.ts'
import type { ChainFacts, Permit } from '../shared/permit.ts'
import { issuerLabel } from '../shared/model.ts'
import { createHash } from 'node:crypto'

export function openWallet(directory: string) {
  const path = join(directory, 'wallet.key')
  if (!existsSync(path)) writeFileSync(path, Wallet.createRandom().privateKey, { flag: 'wx', mode: 0o600 })
  const wallet = new Wallet(readFileSync(path, 'utf8'))
  const confirmations = new Map<string, string>()

  function inspect(id: string, serialized: string, input: unknown, issuer: unknown, facts: ChainFacts) {
    if (issuer !== issuerLabel) throw new Error('Выберите эмитента в кошельке.')
    const expected = amountUnits(input, facts.decimals)
    const checked = evaluate(JSON.parse(serialized), facts, expected)
    const fingerprint = createHash('sha256').update(JSON.stringify([id, serialized, expected.toString(), issuer]))
      .digest('hex')
    return { checked, fingerprint, expected }
  }

  return {
    owner: wallet.address,
    clear: (id: string) => confirmations.delete(id),
    review(id: string, serialized: string, input: unknown, issuer: unknown, facts: ChainFacts) {
      confirmations.delete(id)
      const { checked, fingerprint, expected } = inspect(id, serialized, input, issuer, facts)
      if (checked.errors.length === 0) confirmations.set(id, fingerprint)
      return { errors: checked.errors, expected: String(expected), received: String(checked.value), spender: checked.spender,
        permit: checked.permit, confirmation: checked.errors.length === 0 ? fingerprint : null }
    },
    async sign(id: string, serialized: string, input: unknown, issuer: unknown, confirmation: unknown,
      facts: ChainFacts): Promise<{ permit: Permit; signature: string }> {
      const prior = confirmations.get(id)
      confirmations.delete(id)
      const { checked, fingerprint } = inspect(id, serialized, input, issuer, facts)
      if (checked.errors.length) throw new Error(checked.errors.join(' '))
      if (prior !== fingerprint || confirmation !== fingerprint) {
        throw new Error('Запрос или сумма изменились. Проверьте разрешение заново.')
      }
      const permit = checked.permit
      return { permit, signature: await wallet.signTypedData(permit.domain, { Permit: permitFields }, permit.message) }
    },
  }
}
