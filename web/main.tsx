import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { formatUnits } from 'ethers'
import { amountUnits } from '../shared/permit.ts'
import { issuerLabel, maskedAccount, scenarios, stageLabels, startingBank } from '../shared/model.ts'
import type { Scenario, Stage, State } from '../shared/model.ts'
import type { Permit } from '../shared/permit.ts'
import './style.css'

const rubatonMark = new URL('./assets/rubaton-mark.webp', import.meta.url).href
const securityArt = new URL('./assets/rubaton-security.webp', import.meta.url).href
const number = new Intl.NumberFormat('ru-RU')
const rubles = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2,
  minimumFractionDigits: 0 })
const money = (kopecks: number) => rubles.format(kopecks / 100)
function quote(amount: string) {
  try {
    return money(Number(amountUnits(amount, 2)))
  } catch {
    return '—'
  }
}
function tokens(minor: string, decimals: number) {
  const [whole, fraction] = formatUnits(minor, decimals).split('.')
  return number.format(BigInt(whole)) + (fraction && fraction !== '0' ? ',' + fraction : '') + ' RUBA'
}
const short = (value: string) => value.slice(0, 10) + '…' + value.slice(-5)
const next: Record<Stage, string> = {
  kyc: 'Эмитент проверяет клиента.',
  pending: 'Дождитесь ответа эмитента по проверке кошелька.',
  denied: 'Эмитент остановил заявку по результату KYT.',
  ready: 'Откройте кошелёк и проверьте разрешение перед подписью.',
  signed: 'Эмитент может передать подпись Permit в сеть.',
  allowed: 'Эмитент может сжечь токены в пределах разрешения.',
  burned: 'Эмитент должен отправить рубли на счёт клиента.',
  refused: 'Банк отказал до списания. Оператор может повторить выплату.',
  unknown: 'Оператору нужно запросить статус исходной попытки.',
  paid: 'Банк подтвердил зачисление на тестовый счёт клиента.',
  cancelled: 'Можно создать новую заявку.',
  permitFailed: 'Оператор может выпустить новый запрос для подписи.',
  permitPending: 'Уточняем результат по сохранённому хешу транзакции.',
  burnPending: 'Уточняем результат по сохранённому хешу транзакции.',
}

async function api<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/' + path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined)
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result as T
}

function Shell({ wallet = false, operator = false, children }: {
  wallet?: boolean; operator?: boolean; children: ReactNode
}) {
  return <>
    <a className="skip-link" href="#main" onClick={event => {
      event.preventDefault()
      document.getElementById('main')?.focus()
    }}>К содержанию</a>
    <header className="top">
      <div className="frame top-content">
        <div className="wordmark"><img src={rubatonMark} alt="" width={30} height={30} /><strong>RUBATON</strong></div>
        {wallet ? <span className="wallet-nav">Кошелёк</span> : <nav aria-label="Разделы портала">
          <a href="/" aria-current={!operator ? 'page' : undefined}>Заявка</a>
          <a href="/operator" aria-current={operator ? 'page' : undefined}>Оператор</a>
        </nav>}
        <span className="local">Тестовая среда</span>
      </div>
    </header>
    <main id="main" tabIndex={-1} className={wallet ? 'frame stage wallet-stage' : 'frame stage'}>{children}</main>
    <footer className="frame footer">
      <span>KYC, KYT и банковские операции симулируются</span>
      <span>Трек Б · Безопасность</span>
    </footer>
  </>
}

function Address({ label, value }: { label: string; value: string }) {
  return <details className="address"><summary>{label} <code>{short(value)}</code></summary><code>{value}</code></details>
}

function Alert({ error }: { error: string }) {
  return error ? <p className="error" role="alert">{error}</p> : null
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

function Account({ state }: { state: State }) {
  return <aside className="account" aria-label="Кошелёк и рублёвый счёт">
    <dl className="account-facts">
      <Field label="Разрешено модулю">{tokens(state.allowance, state.decimals)}</Field>
      <Field label="Зачислено на счёт">{money(state.confirmed)}</Field>
    </dl>
  </aside>
}

function Reconciliation({ state }: { state: State }) {
  const burned = 60_000n * 10n ** BigInt(state.decimals) - BigInt(state.supply)
  return <aside className="panel reconciliation" aria-labelledby="reconciliation-title">
    <h2 id="reconciliation-title">Сверка</h2>
    <h3>Токены</h3>
    <dl className="facts">
      <Field label="Баланс клиента">{tokens(state.balance, state.decimals)}</Field>
      <Field label="Разрешение модуля">{tokens(state.allowance, state.decimals)}</Field>
      <Field label="Сожжено">{tokens(String(burned), state.decimals)}</Field>
      <Field label="Эмиссия">{tokens(state.supply, state.decimals)}</Field>
    </dl>
    <h3>Выплата</h3>
    <dl className="facts">
      <Field label="Зачислено клиенту">{money(state.bankClient)}</Field>
      <Field label="Долг эмитента"><span className={state.debt ? 'due' : undefined}>{money(state.debt)}</span></Field>
      <Field label="Счёт эмитента">{money(state.bankIssuer)}</Field>
      <Field label="Изменение счёта">{money(state.bankIssuer - startingBank)}</Field>
      <Field label="Попыток выплаты">{state.attempts.length}</Field>
    </dl>
    {state.request?.stage === 'unknown' && <p className="hint">На счетах показаны только подтверждённые суммы.</p>}
    <details className="disclosure"><summary>Данные сверки</summary>
      <p>Локальная EVM · {state.chainId}</p>
      <Address label="Владелец" value={state.owner} />
      <Address label="Модуль погашения" value={state.spender} />
      {state.request?.debtId && <details className="disclosure"><summary>Номер обязательства</summary>
        <code>{state.request.debtId}</code></details>}
    </details>
  </aside>
}

function Progress({ stage }: { stage: Stage }) {
  const lastDone: Record<Stage, number> = {
    kyc: -1, pending: -1, denied: -1, cancelled: -1, ready: 0, permitFailed: 0,
    signed: 1, permitPending: 1, allowed: 2, burnPending: 2,
    burned: 3, refused: 3, unknown: 3, paid: 4,
  }
  const done = lastDone[stage]
  const stopped = ['denied', 'cancelled'].includes(stage)
  const labels = ['Проверка', 'Подпись', 'Разрешение', 'Сжигание', 'Выплата']
  return <ol className="progress" aria-label="Этапы погашения">{labels.map((label, i) =>
    <li key={label} data-done={i <= done}
      aria-current={!stopped && i === done + 1 ? 'step' : undefined}>
      <i aria-hidden="true" />{label}{i <= done && <span className="sr-only"> — завершено</span>}
    </li>)}</ol>
}

function Journal({ state }: { state: State }) {
  return <section className="panel journal">
    <h2>Журнал операций</h2>
    {state.journal.length === 0 ? <p className="hint">Здесь появятся действия по заявке.</p> :
      <table className="data-table">
        <thead><tr><th scope="col">Время</th><th scope="col">Участник</th><th scope="col">Событие</th></tr></thead>
        <tbody>{state.journal.map((event, i) => <tr key={event.at + i}>
          <td><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString('ru-RU')}</time></td>
          <td>{event.actor}</td>
          <td>{event.text}
            {event.ref && <details className="disclosure journal-ref">
              <summary>{event.ref.startsWith('0x') ? 'Хеш транзакции' : 'Номер перевода'}</summary>
              <code>{event.ref}</code>
            </details>}
          </td>
        </tr>)}</tbody>
      </table>}
  </section>
}

function Portal({ operator }: { operator: boolean }) {
  const [state, setState] = useState<State>()
  const [amount, setAmount] = useState('5000')
  const [scenario, setScenario] = useState<Scenario>('success')
  const [pendingAction, setPendingAction] = useState<string>()
  const [error, setError] = useState('')
  const [amountError, setAmountError] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const busy = pendingAction !== undefined

  useEffect(() => {
    let alive = true
    let loading = false
    async function refresh() {
      if (loading || busy) return
      loading = true
      try {
        const data = await api<State>('state')
        if (alive) setState(data)
      } catch (err) {
        if (alive) setError((err as Error).message)
      } finally {
        loading = false
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 1700)
    return () => { alive = false; window.clearInterval(timer) }
  }, [busy])

  async function act(path: string, values: Record<string, unknown> = {}) {
    setError('')
    setAmountError('')
    setPendingAction(path)
    try {
      setState(await api<State>(path, values))
      if (path === 'reset') {
        setConfirmReset(false)
        setAmount('5000')
        setScenario('success')
      }
    } catch (err) {
      if (path === 'create') setAmountError((err as Error).message)
      else setError((err as Error).message)
    } finally {
      setPendingAction(undefined)
    }
  }

  const row = state?.request
  const canCreate = !row || ['paid', 'denied', 'cancelled'].includes(row.stage)
  const last = state?.attempts.at(-1)
  const operatorAction = row && ({
    signed: ['permit', 'Применить Permit'],
    allowed: ['burn', 'Сжечь токены'],
    burned: ['pay', 'Отправить выплату'],
    refused: ['pay', 'Повторить выплату'],
    unknown: ['reconcile', 'Сверить исходный перевод'],
    permitFailed: ['renew', 'Выпустить новый запрос'],
  } as Partial<Record<Stage, string[]>>)[row.stage]

  return <Shell operator={operator}>
    <div className="page-heading">
      <div>
        <h1>{operator ? 'Исполнение заявки' : 'Погашение RUBA'}</h1>
        <p>{operator ? issuerLabel : 'Рубли поступят на банковский счёт после погашения токенов и подтверждения выплаты.'}</p>
      </div>
      {!operator && state && <dl className="heading-note">
        <Field label="Баланс кошелька">{tokens(state.balance, state.decimals)}</Field>
      </dl>}
    </div>
    <Alert error={error} />
    {state ? <>
      <div className={operator ? 'workspace operator-workspace' : 'workspace client-workspace'}>
        <div className="stack">
          {row ? <section className="panel request">
            <div className="card-head">
              <div><h2>{tokens(row.units, state.decimals)}</h2><p>Заявка <code>{short(row.id)}</code></p></div>
              <span className="status" data-stage={row.stage}>{stageLabels[row.stage]}</span>
            </div>
            <Progress stage={row.stage} />
            <div className="request-next">
              <p role="status" className="next">{next[row.stage]}</p>
              {row.stage === 'ready' && !operator &&
                <a className="button" href={state.walletOrigin + '/wallet#' + row.id} target="_blank"
                  rel="noopener noreferrer">Открыть кошелёк</a>}
              {operator && operatorAction && <button disabled={busy} onClick={() => void act(operatorAction[0], {
                id: row.id, previous: last?.id ?? null, attempt: last?.id,
              })}>{busy ? 'Выполняется…' : operatorAction[1]}</button>}
            </div>
            <dl className="facts request-facts">
              <Field label="К перечислению">{money(row.kopecks)}</Field>
              <Field label="Счёт получателя">{row.account}</Field>
              <Field label="KYC">Пройден</Field>
              <Field label="KYT">{{ approved: 'Одобрен', review: 'На проверке', denied: 'Отказ' }[row.kyt]}</Field>
            </dl>
            <div className="request-footer">
              <details className="disclosure"><summary>Номер заявки</summary><code>{row.id}</code></details>
              {!operator && ['ready', 'pending'].includes(row.stage) && <div className="actions">
                {row.stage === 'ready' && <button className="text-button" disabled={busy}
                  onClick={() => void act('renew', { id: row.id })}>Обновить запрос</button>}
                <button className="text-button" disabled={busy}
                  onClick={() => void act('cancel', { id: row.id })}>Отменить заявку</button>
              </div>}
            </div>
          </section> : operator && <section className="panel"><h2>Нет заявки</h2>
            <p className="hint">Клиент ещё не подавал заявку в этом прогоне.</p></section>}
          {!operator && canCreate && <form className="panel redeem-form" onSubmit={(e: FormEvent) => {
            e.preventDefault()
            try {
              amountUnits(amount, 2)
            } catch (err) {
              setAmountError((err as Error).message)
              return
            }
            void act('create', { amount, scenario })
          }}>
            <h2>Новая заявка</h2>
            <div className="transfer">
              <div className="transfer-from">
                <label htmlFor="redemption-amount">Сумма погашения</label>
                <div className="amount-input"><input id="redemption-amount" inputMode="decimal" value={amount}
                  required disabled={busy} aria-invalid={Boolean(amountError)} aria-describedby={amountError ? 'amount-error' : undefined}
                  onChange={e => { setAmount(e.target.value); setAmountError('') }} /><span>RUBA</span></div>
                {amountError && <p id="amount-error" className="field-error" role="alert">{amountError}</p>}
              </div>
              <div className="transfer-to">
                <p id="payout-label">К зачислению</p>
                <output aria-labelledby="payout-label" htmlFor="redemption-amount">{quote(amount)}</output>
                <p className="payout-account">Рублёвый счёт <strong>{maskedAccount}</strong></p>
              </div>
            </div>
            <div className="transfer-footer">
              <dl className="transfer-terms">
                <Field label="Курс">1 RUBA = 1 ₽</Field>
                <Field label="Комиссия">0 ₽</Field>
              </dl>
              <button disabled={busy}>{pendingAction === 'create' ? 'Создаём заявку…' : 'Создать заявку'}</button>
            </div>
          </form>}
        </div>
        {operator ? <Reconciliation state={state} /> : <Account state={state} />}
        {operator && <Journal state={state} />}
      </div>
      {!operator && <details className="demo-tools">
        <summary>Управление стендом</summary>
        <div className="demo-content">
          <div><label htmlFor="scenario">Следующая заявка</label>
            <select id="scenario" value={scenario} disabled={!canCreate || busy} onChange={e => {
              setScenario(e.target.value as Scenario)
              setAmount('5000')
              setAmountError('')
            }}>{Object.entries(scenarios).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
          </div>
          {confirmReset ? <div className="reset-confirm">
            <p>Начать новый прогон с исходными балансами?</p>
            <div className="actions">
              <button className="danger" disabled={busy}
                onClick={() => void act('reset', { generation: state.generation })}>
                {pendingAction === 'reset' ? 'Сбрасываем…' : 'Подтвердить сброс'}
              </button>
              <button className="secondary" disabled={busy} onClick={() => setConfirmReset(false)}>Оставить прогон</button>
            </div>
          </div> : <button className="secondary" onClick={() => setConfirmReset(true)}>Сбросить прогон</button>}
        </div>
      </details>}
    </> : !error && <p role="status" className="hint">Загружается состояние стенда…</p>}
  </Shell>
}

type WalletView = { id: string; owner: string; issuer: string; permit: Permit; spender: string;
  token: string; chainId: string; decimals: number }
type Review = { errors: string[]; expected: string; received: string; spender: string;
  permit: Permit; confirmation: string | null }

function WalletScreen() {
  const [data, setData] = useState<WalletView>()
  const [amount, setAmount] = useState('')
  const [issuer, setIssuer] = useState('')
  const [review, setReview] = useState<Review>()
  const [status, setStatus] = useState('')
  const [pendingAction, setPendingAction] = useState<'review' | 'sign' | 'cancel'>()
  const [error, setError] = useState('')
  const id = window.location.hash.slice(1)
  const busy = pendingAction !== undefined
  const difference = review ? BigInt(review.received) - BigInt(review.expected) : 0n
  useEffect(() => {
    if (!id) return
    let alive = true
    api<WalletView>('request?id=' + encodeURIComponent(id)).then(
      result => { if (alive) setData(result) },
      err => { if (alive) setError(err.message) },
    )
    return () => { alive = false }
  }, [id])

  async function action(path: 'review' | 'sign' | 'cancel') {
    setPendingAction(path)
    setError('')
    if (path !== 'sign') setReview(undefined)
    try {
      const result = await api<Review>(path, { id, amount, issuer, confirmation: review?.confirmation })
      if (path === 'review') setReview(result)
      if (path === 'sign') setStatus('Подпись передана эмитенту. Вернитесь на портал.')
      if (path === 'cancel') setStatus('Заявка отменена. Вернитесь на портал.')
    } catch (err) {
      setReview(undefined)
      setError((err as Error).message)
    } finally {
      setPendingAction(undefined)
    }
  }

  return <Shell wallet>
    <div className="page-heading wallet-heading">
      <div>
        <p className="track">Трек Б · Безопасность</p>
        <h1>Проверка разрешения перед подписью</h1>
        <p>Кошелёк проверяет сумму и адрес модуля в запросе Permit.</p>
      </div>
      <img className="security-art" src={securityArt} alt="" width={625} height={612} />
    </div>
    {!data && <Alert error={error} />}
    {!id && <p className="panel">Откройте кошелёк из карточки заявки на портале эмитента.</p>}
    {id && !data && !error && <p className="hint" role="status">Загружается запрос…</p>}
    {status && <p className="panel done-message" role="status">{status}</p>}
    {data && !status && <>
      <section className="panel wallet-panel">
        <h2>Ваши условия</h2>
        <form onSubmit={e => { e.preventDefault(); void action('review') }}>
          <div className="wallet-fields">
            <div><label htmlFor="expected-amount">Ожидаемая сумма</label>
              <div className="amount-input"><input id="expected-amount" inputMode="decimal" placeholder="0"
                value={amount} required disabled={busy} onChange={e => {
                  setAmount(e.target.value)
                  setReview(undefined)
                  setError('')
                }} /><span>RUBA</span></div>
            </div>
            <div><label htmlFor="expected-issuer">Эмитент</label>
              <select id="expected-issuer" value={issuer} required disabled={busy} onChange={e => {
                setIssuer(e.target.value)
                setReview(undefined)
                setError('')
              }}><option value="">Выберите эмитента</option><option>{issuerLabel}</option></select>
            </div>
          </div>
          <Alert error={error} />
          <div className="actions">
            <button className={review ? 'secondary' : undefined} disabled={busy}>
              {pendingAction === 'review' ? 'Проверяем запрос…' : 'Проверить разрешение'}
            </button>
            <button type="button" className="text-button" disabled={busy}
              onClick={() => void action('cancel')}>{pendingAction === 'cancel' ? 'Отменяем…' : 'Отменить'}</button>
          </div>
        </form>
        {review && <section className="review" aria-labelledby="review-title">
          <h2 id="review-title">Сверка запроса</h2>
          <table className="data-table comparison" aria-labelledby="review-title">
            <thead><tr><th scope="col">Параметр</th><th scope="col">В кошельке</th><th scope="col">В запросе</th></tr></thead>
            <tbody>
              <tr className="amount-row">
                <th scope="row">Сумма</th>
                <td>{tokens(review.expected, data.decimals)}</td>
                <td className={difference !== 0n ? 'difference' : undefined}>
                  {tokens(review.received, data.decimals)}
                  {difference !== 0n && <small className="delta"><span className="sr-only">Разница </span>
                    <span>{difference > 0n ? '+' : '−'}{tokens(String(difference > 0n ? difference : -difference), data.decimals)}</span>
                  </small>}
                </td>
              </tr>
              <tr>
                <th scope="row">Адрес модуля</th>
                <td><Address label="Ожидаемый модуль" value={data.spender} /></td>
                <td className={review.spender.toLowerCase() !== data.spender.toLowerCase() ? 'difference' : undefined}>
                  <Address label="Получатель в запросе" value={review.spender} />
                </td>
              </tr>
              <tr>
                <th scope="row">Сеть (chain ID)</th>
                <td>{data.chainId}</td>
                <td className={data.chainId !== review.permit.domain.chainId ? 'difference' : undefined}>
                  {review.permit.domain.chainId}
                </td>
              </tr>
              <tr>
                <th scope="row">Контракт RUBA</th>
                <td><Address label="Ожидаемый контракт" value={data.token} /></td>
                <td className={data.token.toLowerCase() !== review.permit.domain.verifyingContract.toLowerCase() ? 'difference' : undefined}>
                  <Address label="Контракт в запросе" value={review.permit.domain.verifyingContract} />
                </td>
              </tr>
            </tbody>
          </table>
          <div className="verdict" data-pass={Boolean(review.confirmation)}>
            <div role="status">
              <h3>{review.confirmation ? 'Разрешение совпадает' : 'Подписание заблокировано'}</h3>
              {review.errors.map(message => <p key={message}>{message}</p>)}
              {review.confirmation && <p>Подпись разрешает модулю использовать указанную сумму RUBA.</p>}
            </div>
            {review.confirmation ? <button disabled={busy} onClick={() => void action('sign')}>
              {pendingAction === 'sign' ? 'Подписываем…' : 'Подтвердить и подписать'}
            </button> : <button type="button" disabled>Подписать разрешение</button>}
          </div>
        </section>}
      </section>
      <details className="disclosure wallet-details">
        <summary>Технические данные запроса</summary>
        <p>Локальная EVM · {data.chainId}</p>
        <Address label="Токен RUBA" value={data.token} />
        <Address label="Владелец" value={data.owner} />
        <details className="disclosure"><summary>Запрос EIP-712</summary><pre>{JSON.stringify(review?.permit ?? data.permit, null, 2)}</pre></details>
      </details>
    </>}
  </Shell>
}

createRoot(document.getElementById('root')!).render(location.pathname === '/wallet'
  ? <WalletScreen /> : <Portal operator={location.pathname === '/operator'} />)
