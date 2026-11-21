import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LockKeyhole, LogOut } from 'lucide-react'
import { Activity, useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Brand } from '../components/brand'
import { AppearanceControl, useAppearance } from '../components/theme'
import type { Appearance } from '../components/theme'
import { Loading, Problem } from '../components/states'
import { ApiError, getSession, signIn, signOut } from '../lib/api'
import type { Session } from '../lib/api'
import { Workspace } from './workspace'

type Access =
  | { kind: 'loading' }
  | { kind: 'anonymous'; expired?: boolean }
  | { kind: 'problem'; error: unknown }
  | { kind: 'authorized'; session: Session }
  | { kind: 'checking'; session: Session; error?: unknown }
  | { kind: 'resetting'; session: Session }

function sessionKey(session: Session) {
  return JSON.stringify([session.id, session.role, session.chatgptSettings, [...session.scopes].sort()])
}

function Login({ appearance, expired, onSignedIn }: {
  appearance: Appearance; expired?: boolean; onSignedIn: () => void
}) {
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending) return
    setSending(true)
    setProblem('')
    const form = event.currentTarget
    const formData = new FormData(form)
    try {
      await signIn(String(formData.get('email')).trim(), String(formData.get('password')))
      form.reset()
      onSignedIn()
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined
      if (status === 401) setProblem('Check your email and password, then try again.')
      else if (status === 429) setProblem('Too many sign-in attempts. Try again in a minute.')
      else setProblem('Sign-in is unavailable. Check your connection and try again.')
    } finally {
      setSending(false)
    }
  }
  return <main className="access-layout">
    <div className="access-panel">
      <div className="access-brand"><Brand /></div>
      <div className="access-content">
        <h1>Sign in</h1>
        <p className="muted"><LockKeyhole size={15} aria-hidden="true" />Private workspace</p>
        {expired && <p className="inline-alert" role="status">Your session expired. Sign in again to continue.</p>}
        <form className="login-form" onSubmit={submit}>
          <label>Email<input name="email" type="email" maxLength={254} autoComplete="username" required /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={128} required /></label>
          {problem && <p className="inline-alert" role="alert">{problem}</p>}
          <button type="submit" className="button primary" disabled={sending}>{sending ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </div>
      <div className="access-footer"><AppearanceControl appearance={appearance} /></div>
    </div>
  </main>
}

function AccessStatus({ children }: { children: ReactNode }) {
  return <main className="access-layout"><div className="access-panel">
    <div className="access-brand"><Brand /></div>
    {children}
  </div></main>
}

function PrivateApp({ session, appearance, checking, checkError, endSession, revoke, recheck }: {
  revoke: () => void; recheck: () => void
  session: Session; appearance: Appearance; checking: boolean; checkError?: unknown; endSession: (expired: boolean) => void
}) {
  const [signingOut, setSigningOut] = useState(false)
  const [signOutProblem, setSignOutProblem] = useState('')
  const lastVerifiedSession = useRef(session)
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, networkMode: 'always', refetchOnWindowFocus: false } },
    mutationCache: new MutationCache({ onError: error => {
      if (error instanceof ApiError && error.status === 401) endSession(true)
    } }),
    queryCache: new QueryCache({
      onError: error => {
        if (error instanceof ApiError && error.status === 401) endSession(true)
      },
    }),
  }))

  useEffect(() => () => client.clear(), [client])
  useEffect(() => {
    if (lastVerifiedSession.current === session) return
    lastVerifiedSession.current = session
    void client.invalidateQueries()
  }, [client, session])

  async function leave() {
    if (signingOut) return
    revoke()
    setSigningOut(true)
    setSignOutProblem('')
    try {
      await signOut()
      endSession(false)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) endSession(false)
      else {
        setSignOutProblem('Couldn’t sign out. Try again.')
        recheck()
      }
    } finally {
      setSigningOut(false)
    }
  }
  const accountAction = <div className="account-action">
    <button type="button" className="button rail-button" onClick={() => void leave()} disabled={signingOut}>
      <LogOut size={16} aria-hidden="true" />{signingOut ? 'Signing out…' : 'Sign out'}
    </button>
    {signOutProblem && <p role="alert">{signOutProblem}</p>}
  </div>

  return <QueryClientProvider client={client}>
    <Activity mode={checking ? 'hidden' : 'visible'}>
      <Workspace session={session} appearance={appearance} accountAction={accountAction} />
    </Activity>
    {checking && <AccessStatus>{checkError !== undefined
      ? <Problem resource="your session" error={checkError} retry={recheck} />
      : <Loading>Checking your session…</Loading>}</AccessStatus>}
  </QueryClientProvider>
}

export function App() {
  const appearance = useAppearance()
  const navigate = useNavigate()
  const location = useLocation()
  const [access, setAccess] = useState<Access>({ kind: 'loading' })
  const principal = useRef<string | null>(null)
  const pendingCheck = useRef<AbortController | null>(null)
  const verified = useRef<AbortController | null>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const authorized = access.kind === 'authorized'
  const checking = access.kind === 'checking'

  const cancelCheck = useCallback(() => {
    verified.current?.abort()
    verified.current = null
    pendingCheck.current?.abort()
    pendingCheck.current = null
  }, [])

  const checkSession = useCallback(() => {
    if (document.visibilityState !== 'visible' || pendingCheck.current) return
    const controller = new AbortController()
    pendingCheck.current = controller
    setAccess(current => current.kind === 'checking' && current.error
      ? { kind: 'checking', session: current.session } : current)
    void getSession(controller.signal).then(session => {
      if (controller.signal.aborted) return
      verified.current = controller
      const key = sessionKey(session)
      const changed = principal.current !== null && principal.current !== key
      principal.current = key
      if (changed) restoreFocus.current = null
      setAccess({ kind: changed ? 'resetting' : 'authorized', session })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      if (!(error instanceof ApiError) || error.status >= 500 || [408, 429].includes(error.status)) {
        setAccess(current => current.kind === 'checking' ? { ...current, error } : { kind: 'problem', error })
        return
      }
      restoreFocus.current = null
      setAccess(error instanceof ApiError && error.status === 401
        ? { kind: 'anonymous', expired: principal.current !== null } : { kind: 'problem', error })
    }).finally(() => {
      if (pendingCheck.current === controller) pendingCheck.current = null
    })
  }, [])

  useEffect(() => {
    checkSession()
    return cancelCheck
  }, [checkSession, cancelCheck])

  useEffect(() => {
    if (!authorized && !checking && access.kind !== 'loading') return
    function hideWorkspace() {
      verified.current?.abort()
      const focused = document.activeElement
      if (!restoreFocus.current && focused instanceof HTMLElement) restoreFocus.current = focused
      setAccess(current => current.kind === 'authorized' ? { kind: 'checking', session: current.session } : current)
    }
    function refresh() {
      hideWorkspace()
      checkSession()
    }
    function deactivate() {
      cancelCheck()
      hideWorkspace()
    }
    function visibilityChanged() {
      if (document.visibilityState === 'visible') refresh()
      else deactivate()
    }
    window.addEventListener('blur', deactivate)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      window.removeEventListener('blur', deactivate)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [authorized, checking, access.kind, checkSession, cancelCheck])

  useEffect(() => {
    if (!authorized || !restoreFocus.current) return
    const target = restoreFocus.current
    restoreFocus.current = null
    const frame = requestAnimationFrame(() => {
      if (target.isConnected) target.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [authorized])

  useEffect(() => {
    if (access.kind !== 'resetting') return
    if (location.pathname === '/' && !location.search && !location.hash) {
      setAccess({ kind: 'authorized', session: access.session })
    } else {
      void navigate('/', { replace: true })
    }
  }, [access, location, navigate])

  function reloadSession() {
    cancelCheck()
    setAccess({ kind: 'loading' })
    checkSession()
  }

  if (access.kind === 'authorized' || access.kind === 'checking') {
    const key = sessionKey(access.session)
    return <PrivateApp key={key} session={access.session} appearance={appearance} checking={checking} checkError={access.kind === 'checking' ? access.error : undefined} revoke={cancelCheck} recheck={checkSession} endSession={expired => {
      if (principal.current !== key || (expired && pendingCheck.current)) return
      cancelCheck()
      restoreFocus.current = null
      setAccess({ kind: 'anonymous', expired })
      if (!expired) {
        principal.current = null
        void navigate('/', { replace: true })
      }
    }} />
  }
  if (access.kind === 'anonymous') {
    return <Login appearance={appearance} expired={access.expired} onSignedIn={reloadSession} />
  }
  return <AccessStatus>
    {access.kind === 'problem' ? <Problem resource="your session" error={access.error} retry={reloadSession} />
      : <Loading>Checking your session…</Loading>}
  </AccessStatus>
}
