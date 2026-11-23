import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import solc from 'solc'

const source = 'contracts/Redemption.sol'
const input = {
  language: 'Solidity',
  sources: { [source]: { content: readFileSync(source, 'utf8') } },
  settings: {
    evmVersion: 'shanghai',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input), {
  import(path) {
    try {
      return { contents: readFileSync(resolve('node_modules', path), 'utf8') }
    } catch {
      return { error: 'Не удалось загрузить ' + path }
    }
  },
}))
for (const error of output.errors ?? []) console.error(error.formattedMessage)
if (!output.contracts?.[source] || output.errors?.some(error => error.severity === 'error')) process.exit(1)

mkdirSync('artifacts', { recursive: true })
for (const [name, contract] of Object.entries(output.contracts[source])) {
  const { abi, evm } = contract
  writeFileSync('artifacts/' + name + '.json', JSON.stringify({ abi, bytecode: '0x' + evm.bytecode.object }))
}
