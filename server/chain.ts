import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ganache from 'ganache'
import {
  BrowserProvider, Contract, ContractFactory, Signature, Wallet, getAddress, keccak256,
} from 'ethers'
import type { Eip1193Provider, InterfaceAbi, TransactionReceipt } from 'ethers'
import type { Permit } from '../shared/permit.ts'

const artifact = (name: string) =>
  JSON.parse(readFileSync(new URL('../artifacts/' + name + '.json', import.meta.url), 'utf8')) as {
    abi: InterfaceAbi; bytecode: string
  }
const tokenArtifact = artifact('DemoRuba')
const moduleArtifact = artifact('Redemption')

export async function openChain(
  directory: string,
  owner: string,
  config: { chainId: number; issuerKey: string; token?: string; module?: string },
) {
  const { chainId, issuerKey } = config
  const evm = ganache.provider({
    chain: { chainId, hardfork: 'shanghai', vmErrorsOnRPCResponse: false },
    database: { dbPath: join(directory, 'evm') },
    wallet: { accounts: [{ secretKey: issuerKey, balance: '0x3635c9adc5dea00000' }] },
    logging: { quiet: true },
  })
  const rpc = new BrowserProvider(evm as unknown as Eip1193Provider, chainId, { cacheTimeout: -1 })
  const issuer = new Wallet(issuerKey, rpc)
  let tokenAddress = config.token
  let moduleAddress = config.module
  if (!tokenAddress || !moduleAddress) {
    const token = await new ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, issuer).deploy(owner)
    await token.waitForDeployment()
    tokenAddress = await token.getAddress()
    const module = await new ContractFactory(moduleArtifact.abi, moduleArtifact.bytecode, issuer)
      .deploy(tokenAddress, issuer.address)
    await module.waitForDeployment()
    moduleAddress = await module.getAddress()
  }
  const token = new Contract(tokenAddress, tokenArtifact.abi, issuer)
  const module = new Contract(moduleAddress, moduleArtifact.abi, issuer)
  const spender = getAddress(moduleAddress)
  const domain = {
    name: 'RUBA Demo', version: '1', chainId: String(chainId), verifyingContract: getAddress(tokenAddress),
  }
  const decimals = Number(await token.decimals())
  if (decimals < 2 || await module.token() !== domain.verifyingContract ||
      await module.issuer() !== issuer.address) throw new Error('Конфигурация контрактов стенда не совпадает.')

  async function facts() {
    const [block, nonce, balance, domainSeparator, network] = await Promise.all([
      rpc.getBlock('latest'), token.nonces(owner), token.balanceOf(owner), token.DOMAIN_SEPARATOR(), rpc.getNetwork(),
    ])
    if (!block || network.chainId !== BigInt(chainId)) throw new Error('Не удалось проверить локальную сеть.')
    // Учитываем время следующего блока Ganache при простое между транзакциями.
    const now = BigInt(Math.floor(Date.now() / 1000))
    const blockTime = BigInt(block.timestamp)
    return { owner, spender, domain, domainSeparator: String(domainSeparator), decimals,
      nonce: BigInt(nonce), balance: BigInt(balance), time: blockTime > now ? blockTime : now }
  }

  async function balances() {
    const [balance, allowance, supply] = await Promise.all([
      token.balanceOf(owner), token.allowance(owner, spender), token.totalSupply(),
    ])
    return { balance: String(balance), allowance: String(allowance), supply: String(supply), decimals }
  }

  async function prepare(data: string, to: string) {
    const tx = await issuer.populateTransaction({ to, data, gasLimit: 220_000, type: 2 })
    const raw = await issuer.signTransaction(tx)
    return { raw, hash: keccak256(raw) }
  }

  async function receipt(raw: string, hash: string) {
    const existing = await rpc.getTransactionReceipt(hash)
    if (existing) return existing
    try {
      await rpc.broadcastTransaction(raw)
    } catch (error) {
      const mined = await rpc.getTransactionReceipt(hash)
      if (mined) return mined
      const pending = await rpc.getTransaction(hash)
      if (!pending) throw error
    }
    return rpc.getTransactionReceipt(hash)
  }

  function approvalData(permit: Permit, signature: string) {
    const { owner, spender, value, deadline } = permit.message
    const { v, r, s } = Signature.from(signature)
    return token.interface.encodeFunctionData('permit', [owner, spender, value, deadline, v, r, s])
  }

  function hasEvent(receipt: TransactionReceipt, contract: Contract, name: string, args: string[]) {
    return receipt.status === 1 && receipt.logs.some(log => {
      if (log.address.toLowerCase() !== String(contract.target).toLowerCase()) return false
      const event = contract.interface.parseLog(log)
      return event?.name === name && args.every((arg, i) => String(event.args[i]) === arg)
    })
  }

  return {
    rpc, token, module, issuer: issuer.address, domain, spender, decimals, facts, balances, prepare, receipt,
    approvalData, hasEvent, close: async () => { rpc.destroy(); await evm.disconnect() },
  }
}

export type Chain = Awaited<ReturnType<typeof openChain>>
