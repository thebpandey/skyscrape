import {
  Activity, ArrowRight, Boxes, CalendarDays, ChevronRight, CircleHelp, Database,
  Download, FlaskConical, LayoutGrid, LockKeyhole, Menu, Search, Settings2, Table2, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { Activity as SessionActivity, useEffect, useRef, useState } from 'react'
import type { FormEvent, MouseEvent, ReactNode } from 'react'
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router'
import { Message, Problem } from '../components/states'
import { AppearanceControl } from '../components/theme'
import type { Appearance } from '../components/theme'
import { ApiError, can } from '../lib/api'
import type { Session } from '../lib/api'
import { Brand } from '../components/brand'
import { Campaigns } from './campaigns'
import { Run } from './run'
import { ChatGPTSettings } from './chatgpt-settings'
import { Register } from './register'
import { Overview, Research } from './analyst-pages'
import { WorkspaceHelp } from './workspace-help'
import { OperationalPage } from './operational-pages'

type Page = {
  title: string
  path: string
  Icon: LucideIcon
  allowed?: (session: Session) => boolean
}

const pages: readonly Page[] = [
  { title: 'Overview', path: '/overview', Icon: LayoutGrid, allowed: session => can(session, 'analytics:read') },
  { title: 'Campaigns', path: '/campaigns', Icon: CalendarDays, allowed: session => can(session, 'runs:read') },
  { title: 'Records', path: '/records', Icon: Table2, allowed: session => can(session, 'records:read') },
  { title: 'Research', path: '/research', Icon: FlaskConical, allowed: session => can(session, 'research:create') },
  { title: 'Sources', path: '/sources', Icon: Database, allowed: session => can(session, 'sources:read') },
  { title: 'Issues', path: '/issues', Icon: Activity, allowed: session => can(session, 'issues:read') },
  { title: 'Exports', path: '/exports', Icon: Download, allowed: session => can(session, 'exports:read') },
  { title: 'Help', path: '/help', Icon: CircleHelp },
  { title: 'Settings', path: '/settings', Icon: Settings2, allowed: session => session.chatgptSettings === true },
  { title: 'Admin', path: '/admin', Icon: Settings2, allowed: session => session.role === 'admin' },
]

function RailContents({ pages, session, appearance, accountAction, onNavigate }: {
  pages: readonly Page[]; session: Session; appearance: Appearance; accountAction: ReactNode; onNavigate?: () => void
}) {
  return <>
    <nav className="workspace-nav" aria-label="Workspace">
      {pages.map(({ title, path, Icon }) => <NavLink key={path} to={path} onClick={onNavigate}>
        <Icon size={17} aria-hidden="true" />{title}
      </NavLink>)}
    </nav>
    <div className="rail-footer">
      <AppearanceControl appearance={appearance} />
      <div className="profile"><span className="avatar"><LockKeyhole size={16} aria-hidden="true" /></span>
        <div><strong>{session.role[0].toUpperCase() + session.role.slice(1)}</strong><small>Private workspace</small></div>
      </div>
      {accountAction}
    </div>
  </>
}

function Unavailable({ page, session }: { page: Page; session: Session }) {
  return <div className="page">
    <h1>{page.title}</h1>
    {page.allowed?.(session) === false
      ? <Problem resource={page.title.toLowerCase()} error={new ApiError(403)} />
      : <Message title="Unavailable">{page.title} is unavailable in this workspace.</Message>}
  </div>
}

export function Workspace({ session, appearance, accountAction, checking, sessionNotice }: {
  session: Session; appearance: Appearance; accountAction: ReactNode; checking: boolean; sessionNotice: ReactNode
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const main = useRef<HTMLElement>(null)
  const skipMain = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    main.current?.focus()
    main.current?.scrollIntoView()
  }
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const permitSearch = useRef<HTMLInputElement>(null)
  const visiblePages = pages.filter(page => page.allowed?.(session) !== false)
  const currentPage = pages.find(page => location.pathname === page.path || location.pathname.startsWith(page.path + '/'))
  const searchRecords = can(session, 'records:read')
  const primaryPath = searchRecords ? '/records' : '/help'
  useEffect(() => {
    if (checking) return
    function onKey(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'k') return
      if (document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [checking])
  useEffect(() => {
    document.title = (currentPage?.path === '/records' ? 'Permit Register' : currentPage?.title ?? 'Workspace') + ' · SkyScrape'
  }, [currentPage])

  function openPath(path: string) {
    setSearchOpen(false)
    void navigate(path)
    requestAnimationFrame(() => main.current?.focus())
  }

  function openPermit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const number = String(new FormData(event.currentTarget).get('permitNumber')).trim()
    if (number.length === 0) return
    openPath('/records?' + new URLSearchParams({ permitNumber: number }))
  }

  return <div className="app-shell">
    <a href="#main" className="skip-link" onClick={skipMain}>Skip to main content</a>
    <aside className="rail desktop-rail" inert={checking} aria-hidden={checking || undefined}><Brand />
      <RailContents pages={visiblePages} session={session} appearance={appearance} accountAction={accountAction} />
    </aside>
    <div className="workspace">
      <header className="workspace-top" inert={checking} aria-hidden={checking || undefined}>
        <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <div className="mobile-bar"><Brand />
            <Dialog.Trigger className="button rail-button" aria-label="Open navigation"><Menu size={19} aria-hidden="true" /></Dialog.Trigger>
          </div>
          <SessionActivity mode={checking ? 'hidden' : 'visible'}><Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="rail mobile-menu">
              <header className="menu-header"><Dialog.Title>Workspace</Dialog.Title>
                <Dialog.Close className="button rail-button" aria-label="Close navigation"><X size={18} aria-hidden="true" /></Dialog.Close></header>
              <Dialog.Description className="sr-only">Navigate to a workspace area or change appearance.</Dialog.Description>
              <RailContents pages={visiblePages} session={session} appearance={appearance} accountAction={accountAction}
                onNavigate={() => {
                  setMenuOpen(false)
                  requestAnimationFrame(() => main.current?.focus())
                }} />
            </Dialog.Content>
          </Dialog.Portal></SessionActivity>
        </Dialog.Root>
        <div className="topbar">
          <div className="breadcrumbs">
            {currentPage?.path === '/records' ? <>Records <ChevronRight size={13} aria-hidden="true" /><strong>Permits</strong></>
              : <><Boxes size={16} aria-hidden="true" /><strong>{currentPage?.title ?? 'Workspace'}</strong></>}
          </div>
          <Dialog.Root open={searchOpen} onOpenChange={setSearchOpen}>
            <Dialog.Trigger className="button global-search">
              <Search size={16} aria-hidden="true" /><span>Search workspace</span><kbd>Ctrl / ⌘ K</kbd>
            </Dialog.Trigger>
            <SessionActivity mode={checking ? 'hidden' : 'visible'}><Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="dialog-sheet command-sheet" onOpenAutoFocus={event => {
                if (!permitSearch.current) return
                event.preventDefault()
                permitSearch.current.focus()
              }}>
                <header className="dialog-header"><Dialog.Title>Search workspace</Dialog.Title>
                  <Dialog.Close className="icon-button" aria-label="Close workspace search"><X size={19} aria-hidden="true" /></Dialog.Close>
                </header>
                <Dialog.Description className="sr-only">Find a permit or open a workspace area.</Dialog.Description>
                {searchRecords && <form className="command-form" onSubmit={openPermit}>
                  <label>Exact permit number<input name="permitNumber" type="search" maxLength={256} required ref={permitSearch} /></label>
                  <button className="button primary" type="submit">Find permit</button>
                </form>}
                <ul className="command-pages">
                  {visiblePages.map(({ title, path, Icon }) => <li key={path}>
                    <button type="button" onClick={() => openPath(path)}>
                      <Icon size={17} aria-hidden="true" />{title}<ArrowRight size={16} aria-hidden="true" />
                    </button>
                  </li>)}
                </ul>
              </Dialog.Content>
            </Dialog.Portal></SessionActivity>
          </Dialog.Root>
        </div>
      </header>
      <main id="main" tabIndex={-1} ref={main}>
        {checking && <div className="page">{sessionNotice}</div>}
        <SessionActivity mode={checking ? 'hidden' : 'visible'}><Routes>
          <Route path="/" element={<Navigate to={primaryPath} replace />} />
          <Route path="/records/*" element={searchRecords ? <Register session={session} />
            : <Unavailable page={{ title: 'Records', path: '/records', Icon: Table2, allowed: () => false }} session={session} />} />
          <Route path="/campaigns/*" element={can(session, 'runs:read') ? <Campaigns session={session} />
            : <Problem resource="campaigns" error={new ApiError(403)} />} />
          <Route path="/settings" element={session.chatgptSettings ? <ChatGPTSettings /> : <Problem resource="settings" error={new ApiError(403)} />} />
          <Route path="/overview" element={can(session, 'analytics:read') ? <Overview session={session} />
            : <Problem resource="overview" error={new ApiError(403)} />} />
          <Route path="/research" element={can(session, 'research:create') ? <Research session={session} />
            : <Problem resource="research" error={new ApiError(403)} />} />
          <Route path="/help" element={<WorkspaceHelp session={session} />} />
          {(['sources', 'issues', 'exports'] as const).map(page =>
            <Route key={page} path={'/' + page} element={can(session, `${page}:read`)
              ? <OperationalPage page={page} session={session} /> : <Problem resource={page} error={new ApiError(403)} />} />)}
          {pages.filter(page => page.path === '/admin').map(page =>
            <Route key={page.path} path={page.path + '/*'} element={<Unavailable page={page} session={session} />} />)}
          <Route path="/runs/:id" element={can(session, 'runs:read') ? <Run session={session} />
            : <Problem resource="run" error={new ApiError(403)} />} />
          <Route path="*" element={<div className="page"><h1>Page not found</h1><NavLink to={primaryPath} className="button">Return to workspace</NavLink></div>} />
        </Routes></SessionActivity>
      </main>
    </div>
  </div>
}
