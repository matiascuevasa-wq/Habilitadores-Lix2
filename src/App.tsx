import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from './supabase'

// ── Types ─────────────────────────────────────────────────────────────────────
type Rol = 'admin' | 'editor' | 'viewer'
type TaskStatus = 'todo' | 'prog' | 'done'

interface Project { id: string; name: string; color: string }
interface Stage   { id: string; pid: string; name: string; order: number }
interface Person  { id: string; name: string }
interface Task {
  id: string; pid: string; sid: string | null; name: string; owner: string
  start_date: string | null; end_date: string | null
  real_start: string | null; real_end: string | null
  hh_prog: number; hh_real: number; pct: number; status: TaskStatus; deps: string[]
}
interface OrgNode { id: string; pid: string; node_key: string; x: number; y: number }
interface OrgEdge { id: string; pid: string; from_key: string; to_key: string }
interface OrgCheck { id: string; tid: string; sid: string; done: boolean }

// ── Constants ─────────────────────────────────────────────────────────────────
const DAY_W = 18
const COLORS = {
  bg: '#0f1117', bg2: '#181c27', bg3: '#1e2333', bg4: '#252b3b',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.13)',
  text: '#e8eaf0', text2: '#8b91a8', text3: '#5a6070',
  accent: '#4f8ef7', green: '#3ecf8e', amber: '#f59e0b', red: '#ef4444'
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const parseDate = (s: string | null) => s ? new Date(s + 'T12:00:00') : null
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86400000)
const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r }
const fmtDate = (d: Date | null) => d ? d.toISOString().slice(0, 10) : ''
const todayDate = () => new Date()
const pctColor = (p: number) => p >= 100 ? COLORS.green : p >= 60 ? COLORS.accent : p >= 30 ? COLORS.amber : COLORS.red
const nodeKey = (name: string) => { let h = 0; for (const c of name) h = Math.imul(31, h) + c.charCodeAt(0) | 0; return 'grp_' + Math.abs(h).toString(36) }
const expectedPct = (t: Task) => {
  if (!t.start_date || !t.end_date) return 0
  const s = parseDate(t.start_date)!, e = parseDate(t.end_date)!, now = todayDate()
  if (now <= s) return 0; if (now >= e) return 100
  return Math.round(daysBetween(s, now) / daysBetween(s, e) * 100)
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  // Auth
  const [user, setUser] = useState<any>(null)
  const [rol, setRol] = useState<Rol | null>(null)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authEmail, setAuthEmail] = useState('')
  const [authPass, setAuthPass] = useState('')
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)

  // Data
  const [projects, setProjects] = useState<Project[]>([])
  const [stages, setStages] = useState<Stage[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [persons, setPersons] = useState<Person[]>([])
  const [orgNodes, setOrgNodes] = useState<OrgNode[]>([])
  const [orgEdges, setOrgEdges] = useState<OrgEdge[]>([])
  const [orgChecks, setOrgChecks] = useState<OrgCheck[]>([])
  const [loading, setLoading] = useState(true)
  const [allUsers, setAllUsers] = useState<{ user_id: string; email: string; rol: Rol | null }[]>([])

  // UI state
  const [activeProj, setActiveProj] = useState<string | null>(null)
  const [currentTab, setCurrentTab] = useState('gantt')
  const [collapseState, setCollapseState] = useState<Record<string, boolean>>({})
  const [ganttZoom, setGanttZoom] = useState('project')
  const [ganttCustomStart, setGanttCustomStart] = useState('')
  const [ganttCustomEnd, setGanttCustomEnd] = useState('')
  const [showDates, setShowDates] = useState(false)
  const [ctrlFilterPid, setCtrlFilterPid] = useState<string | null>(null)
  const [modal, setModal] = useState<any>(null)
  const [orgConnecting, setOrgConnecting] = useState<string | null>(null)

  // ── Auth ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }: any) => {
      setUser(session?.user ?? null)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_: any, session: any) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!user) { setRol(null); return }
    supabase.from('usuarios_roles').select('rol').eq('user_id', user.id).single()
      .then(({ data }: any) => setRol(data?.rol ?? 'viewer'))
  }, [user])

  useEffect(() => { if (user && rol) loadAll() }, [user, rol])

  const handleAuth = async () => {
    setAuthLoading(true); setAuthError('')
    try {
      if (authMode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPass })
        if (error) setAuthError(error.message)
      } else {
        const { data, error } = await supabase.auth.signUp({ email: authEmail, password: authPass })
        if (error) { setAuthError(error.message); return }
        // Insert viewer role immediately
        if (data.user) {
          await supabase.from('usuarios_roles').insert({ user_id: data.user.id, email: authEmail, rol: 'viewer' })
          await supabase.auth.signOut()
        }
        setAuthError('✓ Cuenta creada. Ya puedes iniciar sesión.')
        setAuthMode('login')
      }
    } finally { setAuthLoading(false) }
  }

  const handleLogout = () => supabase.auth.signOut()

  // ── Data loading ────────────────────────────────────────────────────────────
  const loadAll = async () => {
    setLoading(true)
    const [p, s, t, pe, on, oe, oc, ur] = await Promise.all([
      supabase.from('projects').select('*').order('creado_en'),
      supabase.from('stages').select('*').order('order'),
      supabase.from('tasks').select('*').order('creado_en'),
      supabase.from('persons').select('*').order('name'),
      supabase.from('org_nodes').select('*'),
      supabase.from('org_edges').select('*'),
      supabase.from('org_checks').select('*'),
      supabase.from('usuarios_roles').select('*').order('creado_en'),
    ])
    setProjects(p.data || [])
    setStages(s.data || [])
    setTasks((t.data || []).map((x: any) => ({ ...x, deps: x.deps || [] })))
    setPersons(pe.data || [])
    setOrgNodes(on.data || [])
    setOrgEdges(oe.data || [])
    setOrgChecks(oc.data || [])
    setAllUsers((ur.data || []).map((r: any) => ({ user_id: r.user_id, email: r.email, rol: r.rol })))
    setLoading(false)
  }

  const canEdit = rol === 'admin' || rol === 'editor'
  const isAdmin = rol === 'admin'

  // ── CRUD helpers ─────────────────────────────────────────────────────────────
  const upsertProject = async (data: Partial<Project>) => {
    if (!isAdmin) return
    if (data.id) {
      await supabase.from('projects').update(data).eq('id', data.id)
      setProjects(prev => prev.map(p => p.id === data.id ? { ...p, ...data } : p))
    } else {
      const { data: row } = await supabase.from('projects').insert(data).select().single()
      if (row) setProjects(prev => [...prev, row])
    }
  }

  const deleteProject = async (id: string) => {
    if (!isAdmin || !confirm('¿Eliminar este proyecto y todas sus tareas?')) return
    await supabase.from('projects').delete().eq('id', id)
    setProjects(prev => prev.filter(p => p.id !== id))
    setTasks(prev => prev.filter(t => t.pid !== id))
    setStages(prev => prev.filter(s => s.pid !== id))
    if (activeProj === id) setActiveProj(null)
  }

  const upsertStage = async (data: Partial<Stage>) => {
    if (!canEdit) return
    if (data.id) {
      await supabase.from('stages').update(data).eq('id', data.id)
      setStages(prev => prev.map(s => s.id === data.id ? { ...s, ...data } : s))
    } else {
      const { data: row } = await supabase.from('stages').insert(data).select().single()
      if (row) setStages(prev => [...prev, row])
    }
  }

  const deleteStage = async (id: string) => {
    if (!isAdmin) return
    await supabase.from('stages').delete().eq('id', id)
    setStages(prev => prev.filter(s => s.id !== id))
    setTasks(prev => prev.map(t => t.sid === id ? { ...t, sid: null } : t))
    await supabase.from('tasks').update({ sid: null }).eq('sid', id)
  }

  const upsertTask = async (data: Partial<Task>) => {
    if (!canEdit) return
    if (data.id) {
      const { id, ...rest } = data
      await supabase.from('tasks').update(rest).eq('id', id)
      setTasks(prev => prev.map(t => t.id === id ? { ...t, ...rest } : t))
    } else {
      const { data: row } = await supabase.from('tasks').insert(data).select().single()
      if (row) setTasks(prev => [...prev, { ...row, deps: row.deps || [] }])
    }
  }

  const deleteTask = async (id: string) => {
    if (!canEdit) return
    await supabase.from('tasks').delete().eq('id', id)
    setTasks(prev => prev.filter(t => t.id !== id))
  }

  const upsertPerson = async (name: string) => {
    if (!isAdmin) return
    const { data: row } = await supabase.from('persons').insert({ name }).select().single()
    if (row) setPersons(prev => [...prev, row])
  }

  const deletePerson = async (id: string) => {
    if (!isAdmin) return
    await supabase.from('persons').delete().eq('id', id)
    setPersons(prev => prev.filter(p => p.id !== id))
  }

  const setUserRol = async (user_id: string, email: string, newRol: Rol | null) => {
    if (!isAdmin) return
    const existing = allUsers.find(u => u.user_id === user_id)
    if (newRol === null) {
      await supabase.from('usuarios_roles').delete().eq('user_id', user_id)
      setAllUsers(prev => prev.map(u => u.user_id === user_id ? { ...u, rol: null } : u))
    } else if (existing?.rol) {
      await supabase.from('usuarios_roles').update({ rol: newRol }).eq('user_id', user_id)
      setAllUsers(prev => prev.map(u => u.user_id === user_id ? { ...u, rol: newRol } : u))
    } else {
      await supabase.from('usuarios_roles').insert({ user_id, email, rol: newRol })
      setAllUsers(prev => prev.map(u => u.user_id === user_id ? { ...u, rol: newRol } : u))
    }
  }

  // ── Derived helpers ──────────────────────────────────────────────────────────
  const projectTasks = (pid: string) => tasks.filter(t => t.pid === pid)
  const stageTasks = (sid: string, pid: string) => tasks.filter(t => t.pid === pid && t.sid === sid)
  const projectStages = (pid: string) => stages.filter(s => s.pid === pid).sort((a, b) => a.order - b.order)
  const getTask = (id: string) => tasks.find(t => t.id === id)
  const getProject = (id: string) => projects.find(p => p.id === id)
  const getStage = (id: string) => stages.find(s => s.id === id)
  const filteredTasks = () => activeProj ? tasks.filter(t => t.pid === activeProj) : tasks

  const taskStatus = (t: Task) => {
    if (t.status === 'done') return 'done'
    if (t.status === 'prog') return t.end_date && todayDate() > parseDate(t.end_date)! ? 'late' : 'prog'
    return 'todo'
  }

  const badgeStyle = (t: Task) => {
    const s = taskStatus(t)
    const map: any = { done: { bg: 'rgba(62,207,142,.15)', color: COLORS.green, label: 'Completado' }, prog: { bg: 'rgba(79,142,247,.15)', color: COLORS.accent, label: 'En curso' }, late: { bg: 'rgba(239,68,68,.15)', color: COLORS.red, label: 'Atrasado' }, todo: { bg: 'rgba(255,255,255,.06)', color: COLORS.text3, label: 'Pendiente' } }
    return map[s]
  }

  // ── Gantt range ──────────────────────────────────────────────────────────────
  const ganttRange = useCallback(() => {
    const t0 = todayDate()
    if (ganttZoom === 'week') return { min: addDays(t0, -1), max: addDays(t0, 13) }
    if (ganttZoom === 'month') return { min: addDays(t0, -3), max: addDays(t0, 33) }
    if (ganttZoom === 'quarter') return { min: addDays(t0, -7), max: addDays(t0, 83) }
    if (ganttZoom === 'custom' && ganttCustomStart && ganttCustomEnd)
      return { min: parseDate(ganttCustomStart)!, max: parseDate(ganttCustomEnd)! }
    const ft = filteredTasks()
    const dates: Date[] = [t0]
    ft.forEach(t => {
      if (t.start_date) dates.push(parseDate(t.start_date)!)
      if (t.end_date) dates.push(parseDate(t.end_date)!)
      if (t.real_start) dates.push(parseDate(t.real_start)!)
      if (t.real_end) dates.push(parseDate(t.real_end)!)
    })
    const min = new Date(Math.min(...dates.map(d => d.getTime())))
    const max = new Date(Math.max(...dates.map(d => d.getTime())))
    min.setDate(min.getDate() - 5); max.setDate(max.getDate() + 10)
    return { min, max }
  }, [ganttZoom, ganttCustomStart, ganttCustomEnd, tasks, activeProj])

  const toggleCollapse = (id: string) => setCollapseState(prev => ({ ...prev, [id]: !prev[id] }))

  // ── Org helpers ──────────────────────────────────────────────────────────────
  const orgSaveNode = async (pid: string, nk: string, x: number, y: number) => {
    const existing = orgNodes.find(n => n.pid === pid && n.node_key === nk)
    if (existing) {
      await supabase.from('org_nodes').update({ x, y }).eq('id', existing.id)
      setOrgNodes(prev => prev.map(n => n.id === existing.id ? { ...n, x, y } : n))
    } else {
      const { data: row } = await supabase.from('org_nodes').insert({ pid, node_key: nk, x, y }).select().single()
      if (row) setOrgNodes(prev => [...prev, row])
    }
  }

  const orgAddEdge = async (pid: string, from_key: string, to_key: string) => {
    const exists = orgEdges.some(e => e.pid === pid && e.from_key === from_key && e.to_key === to_key)
    if (exists) return
    const { data: row } = await supabase.from('org_edges').insert({ pid, from_key, to_key }).select().single()
    if (row) setOrgEdges(prev => [...prev, row])
  }

  const orgDeleteEdge = async (id: string) => {
    await supabase.from('org_edges').delete().eq('id', id)
    setOrgEdges(prev => prev.filter(e => e.id !== id))
  }

  const orgToggleCheck = async (tid: string, sid: string) => {
    const existing = orgChecks.find(c => c.tid === tid && c.sid === sid)
    if (existing) {
      const newDone = !existing.done
      await supabase.from('org_checks').update({ done: newDone }).eq('id', existing.id)
      setOrgChecks(prev => prev.map(c => c.id === existing.id ? { ...c, done: newDone } : c))
    } else {
      const { data: row } = await supabase.from('org_checks').insert({ tid, sid, done: true }).select().single()
      if (row) setOrgChecks(prev => [...prev, row])
    }
  }

  // ── Duplicate stage ──────────────────────────────────────────────────────────
  const duplicateStage = async (fromSid: string, fromPid: string, toSid: string, toPid: string) => {
    const src = stageTasks(fromSid, fromPid)
    for (const t of src) {
      const exists = tasks.some(x => x.name === t.name && x.sid === toSid && x.pid === toPid)
      if (!exists) await upsertTask({ pid: toPid, sid: toSid, name: t.name, owner: t.owner, hh_prog: t.hh_prog, hh_real: 0, pct: 0, status: 'todo', deps: [], start_date: t.start_date, end_date: t.end_date, real_start: null, real_end: null })
    }
    setModal(null)
  }

  // ── AUTH SCREEN ──────────────────────────────────────────────────────────────
  if (!user) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: COLORS.bg, fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <div style={{ background: COLORS.bg2, border: `1px solid ${COLORS.border2}`, borderRadius: 12, padding: 32, width: 360 }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", color: COLORS.accent, fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 20 }}>Gestión de Proyectos</div>
        <h2 style={{ color: COLORS.text, fontSize: 18, marginBottom: 24 }}>{authMode === 'login' ? 'Iniciar sesión' : 'Registrarse'}</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="Email" type="email" style={inputStyle} />
          <input value={authPass} onChange={e => setAuthPass(e.target.value)} placeholder="Contraseña" type="password" style={inputStyle} onKeyDown={e => e.key === 'Enter' && handleAuth()} />
          {authError && <div style={{ fontSize: 12, color: authError.includes('email') ? COLORS.green : COLORS.red }}>{authError}</div>}
          <button onClick={handleAuth} disabled={authLoading} style={{ ...btnStyle('primary'), marginTop: 4 }}>
            {authLoading ? 'Cargando...' : authMode === 'login' ? 'Entrar' : 'Registrarse'}
          </button>
          <button onClick={() => setAuthMode(m => m === 'login' ? 'register' : 'login')} style={{ background: 'none', border: 'none', color: COLORS.accent, fontSize: 12, cursor: 'pointer', textAlign: 'center' }}>
            {authMode === 'login' ? '¿No tienes cuenta? Registrarse' : '¿Ya tienes cuenta? Iniciar sesión'}
          </button>
        </div>
      </div>
    </div>
  )

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: COLORS.bg, color: COLORS.text3, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>
      Cargando datos...
    </div>
  )

  if (!rol) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: COLORS.bg, fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <div style={{ background: COLORS.bg2, border: `1px solid ${COLORS.border2}`, borderRadius: 12, padding: 32, width: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 16 }}>⏳</div>
        <h2 style={{ color: COLORS.text, fontSize: 16, marginBottom: 10 }}>Acceso pendiente</h2>
        <p style={{ color: COLORS.text2, fontSize: 13, marginBottom: 20, lineHeight: 1.5 }}>
          Tu cuenta fue creada correctamente.<br />
          Un administrador debe asignarte un rol para que puedas acceder.
        </p>
        <div style={{ fontSize: 11, fontFamily: 'monospace', color: COLORS.text3, background: COLORS.bg3, padding: '8px 12px', borderRadius: 6, marginBottom: 20 }}>{user.email}</div>
        <button onClick={handleLogout} style={{ ...btnStyle('sm'), width: '100%' }}>Cerrar sesión</button>
      </div>
    </div>
  )

  // ── MAIN LAYOUT ──────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: "'IBM Plex Sans', sans-serif", background: COLORS.bg, color: COLORS.text, fontSize: 13 }}>
      {/* Sidebar */}
      <div style={{ width: 220, flexShrink: 0, background: COLORS.bg2, borderRight: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '16px 14px 10px', borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", color: COLORS.accent, fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Carta Gantt</div>
          <div style={{ fontSize: 10, color: COLORS.text3, marginTop: 4 }}>{user.email} · <span style={{ color: COLORS.amber }}>{rol}</span></div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          <SidebarItem active={!activeProj} onClick={() => setActiveProj(null)} color={COLORS.text3} label="Todos los proyectos" count={tasks.length} />
          <div style={{ padding: '4px 14px 2px', fontSize: 10, fontFamily: 'monospace', color: COLORS.text3, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 6 }}>Proyectos</div>
          {projects.map(p => (
            <SidebarItem key={p.id} active={activeProj === p.id} onClick={() => setActiveProj(p.id)} color={p.color} label={p.name} count={projectTasks(p.id).length}
              onDelete={isAdmin ? () => deleteProject(p.id) : undefined} />
          ))}
        </div>
        <div style={{ padding: '10px 14px', borderTop: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {isAdmin && <button style={btnStyle('sm')} onClick={() => setModal({ type: 'project' })}>+ Proyecto</button>}
          {isAdmin && <button style={btnStyle('sm')} onClick={() => setModal({ type: 'person' })}>+ Responsable</button>}
          <div style={{ borderTop: `1px solid ${COLORS.border}`, marginTop: 4, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <button style={btnStyle('sm')} onClick={handleLogout}>⎋ Cerrar sesión</button>
          </div>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', background: COLORS.bg2, borderBottom: `1px solid ${COLORS.border}`, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>
            {activeProj ? (() => { const p = getProject(activeProj); return p ? <><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: p.color, marginRight: 6 }} />{p.name}</> : 'Todos' })() : 'Todos los proyectos'}
          </div>
          <div style={{ display: 'flex', gap: 2, background: COLORS.bg3, borderRadius: 6, padding: 2 }}>
            {['gantt', 'hh', 'resumen', 'ctrl', 'org', ...(isAdmin ? ['usuarios'] : [])].map(tab => (
              <button key={tab} onClick={() => setCurrentTab(tab)} style={{ padding: '4px 10px', borderRadius: 4, border: 'none', fontSize: 12, cursor: 'pointer', background: currentTab === tab ? COLORS.bg : 'transparent', color: currentTab === tab ? COLORS.text : COLORS.text2, fontFamily: 'inherit' }}>
                {{ gantt: 'Gantt', hh: 'Control HH', resumen: 'Resumen', ctrl: 'Control Avance', org: 'Organigrama', usuarios: '👥 Usuarios' }[tab]}
              </button>
            ))}
          </div>
          {canEdit && <button style={btnStyle('primary')} onClick={() => setModal({ type: 'task' })}>+ Tarea</button>}
          {canEdit && activeProj && <button style={btnStyle('sm')} onClick={() => setModal({ type: 'stage', pid: activeProj })}>⧉ Etapas</button>}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {currentTab === 'gantt' && <GanttView />}
          {currentTab === 'hh' && <HHView />}
          {currentTab === 'resumen' && <ResumenView />}
          {currentTab === 'ctrl' && <CtrlView />}
          {currentTab === 'org' && <OrgView />}
          {currentTab === 'usuarios' && isAdmin && <UsuariosView />}
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', gap: 16, padding: '6px 16px', background: COLORS.bg2, borderTop: `1px solid ${COLORS.border}`, fontSize: 11, color: COLORS.text2, flexShrink: 0 }}>
          <LegendItem color="rgba(255,255,255,0.25)" label="Programado" />
          <LegendItem color={COLORS.accent} label="Real avance" />
          <LegendItem color={COLORS.green} label="Completado" />
          <LegendItem color={COLORS.red} label="Atrasado" />
        </div>
      </div>

      {/* Modals */}
      {modal && <ModalRoot />}
    </div>
  )

  // ── GANTT VIEW ───────────────────────────────────────────────────────────────
  function GanttView() {
    const { min, max } = ganttRange()
    const totalDays = daysBetween(min, max) + 1
    const totalW = totalDays * DAY_W
    const todayOffset = daysBetween(min, todayDate()) * DAY_W
    const bodyLeftRef = useRef<HTMLDivElement>(null)
    const bodyRightRef = useRef<HTMLDivElement>(null)
    const headerRightRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
      const bl = bodyLeftRef.current, br = bodyRightRef.current, hr = headerRightRef.current
      if (!bl || !br) return
      const syncLR = () => { br.scrollTop = bl.scrollTop }
      const syncRL = () => { bl.scrollTop = br.scrollTop; if (hr) hr.scrollLeft = br.scrollLeft }
      bl.addEventListener('scroll', syncLR)
      br.addEventListener('scroll', syncRL)
      br.scrollLeft = Math.max(0, todayOffset - 150)
      return () => { bl.removeEventListener('scroll', syncLR); br.removeEventListener('scroll', syncRL) }
    }, [ganttZoom, activeProj])

    // Build month/day headers
    const months: { label: string; days: number }[] = []
    let cur = new Date(min)
    while (cur <= max) {
      const label = cur.toLocaleDateString('es-CL', { month: 'short', year: '2-digit' })
      let days = 0
      const m = cur.getMonth(), y = cur.getFullYear()
      while (cur <= max && cur.getMonth() === m && cur.getFullYear() === y) { days++; cur = addDays(cur, 1) }
      months.push({ label, days })
    }
    const days: { d: Date; isWeekend: boolean }[] = []
    let d = new Date(min)
    while (d <= max) { days.push({ d: new Date(d), isWeekend: d.getDay() === 0 || d.getDay() === 6 }); d = addDays(d, 1) }

    const projs = activeProj ? projects.filter(p => p.id === activeProj) : projects
    const leftRows: React.ReactNode[] = []
    const rightRows: React.ReactNode[] = []

    projs.forEach(p => {
      const pt = projectTasks(p.id)
      if (!pt.length) return
      const isCollapsed = !!collapseState[p.id]
      const hhProg = pt.reduce((a, t) => a + t.hh_prog, 0)
      const hhReal = pt.reduce((a, t) => a + t.hh_real, 0)
      const projPct = pt.length ? Math.round(pt.reduce((a, t) => a + t.pct, 0) / pt.length) : 0

      leftRows.push(
        <div key={`ph_${p.id}`} onClick={() => toggleCollapse(p.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', height: 38, borderBottom: `1px solid ${COLORS.border}`, background: COLORS.bg3, cursor: 'pointer' }}>
          <span style={{ fontSize: 9, color: COLORS.text3, transition: 'transform 0.2s', transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}>▼</span>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0, display: 'inline-block' }} />
          <span style={{ flex: 1, fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
          <span style={{ fontSize: 10, fontFamily: 'monospace', color: pctColor(projPct) }}>{projPct}%</span>
          <span style={{ fontSize: 10, fontFamily: 'monospace', color: COLORS.text3 }}>{hhReal}/{hhProg}h</span>
        </div>
      )

      // Project bar
      let pMin: Date | null = null, pMax: Date | null = null, rMin: Date | null = null, rMax: Date | null = null
      pt.forEach(t => {
        if (t.start_date) { const td = parseDate(t.start_date)!; if (!pMin || td < pMin) pMin = td }
        if (t.end_date) { const td = parseDate(t.end_date)!; if (!pMax || td > pMax) pMax = td }
        if (t.real_start) { const td = parseDate(t.real_start)!; if (!rMin || td < rMin) rMin = td }
        const re = t.real_end ? parseDate(t.real_end) : t.real_start ? todayDate() : null
        if (re && (!rMax || re > rMax)) rMax = re
      })
      rightRows.push(
        <div key={`pb_${p.id}`} style={{ position: 'relative', height: 38, width: totalW, borderBottom: `1px solid ${COLORS.border}`, background: COLORS.bg3 }}>
          <div style={{ position: 'absolute', left: todayOffset, top: 0, bottom: 0, width: 1, background: 'rgba(239,68,68,0.5)', zIndex: 2 }} />
          {pMin && pMax && <div style={{ position: 'absolute', left: daysBetween(min, pMin) * DAY_W, top: 14, height: 6, width: daysBetween(pMin, pMax) * DAY_W + DAY_W, background: p.color, opacity: 0.3, borderRadius: 3 }} />}
          {rMin && rMax && <div style={{ position: 'absolute', left: daysBetween(min, rMin) * DAY_W, top: 22, height: 6, width: daysBetween(rMin, rMax) * DAY_W + DAY_W, background: p.color, opacity: 0.7, borderRadius: 3 }} />}
        </div>
      )

      if (!isCollapsed) {
        const pStages = projectStages(p.id)
        const stageIds = pStages.map(s => s.id)
        const unstaged = pt.filter(t => !t.sid || !stageIds.includes(t.sid))

        pStages.forEach(stage => {
          const st = stageTasks(stage.id, p.id)
          if (!st.length) return
          const isSC = !!collapseState[stage.id]
          const sPct = Math.round(st.reduce((a, t) => a + t.pct, 0) / st.length)
          const sHhP = st.reduce((a, t) => a + t.hh_prog, 0)
          const sHhR = st.reduce((a, t) => a + t.hh_real, 0)

          leftRows.push(
            <div key={`sh_${stage.id}`} onClick={() => toggleCollapse(stage.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px 5px 24px', background: 'rgba(255,255,255,0.03)', borderBottom: `1px solid ${COLORS.border}`, cursor: 'pointer' }}>
              <span style={{ fontSize: 9, color: COLORS.text3, transition: 'transform 0.2s', transform: isSC ? 'rotate(-90deg)' : 'none' }}>▼</span>
              <span style={{ flex: 1, fontSize: 11, fontFamily: 'monospace', color: COLORS.text2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{stage.name}</span>
              <span style={{ fontSize: 10, fontFamily: 'monospace', color: pctColor(sPct) }}>{sPct}%</span>
              <span style={{ fontSize: 10, fontFamily: 'monospace', color: COLORS.text3 }}>{sHhR}/{sHhP}h</span>
            </div>
          )
          // Stage bar
          let sMin: Date | null = null, sMax: Date | null = null
          st.forEach(t => {
            if (t.start_date) { const td = parseDate(t.start_date)!; if (!sMin || td < sMin) sMin = td }
            if (t.end_date) { const td = parseDate(t.end_date)!; if (!sMax || td > sMax) sMax = td }
          })
          rightRows.push(
            <div key={`sb_${stage.id}`} style={{ position: 'relative', height: 34, width: totalW, borderBottom: `1px solid ${COLORS.border}`, background: 'rgba(255,255,255,0.005)' }}>
              <div style={{ position: 'absolute', left: todayOffset, top: 0, bottom: 0, width: 1, background: 'rgba(239,68,68,0.4)', zIndex: 2 }} />
              {sMin && sMax && <div style={{ position: 'absolute', left: daysBetween(min, sMin) * DAY_W, top: 14, height: 4, width: daysBetween(sMin, sMax) * DAY_W + DAY_W, background: p.color, opacity: 0.2, borderRadius: 2 }} />}
            </div>
          )
          if (!isSC) st.forEach(t => renderTaskRow(t, p, min, totalW, todayOffset, leftRows, rightRows))
        })
        unstaged.forEach(t => renderTaskRow(t, p, min, totalW, todayOffset, leftRows, rightRows))
      }
    })

    const colW = { task: 180, owner: 110, hh: 80, status: 80, date: 78 }

    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Zoom bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', background: COLORS.bg2, borderBottom: `1px solid ${COLORS.border}`, flexWrap: 'wrap', flexShrink: 0 }}>
          <span style={{ fontSize: 10, fontFamily: 'monospace', color: COLORS.text3, marginRight: 2 }}>ZOOM</span>
          {(['week', 'month', 'quarter', 'project'] as const).map(z => (
            <button key={z} onClick={() => setGanttZoom(z)} style={{ padding: '2px 8px', borderRadius: 3, fontSize: 10, fontFamily: 'monospace', background: ganttZoom === z ? COLORS.accent : COLORS.bg3, border: `1px solid ${ganttZoom === z ? COLORS.accent : COLORS.border2}`, color: ganttZoom === z ? '#fff' : COLORS.text2, cursor: 'pointer' }}>
              {{ week: 'Semana', month: 'Mes', quarter: 'Trimestre', project: 'Proyecto' }[z]}
            </button>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
            <input type="date" value={ganttCustomStart} onChange={e => { setGanttCustomStart(e.target.value); setGanttZoom('custom') }} style={{ ...inputStyle, width: 120, padding: '2px 6px', fontSize: 10 }} />
            <span style={{ color: COLORS.text3 }}>→</span>
            <input type="date" value={ganttCustomEnd} onChange={e => { setGanttCustomEnd(e.target.value); setGanttZoom('custom') }} style={{ ...inputStyle, width: 120, padding: '2px 6px', fontSize: 10 }} />
          </div>
          <button style={btnStyle('sm')} onClick={() => setShowDates(s => !s)} title="Mostrar/ocultar columnas de fecha" data-active={showDates}>
            📅 Fechas
          </button>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Left panel */}
          <div style={{ width: 24 + colW.task + colW.owner + colW.hh + colW.status + (showDates ? colW.date * 4 : 0), flexShrink: 0, borderRight: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', padding: '0 12px', height: 56, borderBottom: `1px solid ${COLORS.border}`, background: COLORS.bg2, flexShrink: 0 }}>
              <ColHead w={colW.task}>Tarea</ColHead>
              <ColHead w={colW.owner}>Responsable</ColHead>
              <ColHead w={colW.hh}>% / HH</ColHead>
              {showDates && <><ColHead w={colW.date}>Ini.Plan</ColHead><ColHead w={colW.date}>Fin Plan</ColHead><ColHead w={colW.date}>Ini.Real</ColHead><ColHead w={colW.date}>Fin Real</ColHead></>}
              <ColHead w={colW.status}>Estado</ColHead>
            </div>
            <div ref={bodyLeftRef} style={{ overflowY: 'auto', flex: 1 }}>{leftRows}</div>
          </div>
          {/* Right panel */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div ref={headerRightRef} style={{ height: 56, borderBottom: `1px solid ${COLORS.border}`, background: COLORS.bg2, overflowX: 'hidden', flexShrink: 0, position: 'relative' }}>
              <div style={{ display: 'flex', position: 'absolute', top: 0, left: 0 }}>
                {months.map((m, i) => <div key={i} style={{ width: m.days * DAY_W, borderRight: `1px solid ${COLORS.border}`, padding: '6px 8px', fontSize: 10, fontFamily: 'monospace', color: COLORS.text2, flexShrink: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>{m.label}</div>)}
              </div>
              <div style={{ display: 'flex', position: 'absolute', bottom: 0, left: 0 }}>
                {days.map((d, i) => <div key={i} style={{ width: DAY_W, flexShrink: 0, textAlign: 'center', fontSize: 9, fontFamily: 'monospace', color: d.isWeekend ? COLORS.text3 : COLORS.text2, borderRight: `1px solid ${COLORS.border}`, background: d.isWeekend ? 'rgba(255,255,255,0.02)' : 'transparent', paddingBottom: 4 }}>{d.d.getDate()}</div>)}
              </div>
            </div>
            <div ref={bodyRightRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'auto' }}>{rightRows}</div>
          </div>
        </div>
      </div>
    )
  }

  function renderTaskRow(t: Task, p: Project, min: Date, totalW: number, todayOffset: number, leftRows: React.ReactNode[], rightRows: React.ReactNode[]) {
    const s = taskStatus(t)
    const pct = t.pct || 0
    const pc = pctColor(pct)
    const badge = badgeStyle(t)
    const todayStr = fmtDate(todayDate())
    const colW = { task: 180, owner: 110, hh: 80, status: 80, date: 78 }

    const DateCell = ({ field, val, isReal }: { field: keyof Task, val: string | null, isReal: boolean }) => {
      const [editing, setEditing] = useState(false)
      const [val2, setVal2] = useState(val || '')
      const display = val ? val : isReal ? '--' : 'TBD'
      const late = !isReal && field === 'end_date' && val && val < todayStr && s !== 'done'
      if (!canEdit) return <div style={{ width: colW.date, flexShrink: 0, fontSize: 10, fontFamily: 'monospace', color: late ? COLORS.red : val ? COLORS.text2 : COLORS.text3, padding: '2px 4px' }}>{display}</div>
      if (editing) return (
        <input type="date" value={val2} style={{ ...inputStyle, width: colW.date, fontSize: 10, padding: '1px 3px', flexShrink: 0 }} autoFocus
          onChange={e => setVal2(e.target.value)}
          onBlur={async () => { setEditing(false); await upsertTask({ id: t.id, [field]: val2 || null }) }}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setVal2(val || ''); setEditing(false) } }} />
      )
      return <div onClick={() => setEditing(true)} style={{ width: colW.date, flexShrink: 0, fontSize: 10, fontFamily: 'monospace', color: late ? COLORS.red : val ? COLORS.text2 : COLORS.text3, fontStyle: !val && !isReal ? 'italic' : 'normal', padding: '2px 4px', cursor: 'pointer', borderRadius: 3 }}>{display}</div>
    }

    leftRows.push(
      <div key={`tr_${t.id}`} onDoubleClick={() => canEdit && setModal({ type: 'task', task: t })} style={{ display: 'flex', alignItems: 'center', padding: '0 12px', height: 34, borderBottom: `1px solid ${COLORS.border}`, cursor: 'default' }}>
        <div style={{ width: colW.task, flexShrink: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }} title={t.name}>
          <span style={{ color: COLORS.text3, marginRight: 4 }}>└</span>{t.name}
        </div>
        <div style={{ width: colW.owner, flexShrink: 0, fontSize: 11, color: COLORS.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.owner || '—'}</div>
        <div style={{ width: colW.hh, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <span style={{ fontFamily: 'monospace', fontSize: 11, color: pc }}>{pct}%</span>
          <div style={{ width: 44, height: 3, background: COLORS.bg4, borderRadius: 2 }}><div style={{ width: `${pct}%`, height: '100%', background: pc, borderRadius: 2 }} /></div>
          <span style={{ fontFamily: 'monospace', fontSize: 10, color: COLORS.text3 }}>{t.hh_real}/{t.hh_prog}h</span>
        </div>
        {showDates && <><DateCell field="start_date" val={t.start_date} isReal={false} /><DateCell field="end_date" val={t.end_date} isReal={false} /><DateCell field="real_start" val={t.real_start} isReal={true} /><DateCell field="real_end" val={t.real_end} isReal={true} /></>}
        <div style={{ width: colW.status, flexShrink: 0, textAlign: 'right' }}>
          <span style={{ background: badge.bg, color: badge.color, fontSize: 10, fontFamily: 'monospace', padding: '2px 6px', borderRadius: 3 }}>{badge.label}</span>
        </div>
      </div>
    )

    let bars: React.ReactNode[] = [<div key="tl" style={{ position: 'absolute', left: todayOffset, top: 0, bottom: 0, width: 1, background: 'rgba(239,68,68,0.4)', zIndex: 2 }} />]
    if (t.start_date && t.end_date) {
      const pl = daysBetween(min, parseDate(t.start_date)!) * DAY_W
      const pw = Math.max(daysBetween(parseDate(t.start_date)!, parseDate(t.end_date)!) * DAY_W + DAY_W, DAY_W)
      bars.push(<div key="bp" style={{ position: 'absolute', left: pl, top: 12, height: 8, width: pw, background: p.color, opacity: 0.3, borderRadius: 3 }} />)
    }
    if (t.real_start) {
      const rs = parseDate(t.real_start)!
      const re = t.real_end ? parseDate(t.real_end)! : todayDate()
      const rl = daysBetween(min, rs) * DAY_W
      const rw = Math.max(daysBetween(rs, re) * DAY_W + DAY_W, DAY_W)
      const rc = s === 'done' ? COLORS.green : s === 'late' ? COLORS.red : p.color
      bars.push(<div key="br" style={{ position: 'absolute', left: rl, top: 20, height: 8, width: rw, background: rc, borderRadius: 3 }} />)
    }
    rightRows.push(<div key={`bar_${t.id}`} style={{ position: 'relative', height: 34, width: totalW, borderBottom: `1px solid ${COLORS.border}` }}>{bars}</div>)
  }

  // ── HH VIEW ──────────────────────────────────────────────────────────────────
  function HHView() {
    const ft = filteredTasks()
    const totProg = ft.reduce((a, t) => a + t.hh_prog, 0)
    const totReal = ft.reduce((a, t) => a + t.hh_real, 0)
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
          <StatCard val={`${totProg}h`} label="HH Programadas" />
          <StatCard val={`${totReal}h`} label="HH Reales" color={totReal > totProg ? COLORS.red : COLORS.green} />
          <StatCard val={`${totProg > 0 ? Math.round(totReal / totProg * 100) : 0}%`} label="Uso HH" color={pctColor(totProg > 0 ? Math.round(totReal / totProg * 100) : 0)} />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>{['Tarea', 'Proyecto', 'Etapa', 'HH Prog', 'HH Real', 'Δ', 'Avance'].map(h => <th key={h} style={{ fontSize: 10, fontFamily: 'monospace', color: COLORS.text3, textTransform: 'uppercase', padding: '6px 12px', textAlign: 'left', borderBottom: `1px solid ${COLORS.border}`, background: COLORS.bg2 }}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {ft.map(t => {
              const p = getProject(t.pid); const s = getStage(t.sid || ''); const delta = t.hh_real - t.hh_prog
              return <tr key={t.id} style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                <td style={{ padding: '6px 12px', fontSize: 12 }}>{t.name}</td>
                <td style={{ padding: '6px 12px', fontSize: 11, color: COLORS.text2 }}><span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: p?.color || '#888', marginRight: 5 }} />{p?.name || '—'}</td>
                <td style={{ padding: '6px 12px', fontSize: 11, color: COLORS.text2 }}>{s?.name || '—'}</td>
                <td style={{ padding: '6px 12px', fontSize: 11, fontFamily: 'monospace' }}>{t.hh_prog}h</td>
                <td style={{ padding: '6px 12px', fontSize: 11, fontFamily: 'monospace', color: delta > 0 ? COLORS.red : COLORS.green }}>{t.hh_real}h</td>
                <td style={{ padding: '6px 12px', fontSize: 11, fontFamily: 'monospace', color: delta > 0 ? COLORS.red : COLORS.green }}>{delta > 0 ? '+' : ''}{delta}h</td>
                <td style={{ padding: '6px 12px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 60, height: 4, background: COLORS.bg4, borderRadius: 2 }}><div style={{ width: `${t.pct}%`, height: '100%', background: pctColor(t.pct), borderRadius: 2 }} /></div><span style={{ fontSize: 10, fontFamily: 'monospace', color: pctColor(t.pct) }}>{t.pct}%</span></div></td>
              </tr>
            })}
          </tbody>
        </table>
      </div>
    )
  }

  // ── RESUMEN VIEW ─────────────────────────────────────────────────────────────
  function ResumenView() {
    const ft = filteredTasks()
    const done = ft.filter(t => t.status === 'done').length
    const prog = ft.filter(t => t.status === 'prog').length
    const late = ft.filter(t => taskStatus(t) === 'late').length
    const totProg = ft.reduce((a, t) => a + t.hh_prog, 0)
    const totReal = ft.reduce((a, t) => a + t.hh_real, 0)
    const avgPct = ft.length ? Math.round(ft.reduce((a, t) => a + t.pct, 0) / ft.length) : 0
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <StatCard val={ft.length} label="Total tareas" />
          <StatCard val={done} label="Completadas" color={COLORS.green} />
          <StatCard val={prog} label="En curso" color={COLORS.accent} />
          <StatCard val={late} label="Atrasadas" color={COLORS.red} />
          <StatCard val={`${totProg}h`} label="HH Programadas" />
          <StatCard val={`${totReal}h`} label="HH Reales" color={totReal > totProg ? COLORS.red : COLORS.green} />
          <StatCard val={`${avgPct}%`} label="Avance promedio" color={pctColor(avgPct)} />
        </div>
        <div style={{ background: COLORS.bg2, border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${COLORS.border}`, fontSize: 12, fontWeight: 500 }}>Avance por proyecto</div>
          {projects.filter(p => !activeProj || p.id === activeProj).map(p => {
            const pt = projectTasks(p.id); if (!pt.length) return null
            const pct = Math.round(pt.reduce((a, t) => a + t.pct, 0) / pt.length)
            return <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: `1px solid ${COLORS.border}` }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0, display: 'inline-block' }} />
              <span style={{ flex: 1, fontSize: 12 }}>{p.name}</span>
              <div style={{ width: 120, height: 4, background: COLORS.bg4, borderRadius: 2 }}><div style={{ width: `${pct}%`, height: '100%', background: pctColor(pct), borderRadius: 2 }} /></div>
              <span style={{ fontSize: 11, fontFamily: 'monospace', color: pctColor(pct), width: 40, textAlign: 'right' }}>{pct}%</span>
            </div>
          })}
        </div>
      </div>
    )
  }

  // ── CTRL AVANCE VIEW ─────────────────────────────────────────────────────────
  function CtrlView() {
    const todayStr = fmtDate(todayDate())
    const projs = ctrlFilterPid ? projects.filter(p => p.id === ctrlFilterPid) : projects
    const allTasks = ctrlFilterPid ? tasks.filter(t => t.pid === ctrlFilterPid) : tasks
    const lateTasks = allTasks.filter(t => t.status !== 'done' && (t.end_date && t.end_date < todayStr || expectedPct(t) - t.pct > 15)).sort((a, b) => (a.end_date || '9999') < (b.end_date || '9999') ? -1 : 1)

    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: COLORS.text2 }}>PROYECTO</span>
          <select value={ctrlFilterPid || ''} onChange={e => setCtrlFilterPid(e.target.value || null)} style={{ ...inputStyle, width: 220 }}>
            <option value="">Todos los proyectos</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        {lateTasks.length > 0 && (
          <Section title={`⚠ Tareas atrasadas o con avance insuficiente (${lateTasks.length})`} titleColor={COLORS.red}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Tarea', 'Proyecto', 'Etapa', 'Fecha fin', 'Atraso', 'Avance'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>{lateTasks.map(t => {
                const p = getProject(t.pid); const stage = getStage(t.sid || '')
                const delay = t.end_date && t.end_date < todayStr ? daysBetween(parseDate(t.end_date)!, todayDate()) : 0
                return <tr key={t.id}><td style={tdStyle}><span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: p?.color || '#888', marginRight: 5 }} />{t.name}</td><td style={tdStyle}>{p?.name || '—'}</td><td style={tdStyle}>{stage?.name || 'Sin etapa'}</td><td style={{ ...tdStyle, fontFamily: 'monospace' }}>{t.end_date || '—'}</td><td style={tdStyle}>{delay > 0 && <span style={{ background: 'rgba(239,68,68,.15)', color: COLORS.red, fontSize: 10, fontFamily: 'monospace', padding: '1px 5px', borderRadius: 3, border: `1px solid rgba(239,68,68,.3)` }}>+{delay}d</span>}</td><td style={{ ...tdStyle, fontFamily: 'monospace', color: pctColor(t.pct) }}>{t.pct}%</td></tr>
              })}</tbody>
            </table>
          </Section>
        )}

        {projs.map(p => {
          const pt = projectTasks(p.id); if (!pt.length) return null
          const projPct = Math.round(pt.reduce((a, t) => a + t.pct, 0) / pt.length)
          const exp = Math.round(pt.reduce((a, t) => a + expectedPct(t), 0) / pt.length)
          const cum = exp > 0 ? Math.round(projPct / exp * 100) : projPct > 0 ? 100 : 0
          const pStages = projectStages(p.id)
          return (
            <Section key={p.id} title={p.name} titleColor={p.color} rightEl={
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 22, fontWeight: 700, fontFamily: 'monospace', color: pctColor(projPct) }}>{projPct}%</span>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10, fontFamily: 'monospace', color: COLORS.text3 }}>avance real vs esperado a hoy</div>
                  <div style={{ fontSize: 11, fontFamily: 'monospace', color: pctColor(cum) }}>{projPct}% real / {exp}% esperado → <b>{cum}% cumpl.</b></div>
                </div>
              </div>
            }>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Tarea / Etapa', 'Avance real', 'Esperado hoy', 'Cumplimiento', 'Estado', 'Fechas'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                <tbody>
                  {pStages.map(s => {
                    const st = stageTasks(s.id, p.id); if (!st.length) return null
                    const sPct = Math.round(st.reduce((a, t) => a + t.pct, 0) / st.length)
                    const sExp = Math.round(st.reduce((a, t) => a + expectedPct(t), 0) / st.length)
                    const sCum = sExp > 0 ? Math.round(sPct / sExp * 100) : sPct > 0 ? 100 : 0
                    return [
                      <tr key={s.id} style={{ background: COLORS.bg3 }}>
                        <td style={{ ...tdStyle, paddingLeft: 10, fontWeight: 500 }}>{s.name}</td>
                        <td style={tdStyle}><MiniBar pct={sPct} /></td>
                        <td style={{ ...tdStyle, fontFamily: 'monospace', color: COLORS.text3 }}>{sExp}%</td>
                        <td style={{ ...tdStyle, fontFamily: 'monospace', color: pctColor(sCum) }}>{sCum}%</td>
                        <td style={tdStyle} /><td style={tdStyle} />
                      </tr>,
                      ...st.map(t => <CtrlTaskRow key={t.id} t={t} indent={24} />)
                    ]
                  })}
                  {pt.filter(t => !t.sid || !pStages.find(s => s.id === t.sid)).map(t => <CtrlTaskRow key={t.id} t={t} indent={10} />)}
                </tbody>
              </table>
            </Section>
          )
        })}
      </div>
    )
  }

  function CtrlTaskRow({ t, indent }: { t: Task, indent: number }) {
    const ep = expectedPct(t); const behind = ep - t.pct
    const badge = badgeStyle(t)
    return <tr><td style={{ ...tdStyle, paddingLeft: indent, color: COLORS.text2 }}>{t.name}</td>
      <td style={tdStyle}><MiniBar pct={t.pct} /></td>
      <td style={{ ...tdStyle, fontFamily: 'monospace', color: COLORS.text3 }}>{ep}%</td>
      <td style={tdStyle}>{behind > 10 ? <span style={{ background: 'rgba(239,68,68,.15)', color: COLORS.red, fontSize: 10, fontFamily: 'monospace', padding: '1px 5px', borderRadius: 3, border: `1px solid rgba(239,68,68,.3)` }}>-{behind}%</span> : behind > 0 ? <span style={{ fontSize: 10, color: COLORS.amber }}>-{behind}%</span> : <span style={{ fontSize: 10, color: COLORS.green }}>✓</span>}</td>
      <td style={tdStyle}><span style={{ background: badge.bg, color: badge.color, fontSize: 10, fontFamily: 'monospace', padding: '2px 6px', borderRadius: 3 }}>{badge.label}</span></td>
      <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 10, color: COLORS.text3 }}>{t.start_date || '—'} → {t.end_date || '—'}</td>
    </tr>
  }

  // ── ORG VIEW ─────────────────────────────────────────────────────────────────
  function OrgView() {
    if (!activeProj) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: COLORS.text3, fontSize: 13 }}>Selecciona un proyecto para ver el organigrama.</div>
    const pt = projectTasks(activeProj)
    const pStages = projectStages(activeProj)
    const pEdges = orgEdges.filter(e => e.pid === activeProj)
    const pNodes = orgNodes.filter(n => n.pid === activeProj)

    // Group by name
    const nameMap: Record<string, Task[]> = {}
    pt.forEach(t => { if (!nameMap[t.name]) nameMap[t.name] = []; nameMap[t.name].push(t) })
    const groups = Object.entries(nameMap)

    const svgRef = useRef<SVGSVGElement>(null)
    const [positions, setPositions] = useState<Record<string, { x: number, y: number }>>({})

    useEffect(() => {
      const pos: Record<string, { x: number, y: number }> = {}
      groups.forEach(([name, _], gi) => {
        const nk = nodeKey(name)
        const saved = pNodes.find(n => n.node_key === nk)
        pos[nk] = saved ? { x: saved.x, y: saved.y } : { x: 60 + (gi % 4) * 210, y: 60 + Math.floor(gi / 4) * 170 }
      })
      setPositions(pos)
    }, [activeProj, orgNodes.length])

    const drawEdges = () => {
      if (!svgRef.current) return
      svgRef.current.innerHTML = `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="rgba(255,255,255,0.3)"/></marker></defs>`
      pEdges.forEach(e => {
        const fp = positions[e.from_key], tp = positions[e.to_key]
        if (!fp || !tp) return
        const fx = fp.x + 95, fy = fp.y + 80, tx = tp.x + 95, ty = tp.y
        const cy = (fy + ty) / 2
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', `M${fx},${fy} C${fx},${cy} ${tx},${cy} ${tx},${ty}`)
        path.setAttribute('stroke', 'rgba(255,255,255,0.25)')
        path.setAttribute('stroke-width', '2')
        path.setAttribute('fill', 'none')
        path.setAttribute('marker-end', 'url(#arrow)')
        path.style.cursor = 'pointer'
        path.addEventListener('mouseenter', () => path.setAttribute('stroke', COLORS.red))
        path.addEventListener('mouseleave', () => path.setAttribute('stroke', 'rgba(255,255,255,0.25)'))
        path.addEventListener('click', () => orgDeleteEdge(e.id))
        svgRef.current!.appendChild(path)
      })
    }

    useEffect(() => { drawEdges() }, [positions, pEdges])

    const handleDrag = (nk: string, e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX, startY = e.clientY
      const startPos = { ...positions[nk] }
      const onMove = (ev: MouseEvent) => {
        setPositions(prev => ({ ...prev, [nk]: { x: startPos.x + ev.clientX - startX, y: startPos.y + ev.clientY - startY } }))
      }
      const onUp = (ev: MouseEvent) => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        const finalX = startPos.x + ev.clientX - startX, finalY = startPos.y + ev.clientY - startY
        orgSaveNode(activeProj!, nk, finalX, finalY)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }

    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: COLORS.bg2, borderBottom: `1px solid ${COLORS.border}`, fontSize: 11, color: COLORS.text2, flexWrap: 'wrap' }}>
          <span>Arrastra nodos · Click ↗ para conectar · Click en línea para eliminar</span>
          <button style={btnStyle('sm')} onClick={() => { if (activeProj) { setOrgNodes(prev => prev.filter(n => n.pid !== activeProj)); supabase.from('org_nodes').delete().eq('pid', activeProj) } }}>↺ Restablecer</button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', position: 'relative', background: COLORS.bg }}>
          <div style={{ position: 'relative', minWidth: 2000, minHeight: 1500 }}>
            <svg ref={svgRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
            <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
              {pEdges.map(e => {
                const fp = positions[e.from_key], tp = positions[e.to_key]
                if (!fp || !tp) return null
                const fx = fp.x + 95, fy = fp.y + 80, tx = tp.x + 95, ty = tp.y
                const cy = (fy + ty) / 2
                return <path key={e.id} d={`M${fx},${fy} C${fx},${cy} ${tx},${cy} ${tx},${ty}`} stroke="rgba(255,255,255,0.25)" strokeWidth="3" fill="none" markerEnd="url(#arrow)" style={{ cursor: 'pointer' }} onClick={() => orgDeleteEdge(e.id)} onMouseEnter={ev => (ev.target as SVGElement).setAttribute('stroke', COLORS.red)} onMouseLeave={ev => (ev.target as SVGElement).setAttribute('stroke', 'rgba(255,255,255,0.25)')} />
              })}
              <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="rgba(255,255,255,0.3)" /></marker></defs>
            </svg>
            {groups.map(([name, instances]) => {
              const nk = nodeKey(name)
              const pos = positions[nk] || { x: 60, y: 60 }
              const isConnSrc = orgConnecting === nk
              return (
                <div key={nk} onMouseDown={e => { if ((e.target as HTMLElement).closest('button, span[data-check]')) return; if (orgConnecting && orgConnecting !== nk) { orgAddEdge(activeProj!, orgConnecting, nk); setOrgConnecting(null); return }; handleDrag(nk, e) }}
                  style={{ position: 'absolute', left: pos.x, top: pos.y, width: 190, background: COLORS.bg3, border: `1.5px solid ${isConnSrc ? COLORS.green : COLORS.border2}`, borderRadius: 8, cursor: 'grab', userSelect: 'none', boxShadow: isConnSrc ? `0 0 0 2px rgba(62,207,142,0.3)` : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '8px 10px 6px', borderBottom: `1px solid ${COLORS.border}` }}>
                    <span style={{ flex: 1, fontSize: 11, fontWeight: 500, lineHeight: 1.3, wordBreak: 'break-word' }}>{name}</span>
                    <button onClick={e => { e.stopPropagation(); if (orgConnecting === nk) setOrgConnecting(null); else if (orgConnecting) { orgAddEdge(activeProj!, orgConnecting, nk); setOrgConnecting(null) } else setOrgConnecting(nk) }}
                      style={{ width: 18, height: 18, borderRadius: '50%', background: isConnSrc ? COLORS.green : COLORS.bg4, border: `1.5px solid ${isConnSrc ? COLORS.green : COLORS.border2}`, color: isConnSrc ? '#000' : COLORS.text3, fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>↗</button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 7 }}>
                    {pStages.map(s => {
                      const inst = instances.find(t => t.sid === s.id)
                      if (!inst) return null
                      const done = inst.pct >= 100 || inst.status === 'done'
                      const ck = orgChecks.find(c => c.tid === inst.id && c.sid === s.id)
                      const isDone = ck ? ck.done : done
                      const label = s.name.length > 10 ? s.name.slice(0, 9) + '…' : s.name
                      return (
                        <span key={s.id} data-check="1" onClick={e => { e.stopPropagation(); orgToggleCheck(inst.id, s.id) }}
                          style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, fontFamily: 'monospace', color: isDone ? COLORS.green : COLORS.text3, background: isDone ? 'rgba(62,207,142,0.1)' : COLORS.bg4, border: `1px solid ${isDone ? 'rgba(62,207,142,0.25)' : 'transparent'}`, borderRadius: 3, padding: '2px 5px', cursor: 'pointer' }}>
                          <span style={{ width: 12, height: 12, border: `1.5px solid currentColor`, borderRadius: 2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9 }}>{isDone ? '✓' : ''}</span>
                          {label}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  // ── USUARIOS VIEW (admin only) ───────────────────────────────────────────────
  function UsuariosView() {
    const rolColor = (r: Rol | null) => r === 'admin' ? COLORS.red : r === 'editor' ? COLORS.accent : r === 'viewer' ? COLORS.green : COLORS.text3
    const rolLabel = (r: Rol | null) => r === 'admin' ? 'Admin' : r === 'editor' ? 'Editor' : r === 'viewer' ? 'Viewer' : 'Sin rol'

    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 700 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Gestión de usuarios</h2>
          <p style={{ fontSize: 12, color: COLORS.text2, marginBottom: 20 }}>
            Asigna roles a los usuarios registrados. Los cambios tienen efecto inmediato.
          </p>

          {/* Role legend */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
            {[
              { rol: 'admin', desc: 'Acceso total — crea/elimina proyectos, etapas, gestiona usuarios' },
              { rol: 'editor', desc: 'Puede agregar/editar tareas, fechas y % avance' },
              { rol: 'viewer', desc: 'Solo lectura — no puede modificar nada' },
            ].map(({ rol: r, desc }) => (
              <div key={r} style={{ background: COLORS.bg2, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '10px 14px', flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 11, fontFamily: 'monospace', color: rolColor(r as Rol), fontWeight: 600, marginBottom: 4, textTransform: 'uppercase' }}>{r}</div>
                <div style={{ fontSize: 11, color: COLORS.text2 }}>{desc}</div>
              </div>
            ))}
          </div>

          {/* Users table */}
          <div style={{ background: COLORS.bg2, border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Email', 'Rol actual', 'Cambiar rol'].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allUsers.length === 0 && (
                  <tr><td colSpan={3} style={{ ...tdStyle, color: COLORS.text3, textAlign: 'center', padding: 20 }}>
                    No hay usuarios registrados aún
                  </td></tr>
                )}
                {allUsers.map(u => (
                  <tr key={u.user_id} style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: COLORS.bg4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: COLORS.text2, flexShrink: 0 }}>
                          {u.email.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontSize: 12 }}>{u.email}</div>
                          {u.user_id === user?.id && <div style={{ fontSize: 10, color: COLORS.accent, fontFamily: 'monospace' }}>← tú</div>}
                        </div>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ background: u.rol ? `${rolColor(u.rol)}22` : COLORS.bg4, color: rolColor(u.rol), fontSize: 11, fontFamily: 'monospace', padding: '3px 8px', borderRadius: 4, border: `1px solid ${u.rol ? `${rolColor(u.rol)}44` : COLORS.border}` }}>
                        {rolLabel(u.rol)}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {(['admin', 'editor', 'viewer'] as Rol[]).map(r => (
                          <button key={r} onClick={() => setUserRol(u.user_id, u.email, r)}
                            style={{ padding: '3px 10px', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', cursor: 'pointer', border: `1px solid ${u.rol === r ? rolColor(r) : COLORS.border2}`, background: u.rol === r ? `${rolColor(r)}22` : 'transparent', color: u.rol === r ? rolColor(r) : COLORS.text2, fontWeight: u.rol === r ? 600 : 400 }}>
                            {r}
                          </button>
                        ))}
                        {u.rol && u.user_id !== user?.id && (
                          <button onClick={() => setUserRol(u.user_id, u.email, null)}
                            style={{ padding: '3px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', border: `1px solid ${COLORS.border}`, background: 'transparent', color: COLORS.text3 }}>
                            quitar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 11, color: COLORS.text3, marginTop: 12 }}>
            Los usuarios sin rol asignado pueden iniciar sesión pero no pueden ver ni modificar datos.
            Para ver nuevos registros, recarga la página.
          </p>
        </div>
      </div>
    )
  }

  // ── MODALS ───────────────────────────────────────────────────────────────────
  function ModalRoot() {
    if (modal?.type === 'task') return <TaskModal />
    if (modal?.type === 'project') return <ProjectModal />
    if (modal?.type === 'stage') return <StageModal pid={modal.pid} />
    if (modal?.type === 'person') return <PersonModal />
    if (modal?.type === 'dupStage') return <DupStageModal fromSid={modal.fromSid} fromPid={modal.fromPid} />
    return null
  }

  function Overlay({ children }: { children: React.ReactNode }) {
    return <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => e.target === e.currentTarget && setModal(null)}>{children}</div>
  }

  function Modal({ title, children }: { title: string, children: React.ReactNode }) {
    return <div style={{ background: COLORS.bg2, border: `1px solid ${COLORS.border2}`, borderRadius: 12, padding: 24, width: 520, maxHeight: '85vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, color: COLORS.text }}>{title}</h3>
      {children}
    </div>
  }

  function TaskModal() {
    const t = modal?.task as Task | undefined
    const [form, setForm] = useState({ pid: t?.pid || projects[0]?.id || '', sid: t?.sid || '', name: t?.name || '', owner: t?.owner || '', start_date: t?.start_date || '', end_date: t?.end_date || '', real_start: t?.real_start || '', real_end: t?.real_end || '', hh_prog: t?.hh_prog ?? 0, hh_real: t?.hh_real ?? 0, pct: t?.pct ?? 0, status: t?.status || 'todo', deps: t?.deps || [] })
    const stagesForPid = stages.filter(s => s.pid === form.pid).sort((a, b) => a.order - b.order)

    const handleSave = async () => {
      await upsertTask({ ...form, id: t?.id, sid: form.sid || null, real_start: form.real_start || null, real_end: form.real_end || null, start_date: form.start_date || null, end_date: form.end_date || null })
      setModal(null)
    }

    return <Overlay><Modal title={t ? 'Editar tarea' : 'Nueva tarea'}>
      <FormGroup label="Nombre"><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} placeholder="Nombre de la tarea..." /></FormGroup>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <FormGroup label="Proyecto"><select value={form.pid} onChange={e => setForm(f => ({ ...f, pid: e.target.value, sid: '' }))} style={inputStyle}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></FormGroup>
        <FormGroup label="Etapa"><select value={form.sid} onChange={e => setForm(f => ({ ...f, sid: e.target.value }))} style={inputStyle}><option value="">— Sin etapa —</option>{stagesForPid.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></FormGroup>
        <FormGroup label="Responsable"><select value={form.owner} onChange={e => setForm(f => ({ ...f, owner: e.target.value }))} style={inputStyle}><option value="">— Sin asignar —</option>{persons.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}</select></FormGroup>
        <FormGroup label="Estado"><select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as TaskStatus }))} style={inputStyle}><option value="todo">Pendiente</option><option value="prog">En curso</option><option value="done">Completado</option></select></FormGroup>
        <FormGroup label="Inicio programado"><input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} style={inputStyle} /></FormGroup>
        <FormGroup label="Fin programado"><input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} style={inputStyle} /></FormGroup>
        <FormGroup label="Inicio real"><input type="date" value={form.real_start} onChange={e => setForm(f => ({ ...f, real_start: e.target.value }))} style={inputStyle} /></FormGroup>
        <FormGroup label="Fin real"><input type="date" value={form.real_end} onChange={e => setForm(f => ({ ...f, real_end: e.target.value }))} style={inputStyle} /></FormGroup>
        <FormGroup label="HH programadas"><input type="number" value={form.hh_prog} min={0} step={0.5} onChange={e => setForm(f => ({ ...f, hh_prog: +e.target.value }))} style={inputStyle} /></FormGroup>
        <FormGroup label="HH reales"><input type="number" value={form.hh_real} min={0} step={0.5} onChange={e => setForm(f => ({ ...f, hh_real: +e.target.value }))} style={inputStyle} /></FormGroup>
      </div>
      <FormGroup label="% Avance (0–100)"><input type="number" value={form.pct} min={0} max={100} step={5} onChange={e => setForm(f => ({ ...f, pct: Math.min(100, Math.max(0, +e.target.value)) }))} style={inputStyle} /></FormGroup>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        {t && canEdit && <button style={btnStyle('danger')} onClick={async () => { await deleteTask(t.id); setModal(null) }}>Eliminar</button>}
        <button style={btnStyle('sm')} onClick={() => setModal(null)}>Cancelar</button>
        <button style={btnStyle('primary')} onClick={handleSave}>Guardar</button>
      </div>
    </Modal></Overlay>
  }

  function ProjectModal() {
    const [name, setName] = useState('')
    const [color, setColor] = useState('#4f8ef7')
    return <Overlay><Modal title="Nuevo proyecto">
      <FormGroup label="Nombre"><input value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder="Nombre del proyecto..." /></FormGroup>
      <FormGroup label="Color"><input type="color" value={color} onChange={e => setColor(e.target.value)} style={{ ...inputStyle, height: 38, padding: 3 }} /></FormGroup>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button style={btnStyle('sm')} onClick={() => setModal(null)}>Cancelar</button>
        <button style={btnStyle('primary')} onClick={async () => { await upsertProject({ name, color }); setModal(null) }}>Crear</button>
      </div>
    </Modal></Overlay>
  }

  function StageModal({ pid }: { pid: string }) {
    const [name, setName] = useState('')
    const pStages = projectStages(pid)
    const p = getProject(pid)
    return <Overlay><Modal title={`Etapas — ${p?.name || ''}`}>
      <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0 }}>
        {pStages.length === 0 && <div style={{ color: COLORS.text3, fontSize: 12, padding: '8px 0' }}>Sin etapas aún</div>}
        {pStages.map(s => {
          const cnt = stageTasks(s.id, pid).length
          return <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderTop: `1px solid ${COLORS.border}`, gap: 6 }}>
            <span style={{ fontSize: 12, flex: 1 }}>{s.name} <span style={{ color: COLORS.text3, fontSize: 10 }}>({cnt} tareas)</span></span>
            {isAdmin && <button style={btnStyle('sm')} onClick={() => setModal({ type: 'dupStage', fromSid: s.id, fromPid: pid })}>⧉ Copiar</button>}
            {isAdmin && <button style={btnStyle('danger')} onClick={async () => { await deleteStage(s.id); }}>✕</button>}
          </div>
        })}
      </div>
      {isAdmin && <><FormGroup label="Nueva etapa"><input value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder="Nombre de la etapa..." /></FormGroup>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button style={btnStyle('sm')} onClick={() => setModal(null)}>Cerrar</button>
        <button style={btnStyle('primary')} onClick={async () => { if (!name.trim()) return; await upsertStage({ pid, name, order: pStages.length }); setName('') }}>Agregar etapa</button>
      </div></>}
      {!isAdmin && <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button style={btnStyle('sm')} onClick={() => setModal(null)}>Cerrar</button></div>}
    </Modal></Overlay>
  }

  function DupStageModal({ fromSid, fromPid }: { fromSid: string, fromPid: string }) {
    const [target, setTarget] = useState('')
    const fromStage = getStage(fromSid)
    const opts: { sid: string, pid: string, label: string }[] = []
    projects.forEach(proj => projectStages(proj.id).forEach(s => { if (s.id !== fromSid) opts.push({ sid: s.id, pid: proj.id, label: `${proj.name} → ${s.name}` }) }))
    return <Overlay><Modal title={`Copiar tareas de "${fromStage?.name || ''}"`}>
      <div style={{ fontSize: 11, color: COLORS.text3 }}>Las tareas se copian a la etapa destino (fechas reales y % se resetean). No se duplican si ya existen.</div>
      <FormGroup label="Etapa destino">
        <select value={target} onChange={e => setTarget(e.target.value)} style={inputStyle}>
          <option value="">Selecciona etapa...</option>
          {opts.map(o => <option key={o.sid} value={`${o.sid}___${o.pid}`}>{o.label}</option>)}
        </select>
      </FormGroup>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button style={btnStyle('sm')} onClick={() => setModal({ type: 'stage', pid: fromPid })}>Cancelar</button>
        <button style={btnStyle('primary')} onClick={async () => { if (!target) return; const [toSid, toPid] = target.split('___'); await duplicateStage(fromSid, fromPid, toSid, toPid) }}>Copiar tareas</button>
      </div>
    </Modal></Overlay>
  }

  function PersonModal() {
    const [name, setName] = useState('')
    return <Overlay><Modal title="Responsables">
      <div style={{ maxHeight: 160, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0 }}>
        {persons.map(p => <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderTop: `1px solid ${COLORS.border}` }}>
          <span style={{ fontSize: 12 }}>{p.name}</span>
          <button style={btnStyle('danger')} onClick={() => deletePerson(p.id)}>✕</button>
        </div>)}
      </div>
      <FormGroup label="Nuevo responsable"><input value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder="Nombre..." /></FormGroup>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button style={btnStyle('sm')} onClick={() => setModal(null)}>Cerrar</button>
        <button style={btnStyle('primary')} onClick={async () => { if (!name.trim()) return; await upsertPerson(name); setName('') }}>Agregar</button>
      </div>
    </Modal></Overlay>
  }
}

// ── Small Components ──────────────────────────────────────────────────────────
function SidebarItem({ active, onClick, color, label, count, onDelete }: any) {
  const [hover, setHover] = useState(false)
  return <div onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', cursor: 'pointer', background: active ? '#1e2333' : hover ? '#1e2333' : 'transparent', borderLeft: `2px solid ${active ? '#4f8ef7' : 'transparent'}` }}>
    <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
    <span style={{ flex: 1, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#e8eaf0' }}>{label}</span>
    <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#5a6070' }}>{count}</span>
    {onDelete && hover && <button onClick={e => { e.stopPropagation(); onDelete() }} style={{ fontSize: 10, background: 'none', border: 'none', cursor: 'pointer', color: '#5a6070', padding: '0 2px' }}>✕</button>}
  </div>
}

function LegendItem({ color, label }: { color: string, label: string }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
    <div style={{ width: 12, height: 5, borderRadius: 1, background: color }} />
    <span>{label}</span>
  </div>
}

function StatCard({ val, label, color }: { val: any, label: string, color?: string }) {
  return <div style={{ background: '#181c27', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '14px 16px' }}>
    <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'monospace', color: color || '#e8eaf0' }}>{val}</div>
    <div style={{ fontSize: 11, color: '#8b91a8', marginTop: 4 }}>{label}</div>
  </div>
}

function ColHead({ w, children }: { w: number, children: React.ReactNode }) {
  return <div style={{ width: w, flexShrink: 0, fontSize: 10, color: '#5a6070', fontFamily: 'monospace', paddingBottom: 6, overflow: 'hidden', whiteSpace: 'nowrap' }}>{children}</div>
}

function FormGroup({ label, children }: { label: string, children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <label style={{ fontSize: 11, color: '#8b91a8', fontFamily: 'monospace' }}>{label}</label>
    {children}
  </div>
}

function Section({ title, titleColor, rightEl, children }: { title: string, titleColor?: string, rightEl?: React.ReactNode, children: React.ReactNode }) {
  return <div style={{ background: '#181c27', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, overflow: 'hidden' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', background: '#1e2333', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, fontWeight: 500, flex: 1, color: titleColor || '#e8eaf0' }}>{title}</span>
      {rightEl}
    </div>
    {children}
  </div>
}

function MiniBar({ pct }: { pct: number }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    <div style={{ width: 80, height: 6, background: '#252b3b', borderRadius: 3 }}><div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: pct >= 100 ? '#3ecf8e' : pct >= 60 ? '#4f8ef7' : pct >= 30 ? '#f59e0b' : '#ef4444' }} /></div>
    <span style={{ fontFamily: 'monospace', fontSize: 11, color: pct >= 100 ? '#3ecf8e' : pct >= 60 ? '#4f8ef7' : pct >= 30 ? '#f59e0b' : '#ef4444' }}>{pct}%</span>
  </div>
}

// ── Style helpers ─────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  background: '#1e2333', border: '1px solid rgba(255,255,255,0.13)', borderRadius: 6,
  color: '#e8eaf0', fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 13,
  padding: '7px 10px', width: '100%', outline: 'none'
}

function btnStyle(variant: 'primary' | 'sm' | 'danger'): React.CSSProperties {
  const base: React.CSSProperties = { border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500, transition: 'all 0.15s' }
  if (variant === 'primary') return { ...base, background: '#4f8ef7', color: '#fff', padding: '7px 14px', fontSize: 13 }
  if (variant === 'danger') return { ...base, background: 'rgba(239,68,68,0.15)', color: '#ef4444', padding: '4px 8px', fontSize: 11, border: '1px solid rgba(239,68,68,0.3)' }
  return { ...base, background: '#1e2333', color: '#8b91a8', padding: '5px 10px', fontSize: 11, border: '1px solid rgba(255,255,255,0.13)' }
}

const thStyle: React.CSSProperties = { fontSize: 10, fontFamily: 'monospace', color: '#5a6070', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '6px 14px', textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.07)', background: '#181c27' }
const tdStyle: React.CSSProperties = { fontSize: 11, padding: '6px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }
