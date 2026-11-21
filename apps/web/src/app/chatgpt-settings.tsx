import { Fragment, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from 'radix-ui'
import chatgptLogo from '../assets/chatgpt-logo-white.svg?url'
import { ApiError, request } from '../lib/api'
import { Loading, Problem } from '../components/states'

type Status = { sshUser: string; callbackPort: number; retryNew: boolean; accounts: { id: string; label: string; needsConsent: boolean; connected: boolean }[]; active?: string; connected: boolean;
  models: { id: string; name: string; efforts: string[] }[]; model?: string; effort?: string; problem?: string }
const base = '/api/v1/settings/chatgpt'
const recovery: Record<string, string> = {
  CHATGPT_CALLBACK_BUSY: 'The callback port is occupied. Finish the other sign-in before retrying.',
  CHATGPT_BUSY: 'Another sign-in is in progress. Finish it before retrying.',
  CHATGPT_REGISTRATION_RETRY: 'Registration did not finish. Retry to use the account you just registered.',
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
  const [remoteSetup, setRemoteSetup] = useState<{ id?: string; retryNew?: true }>()
  const returning = useRef(false)
  async function run(action: () => Promise<string>) {
    setBusy(true); setMessage('')
    try {
      setMessage(await action())
      await client.invalidateQueries({ queryKey: ['chatgpt-settings'] })
    } catch (error) {
      const explanation = error instanceof ApiError && error.code ? recovery[error.code] : undefined
      setMessage(explanation ?? 'Request unsuccessful. Check the connection and try again.')
      if (error instanceof ApiError && error.code === 'CHATGPT_REGISTRATION_RETRY')
        await client.invalidateQueries({ queryKey: ['chatgpt-settings'] })
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
  function connect(id?: string, retryNew?: true) {
    if (['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) start(id, retryNew)
    else setRemoteSetup({ id, retryNew })
  }
  function confirmLocation() {
    if (remoteSetup) start(remoteSetup.id, remoteSetup.retryNew)
    setRemoteSetup(undefined)
  }
  function start(id?: string, retryNew?: true) {
    void run(async () => {
      const { url } = await (await post('connect', { id, retryNew })).json() as { url: string }
      const target = new URL(url)
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/auth/start') throw Error()
      window.location.assign(target.href)
      return 'Continuing to ChatGPT…'
    })
  }
  function disconnect(id: string) {
    void run(async () => {
      const { revoked } = await (await post('disconnect', { id })).json() as { revoked: boolean }
      return revoked ? 'Disconnected.' : 'Disconnected locally. Confirm remote access is removed in ChatGPT Settings.'
    })
  }
  const data = result.data
  const hostname = window.location.hostname
  const sshHost = /^(?:[a-z0-9][a-z0-9.-]*|\[[a-f0-9:]+\])$/i.test(hostname) ? hostname.replace(/^\[|\]$/g, '') : 'YOUR_SSH_HOST'
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
        {data.retryNew && <button type="button" className="button" disabled={busy}
          onClick={() => connect(undefined, true)}>Retry new registration</button>}
        <button data-oai-siwc-button="" style={{ background: '#111', color: '#fff' }} className="button" type="button" disabled={busy} onClick={() => connect()}>
          <img src={chatgptLogo} alt="" width="18" height="18" />
          {data.accounts.length ? 'Add ChatGPT account' : 'Continue with ChatGPT'}</button>
        {data.problem && <p role="alert">{data.problem} {data.connected && <button type="button" className="button" onClick={() => void result.refetch()}>Retry</button>}</p>}
        {data.connected && data.active && <>
          <Preferences key={data.active} id={data.active} data={data} busy={busy} run={run} />
          <button type="button" disabled={busy} className="button" onClick={() => disconnect(data.active!)}>Disconnect ChatGPT</button>
        </>}
      </>}
      {data && <Dialog.Root open={Boolean(remoteSetup)} onOpenChange={open => { if (!open) setRemoteSetup(undefined) }}>
        <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-sheet command-sheet">
          <Dialog.Title>Connect from this computer</Dialog.Title>
          <Dialog.Description>ChatGPT returns to the computer running your browser. If you’re browsing on the miniserver, choose the miniserver option below. On another computer, run this command in Windows Terminal or your terminal.</Dialog.Description>
          <p><code style={{ overflowWrap: 'anywhere', userSelect: 'all' }}>ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:{data.callbackPort}:127.0.0.1:{data.callbackPort} {data.sshUser}@{sshHost}</code></p>
          <p>Use your SSH login if it differs. After signing in, leave the terminal open until you return to Settings. A quiet terminal is expected.</p>
          <details><summary>Port already in use?</summary><p>If the same tunnel is already open, use it. Otherwise finish the sign-in or close the program using port {data.callbackPort}, then run the command again.</p></details>
          <button type="button" className="button primary" onClick={confirmLocation}>Tunnel ready, continue</button>
          <button type="button" className="button" onClick={confirmLocation}>I’m using a browser on the miniserver</button>
          <Dialog.Close className="button">Cancel</Dialog.Close>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>}
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

function Preferences({ id, data, busy, run }: {
  id: string; data: Status; busy: boolean; run: (action: () => Promise<string>) => Promise<void>
}) {
  const [choice, setChoice] = useState<{ model: string; effort: string }>()
  const selected = data.models.find(item => item.id === (choice?.model ?? data.model))
  const model = selected?.id ?? ''
  const efforts = selected?.efforts ?? []
  const requestedEffort = choice?.effort ?? data.effort ?? ''
  const effort = efforts.includes(requestedEffort) ? requestedEffort : ''
  return <form className="login-form" onSubmit={event => {
    event.preventDefault()
    void run(async () => {
      await post('preferences', { id, model, effort: effort || undefined })
      setChoice(undefined)
      return 'Preferences saved.'
    })
  }}>
    <label>Model<select value={model} required disabled={busy || !data.models.length}
      onChange={e => setChoice({ model: e.target.value, effort: '' })}>
      <option value="">Select a model</option>{data.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select></label>
    <label>Reasoning effort<select value={effort} disabled={busy || !efforts.length}
      onChange={e => setChoice({ model, effort: e.target.value })}>
      <option value="">Model default</option>{efforts.map(e => <option key={e}>{e}</option>)}
    </select></label>
    <button type="submit" className="button primary" disabled={busy || !selected}>Save preferences</button>
  </form>
}
