import { Fragment, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from 'radix-ui'
import chatgptLogo from '../assets/chatgpt-logo-white.svg?url'
import { ApiError, request } from '../lib/api'
import { Loading, Problem } from '../components/states'

type Status = { accounts: { id: string; label: string; needsConsent: boolean; connected: boolean }[]; active?: string; connected: boolean;
  models: { id: string; name: string; efforts: string[] }[]; model?: string; effort?: string; problem?: string }
const base = '/api/v1/settings/chatgpt'
const recovery: Record<string, string> = {
  CHATGPT_CALLBACK_BUSY: 'The callback port is occupied. Finish the other sign-in before retrying.',
  CHATGPT_BUSY: 'Another sign-in is in progress. Finish it before retrying.',
  CHATGPT_INVALID: 'Sign-in could not be verified. Start a new connection from this browser.',
  CHATGPT_MODEL: 'The account catalog changed. Refresh Settings and choose a supported model and effort.',
}

function post(path: string, body?: unknown) {
  return request(base + '/' + path, { method: 'POST', ...(body === undefined ? {} : {
    body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }) })
}

export function ChatGPTSettings() {
  const client = useQueryClient()
  const result = useQuery({ queryKey: ['chatgpt-settings'], queryFn: async ({ signal }) =>
    (await (await request(base, { signal })).json()) as Status })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [welcome, setWelcome] = useState(false)
  const returning = useRef(false)
  const [choice, setChoice] = useState<{ model: string; effort: string }>()
  async function run(action: () => Promise<string>) {
    setBusy(true); setMessage('')
    try {
      setMessage(await action())
      await client.invalidateQueries({ queryKey: ['chatgpt-settings'] })
    } catch (error) {
      const explanation = error instanceof ApiError && error.code ? recovery[error.code] : undefined
      setMessage(explanation ?? 'Request unsuccessful. Check the connection and try again.')
    } finally { setBusy(false) }
  }
  useEffect(() => {
    const url = new URL(window.location.href)
    if (returning.current || url.searchParams.get('chatgpt') !== 'return') return
    returning.current = true
    url.searchParams.delete('chatgpt')
    window.history.replaceState(window.history.state, '', url)
    void run(async () => {
      const result = await (await post('finish')).json() as { firstConnection: boolean; planEnabled: boolean }
      setWelcome(result.firstConnection)
      return result.planEnabled ? 'ChatGPT connected.' : 'Account saved. ChatGPT plan use is disabled.'
    })
  }, []) // The callback may be consumed once by its initiating workspace session.
  function connect(id?: string) {
    void run(async () => {
      const { url } = await (await post('connect', { id })).json() as { url: string }
      const target = new URL(url)
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/auth/start') throw Error()
      window.location.assign(target.href)
      return 'Continuing to ChatGPT…'
    })
  }
  function disconnect(id: string) {
    void run(async () => {
      const { revoked } = await (await post('disconnect', { id })).json() as { revoked: boolean }
      setChoice(undefined)
      return revoked ? 'Disconnected.' : 'Disconnected locally. Confirm remote access is removed in ChatGPT Settings.'
    })
  }
  const data = result.data
  const model = choice?.model ?? data?.model ?? ''
  const efforts = data?.models.find(item => item.id === model)?.efforts ?? []
  const effort = choice?.effort ?? data?.effort ?? ''
  return <div className="page"><h1>Settings</h1>
    <section aria-labelledby="chatgpt-title" className="state-card">
      <h2 id="chatgpt-title">Connect ChatGPT</h2>
      <p>Use your ChatGPT plan to draft repair briefs. Review your plan and credit limits before connecting.</p>
      {result.isLoading && <Loading>Loading connection…</Loading>}
      {result.error && <Problem resource="ChatGPT settings" error={result.error} retry={() => void result.refetch()} />}
      {data && <>
        <p>{data.connected ? 'Using ChatGPT plan · ' + data.accounts.find(a => a.id === data.active)?.label : data.accounts.some(a => a.needsConsent && a.id === data.active) ? 'ChatGPT plan use disabled' : 'Disconnected'}</p>
        {data.accounts.map(a => <Fragment key={a.id}><button disabled={busy} type="button" className="button"
          onClick={() => connect(a.id)}>{a.needsConsent ? 'Enable ChatGPT plan for' : a.id === data.active ? 'Reconnect' : 'Connect'} {a.label}</button>
          {(a.needsConsent || (a.connected && a.id !== data.active)) && <button className="button" type="button" disabled={busy}
            onClick={() => disconnect(a.id)}>Disconnect {a.label}</button>}
        </Fragment>)}
        <button data-oai-siwc-button="" style={{ background: '#111', color: '#fff' }} className="button" type="button" disabled={busy} onClick={() => connect()}>
          <img src={chatgptLogo} alt="" width="18" height="18" />
          {data.accounts.length ? 'Add ChatGPT account' : 'Continue with ChatGPT'}</button>
        {data.problem && <p role="alert">{data.problem} {data.connected && <button type="button" className="button" onClick={() => void result.refetch()}>Retry</button>}</p>}
        {data.connected && data.active && <>
          <form className="login-form" onSubmit={event => { event.preventDefault(); void run(async () => {
            await post('preferences', { id: data.active, model, effort: effort || undefined }); setChoice(undefined); return 'Preferences saved.'
          }) }}>
            <label>Model<select value={model} required disabled={busy || !data.models.length}
              onChange={e => setChoice({ model: e.target.value, effort: '' })}>
              <option value="">Select a model</option>{data.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select></label>
            <label>Reasoning effort<select value={effort} disabled={busy || !efforts.length}
              onChange={e => setChoice({ model, effort: e.target.value })}>
              <option value="">Model default</option>{efforts.map(e => <option key={e}>{e}</option>)}
            </select></label>
            <button type="submit" className="button primary" disabled={busy || !data.models.some(m => m.id === model)}>Save preferences</button>
          </form>
          <button type="button" disabled={busy} className="button" onClick={() => disconnect(data.active!)}>Disconnect ChatGPT</button>
        </>}
      </>}
      <Dialog.Root open={welcome} onOpenChange={setWelcome}><Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-sheet command-sheet">
          <Dialog.Title>You’re using your ChatGPT plan</Dialog.Title>
          <Dialog.Description>Eligible repair requests use your plan. You can manage limits in ChatGPT Settings.</Dialog.Description>
          <Dialog.Close className="button primary">Got it</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal></Dialog.Root>
      <p role="status">{message}</p>
      <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage ChatGPT usage</a>
    </section>
  </div>
}
