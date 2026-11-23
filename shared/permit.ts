import { getAddress, parseUnits, TypedDataEncoder } from 'ethers'

export const permitFields = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
]
const domainFields = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]
const lifetime = 600n
const uintMax = (1n << 256n) - 1n

export type Domain = { name: string; version: string; chainId: string; verifyingContract: string }
export type Permit = {
  primaryType: 'Permit'
  domain: Domain
  types: { EIP712Domain: typeof domainFields; Permit: typeof permitFields }
  message: { owner: string; spender: string; value: string; nonce: string; deadline: string }
}
export type ChainFacts = {
  domain: Domain
  domainSeparator: string
  owner: string
  spender: string
  decimals: number
  balance: bigint
  nonce: bigint
  time: bigint
}

export function amountUnits(value: unknown, decimals: number) {
  if (typeof value !== 'string' || !/^\d{1,12}([.,]\d+)?$/.test(value) ||
      (value.split(/[.,]/)[1]?.length ?? 0) > decimals) {
    throw new Error('Введите положительную сумму с допустимой точностью.')
  }
  const units = parseUnits(value.replace(',', '.'), decimals)
  if (units <= 0n) throw new Error('Сумма должна быть больше нуля.')
  return units
}

export function makePermit(facts: ChainFacts, value: bigint): Permit {
  return {
    primaryType: 'Permit',
    types: { EIP712Domain: domainFields, Permit: permitFields },
    domain: facts.domain,
    message: {
      owner: facts.owner, spender: facts.spender, value: String(value),
      nonce: String(facts.nonce), deadline: String(facts.time + lifetime),
    },
  }
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function hasFields(value: unknown, fields: typeof permitFields) {
  return Array.isArray(value) && value.length === fields.length && fields.every(({ name, type }, i) =>
    hasKeys(value[i], ['name', 'type']) && value[i].name === name && value[i].type === type)
}

function uint(value: unknown) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) > uintMax) {
    throw new Error('Некорректное целое число в запросе Permit.')
  }
  return BigInt(value)
}

function address(value: unknown) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value)) {
    throw new Error('Некорректный адрес в запросе Permit.')
  }
  return getAddress(value)
}

export function evaluate(raw: unknown, facts: ChainFacts, expected: bigint) {
  if (!hasKeys(raw, ['types', 'primaryType', 'domain', 'message']) || raw.primaryType !== 'Permit' ||
      !hasKeys(raw.types, ['EIP712Domain', 'Permit']) ||
      !hasFields(raw.types.EIP712Domain, domainFields) || !hasFields(raw.types.Permit, permitFields) ||
      !hasKeys(raw.domain, domainFields.map(field => field.name)) ||
      !hasKeys(raw.message, permitFields.map(field => field.name))) {
    throw new Error('Кошелёк поддерживает только стандартную структуру ERC-2612 Permit.')
  }

  const { domain, message } = raw as Permit
  const chainId = uint(domain.chainId)
  const token = address(domain.verifyingContract)
  const owner = address(message.owner)
  const spender = address(message.spender)
  const value = uint(message.value)
  const nonce = uint(message.nonce)
  const deadline = uint(message.deadline)
  const errors: string[] = []
  if (chainId !== BigInt(facts.domain.chainId)) errors.push('Не совпадает сеть.')
  if (token !== facts.domain.verifyingContract) errors.push('Не совпадает контракт токена.')
  if (domain.name !== facts.domain.name || domain.version !== facts.domain.version) {
    errors.push('Не совпадает имя или версия домена.')
  }
  if (errors.length === 0 && TypedDataEncoder.hashDomain(domain) !== facts.domainSeparator) {
    errors.push('Хеш домена отличается от значения в контракте.')
  }
  if (owner !== facts.owner) errors.push('В запросе указан другой владелец.')
  if (spender !== facts.spender) errors.push('Получатель разрешения не совпадает с модулем эмитента.')
  if (value !== expected) errors.push('Сумма разрешения не совпадает с введённой суммой.')
  if (value <= 0n || expected <= 0n) errors.push('Сумма должна быть больше нуля.')
  if (value > facts.balance || expected > facts.balance) errors.push('Сумма превышает баланс кошелька.')
  if (nonce !== facts.nonce) errors.push('Nonce не совпадает с текущим значением в контракте.')
  if (deadline < facts.time) errors.push('Срок предъявления подписи истёк.')
  if (deadline > facts.time + lifetime) errors.push('Срок предъявления превышает 10 минут.')
  return { errors, permit: raw as Permit, value, spender }
}
