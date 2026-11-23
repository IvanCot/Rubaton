export const issuerLabel = 'Эмитент «Демо»'
export const maskedAccount = '•••• 0426'
export const networkName = 'Локальная EVM'
export const startingBank = 10_000_000
export const scenarios = {
  success: 'Штатное погашение',
  wrongAmount: 'В запросе 50 000 RUBA',
  wrongSpender: 'Другой получатель разрешения',
  refused: 'Отказ банка до списания',
  lost: 'Банк провёл платёж, ответ потерян',
  review: 'KYT на проверке',
  denied: 'KYT отказал',
} as const
export type Scenario = keyof typeof scenarios
export type Stage = 'kyc' | 'pending' | 'denied' | 'ready' | 'signed' | 'allowed' | 'burned' |
  'refused' | 'unknown' | 'paid' | 'cancelled' | 'permitFailed' | 'permitPending' | 'burnPending'
export const stageLabels: Record<Stage, string> = {
  kyc: 'Проверка клиента',
  pending: 'KYT на проверке',
  denied: 'KYT отказал',
  ready: 'Ожидается подпись',
  signed: 'Подпись получена',
  allowed: 'Разрешение установлено',
  burned: 'Токены сожжены',
  refused: 'Банк отказал',
  unknown: 'Уточняется статус перевода',
  paid: 'Выплата подтверждена',
  cancelled: 'Заявка отменена',
  permitFailed: 'Нужна новая подпись',
  permitPending: 'Уточняется применение Permit',
  burnPending: 'Уточняется сжигание',
}
export type Application = {
  id: string
  owner: string
  issuer: string
  account: string
  amount: string
  units: string
  kopecks: number
  scenario: Scenario
  stage: Stage
  kyt: 'approved' | 'review' | 'denied'
  debtId: string | null
}
export type TimelineEvent = { at: string; actor: string; text: string; ref: string | null }
export type Attempt = { id: string; status: 'refused' | 'unknown' | 'paid' }
export type State = {
  generation: string
  chainId: number
  walletOrigin: string
  owner: string
  spender: string
  balance: string
  allowance: string
  supply: string
  decimals: number
  confirmed: number
  debt: number
  bankClient: number
  bankIssuer: number
  request: Application | null
  journal: TimelineEvent[]
  attempts: Attempt[]
}
